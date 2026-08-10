import postgres from "postgres";
import {
  WECOM_SMART_SHEET_BATCH_SIZE,
  WECOM_SMART_SHEET_INTERVAL_MINUTES,
  WECOM_SMART_SHEET_SETTING_KEY,
  addedRecordIds,
  decryptWecomWebhook,
  postWecomSmartSheet,
  productToWecomSmartSheetValues,
  validateWecomWebhookUrl,
  wecomSmartSheetPayloadHash,
} from "./wecom-smartsheet-core.mjs";

if (!process.env.DATABASE_URL) throw new Error("缺少 DATABASE_URL 环境变量");
if (!process.env.SESSION_SECRET) throw new Error("缺少 SESSION_SECRET 环境变量");

const sql = postgres(process.env.DATABASE_URL, { max: 2, transform: postgres.camel, onnotice: () => {} });
const pollIntervalMs = 10_000;
const batchIntervalMs = 2_500;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function message(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 1000);
}

async function recoverInterruptedSync() {
  await sql`
    UPDATE wecom_smartsheet_sync_state
    SET sync_status='pending',sync_started_at=null,sync_heartbeat_at=null,
        sync_error='上次同步因服务重启而中断，已重新排队',updated_at=now()
    WHERE singleton=true AND sync_status='running'
  `;
}

async function takeNextJob() {
  return sql.begin(async (tx) => {
    const [setting] = await tx`
      SELECT value
      FROM app_settings
      WHERE key=${WECOM_SMART_SHEET_SETTING_KEY}
      FOR UPDATE
    `;
    if (!setting?.value?.enabled || !setting.value.webhookEncrypted || !setting.value.configId) return null;
    const [state] = await tx`
      SELECT *
      FROM wecom_smartsheet_sync_state
      WHERE singleton=true
      FOR UPDATE
    `;
    if (!state || String(state.configId || "") !== String(setting.value.configId)) return null;
    const dueAt = state.syncedAt ? new Date(state.syncedAt).getTime() + WECOM_SMART_SHEET_INTERVAL_MINUTES * 60_000 : 0;
    const due = state.syncStatus === "pending" || (state.syncStatus === "idle" && Date.now() >= dueAt);
    if (!due) return null;
    const [claimed] = await tx`
      UPDATE wecom_smartsheet_sync_state
      SET sync_status='running',sync_started_at=now(),sync_heartbeat_at=now(),sync_error=null,
          total_count=0,progress_count=0,added_count=0,updated_count=0,updated_at=now()
      WHERE singleton=true AND config_id=${setting.value.configId}::uuid AND sync_status<>'running'
      RETURNING sync_started_at
    `;
    if (!claimed) return null;
    return { ...setting.value, syncStartedAt: claimed.syncStartedAt };
  });
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function loadProducts(config) {
  return sql`
    SELECT product.id::text AS id,product.sku,product.name,product.price,
           product.product_url AS "productUrl",product.image_urls AS "imageUrls",
           product.updated_at AS "updatedAt",product.archived,
           record.record_id AS "recordId",record.payload_hash AS "payloadHash"
    FROM products product
    LEFT JOIN wecom_smartsheet_product_records record
      ON record.product_id=product.id AND record.config_id=${config.configId}::uuid
    WHERE product.archived=false OR record.product_id IS NOT NULL
    ORDER BY product.created_at,product.id
  `;
}

async function updateProgress(configId, progressCount, addedCount, updatedCount) {
  await sql`
    UPDATE wecom_smartsheet_sync_state
    SET progress_count=${progressCount},added_count=${addedCount},updated_count=${updatedCount},
        sync_heartbeat_at=now(),updated_at=now()
    WHERE singleton=true AND config_id=${configId}::uuid AND sync_status='running'
  `;
}

async function syncJob(config) {
  const webhookUrl = validateWecomWebhookUrl(decryptWecomWebhook(config.webhookEncrypted));
  const products = await loadProducts(config);
  const prepared = products.map((product) => {
    const values = productToWecomSmartSheetValues(config.fields, product);
    return { product, values, hash: wecomSmartSheetPayloadHash(values) };
  });
  const additions = prepared.filter((item) => !item.product.recordId);
  const updates = prepared.filter((item) => item.product.recordId && item.product.payloadHash !== item.hash);
  let progressCount = prepared.length - additions.length - updates.length;
  let addedCount = 0;
  let updatedCount = 0;
  await sql`
    UPDATE wecom_smartsheet_sync_state
    SET total_count=${prepared.length},progress_count=${progressCount},updated_at=now()
    WHERE singleton=true AND config_id=${config.configId}::uuid AND sync_status='running'
  `;

  let lastRequestAt = 0;
  async function send(body) {
    const remaining = batchIntervalMs - (Date.now() - lastRequestAt);
    if (remaining > 0) await delay(remaining);
    const response = await postWecomSmartSheet(webhookUrl, body);
    lastRequestAt = Date.now();
    return response;
  }

  for (const batch of chunks(additions, WECOM_SMART_SHEET_BATCH_SIZE)) {
    const response = await send({ add_records: batch.map((item) => ({ values: item.values })) });
    const recordIds = addedRecordIds(response, batch.length);
    await sql.begin(async (tx) => {
      for (let index = 0; index < batch.length; index += 1) {
        const item = batch[index];
        await tx`
          INSERT INTO wecom_smartsheet_product_records(config_id,product_id,record_id,payload_hash,synced_at)
          VALUES(${config.configId}::uuid,${item.product.id}::uuid,${recordIds[index]},${item.hash},now())
          ON CONFLICT(config_id,product_id) DO UPDATE
          SET record_id=EXCLUDED.record_id,payload_hash=EXCLUDED.payload_hash,synced_at=now()
        `;
      }
    });
    addedCount += batch.length;
    progressCount += batch.length;
    await updateProgress(config.configId, progressCount, addedCount, updatedCount);
  }

  for (const batch of chunks(updates, WECOM_SMART_SHEET_BATCH_SIZE)) {
    await send({ update_records: batch.map((item) => ({ record_id: item.product.recordId, values: item.values })) });
    await sql.begin(async (tx) => {
      for (const item of batch) {
        await tx`
          UPDATE wecom_smartsheet_product_records
          SET payload_hash=${item.hash},synced_at=now()
          WHERE config_id=${config.configId}::uuid AND product_id=${item.product.id}::uuid
        `;
      }
    });
    updatedCount += batch.length;
    progressCount += batch.length;
    await updateProgress(config.configId, progressCount, addedCount, updatedCount);
  }

  const [state] = await sql`
    UPDATE wecom_smartsheet_sync_state
    SET sync_status=CASE WHEN sync_requested_at>sync_started_at THEN 'pending' ELSE 'idle' END,
        sync_requested_at=CASE WHEN sync_requested_at>sync_started_at THEN sync_requested_at ELSE null END,
        sync_started_at=null,sync_heartbeat_at=null,synced_at=now(),sync_error=null,
        total_count=${prepared.length},progress_count=${prepared.length},
        added_count=${addedCount},updated_count=${updatedCount},updated_at=now()
    WHERE singleton=true AND config_id=${config.configId}::uuid
    RETURNING sync_status
  `;
  process.stdout.write(`企业微信智能表格同步完成：共 ${prepared.length} 件，新增 ${addedCount} 件，更新 ${updatedCount} 件${state?.syncStatus === "pending" ? "，另有任务等待执行" : ""}\n`);
}

async function markFailed(config, error) {
  await sql`
    UPDATE wecom_smartsheet_sync_state
    SET sync_status='failed',sync_started_at=null,sync_heartbeat_at=null,
        sync_error=${message(error)},updated_at=now()
    WHERE singleton=true AND config_id=${config.configId}::uuid
  `;
  process.stderr.write(`企业微信智能表格同步失败：${message(error)}\n`);
}

while (true) {
  try { await recoverInterruptedSync(); break; }
  catch (error) {
    process.stderr.write(`企业微信智能表格同步服务等待数据库迁移完成：${message(error)}\n`);
    await delay(30_000);
  }
}

process.stdout.write(`企业微信智能表格同步服务已启动：每 ${WECOM_SMART_SHEET_INTERVAL_MINUTES} 分钟同步一次\n`);
while (true) {
  let job = null;
  try {
    job = await takeNextJob();
    if (job) await syncJob(job);
  } catch (error) {
    if (job) await markFailed(job, error).catch((failure) => process.stderr.write(`${message(failure)}\n`));
    else process.stderr.write(`${message(error)}\n`);
  }
  await delay(pollIntervalMs);
}
