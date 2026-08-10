import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { ensureCsrfCookie, requireSuperAdmin, validateCsrf } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  WECOM_SMART_SHEET_FIELDS,
  WECOM_SMART_SHEET_INTERVAL_MINUTES,
  WECOM_SMART_SHEET_SETTING_KEY,
  WecomSmartSheetError,
  encryptWecomWebhook,
  parseWecomSmartSheetExample,
  validateWecomWebhookUrl,
} from "../../../../scripts/wecom-smartsheet-core.mjs";

export const dynamic = "force-dynamic";

const configSchema = z.object({
  webhookUrl: z.string().trim().min(1, "请粘贴 Webhook 地址").max(2000),
  exampleData: z.string().trim().min(1, "请粘贴示例数据").max(100000),
});

function configError(error: unknown) {
  if (error instanceof WecomSmartSheetError) {
    return Response.json({ ok: false, message: error.message }, { status: 400 });
  }
  return apiError(error);
}

async function status() {
  const sql = getDb();
  const [setting] = await sql`
    SELECT value,updated_at
    FROM app_settings
    WHERE key=${WECOM_SMART_SHEET_SETTING_KEY}
    LIMIT 1
  `;
  const [counts] = await sql`
    SELECT count(*) FILTER (WHERE archived=false)::int AS active_count,
           count(*)::int AS total_count
    FROM products
  `;
  const [state] = await sql`
    SELECT config_id,sync_status,sync_requested_at,sync_started_at,sync_heartbeat_at,
           synced_at,sync_error,total_count,progress_count,added_count,updated_count
    FROM wecom_smartsheet_sync_state
    WHERE singleton=true
  `;
  const configId = setting?.value?.configId ? String(setting.value.configId) : null;
  const [mapped] = configId ? await sql`
    SELECT count(*)::int AS count
    FROM wecom_smartsheet_product_records
    WHERE config_id=${configId}::uuid
  ` : [{ count: 0 }];
  const matchingState = configId && String(state?.configId || "") === configId ? state : null;
  return {
    configured: Boolean(setting?.value?.enabled && setting.value.webhookEncrypted && configId),
    updatedAt: setting?.updatedAt || null,
    activeProductCount: Number(counts?.activeCount || 0),
    totalProductCount: Number(counts?.totalCount || 0),
    mappedProductCount: Number(mapped?.count || 0),
    intervalMinutes: WECOM_SMART_SHEET_INTERVAL_MINUTES,
    fields: WECOM_SMART_SHEET_FIELDS.map((field) => field.title),
    syncStatus: matchingState?.syncStatus || "idle",
    syncRequestedAt: matchingState?.syncRequestedAt || null,
    syncStartedAt: matchingState?.syncStartedAt || null,
    syncedAt: matchingState?.syncedAt || null,
    syncError: matchingState?.syncError || null,
    totalCount: Number(matchingState?.totalCount || 0),
    progressCount: Number(matchingState?.progressCount || 0),
    addedCount: Number(matchingState?.addedCount || 0),
    updatedCount: Number(matchingState?.updatedCount || 0),
  };
}

export async function GET() {
  try {
    await requireSuperAdmin();
    await ensureCsrfCookie();
    return ok(await status());
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request) {
  try {
    await validateCsrf(request);
    const user = await requireSuperAdmin();
    const input = configSchema.parse(await readJson(request));
    const webhookUrl = validateWecomWebhookUrl(input.webhookUrl);
    const fields = parseWecomSmartSheetExample(input.exampleData);
    const sql = getDb();
    const result = await sql.begin(async (tx) => {
      const [state] = await tx`SELECT sync_status FROM wecom_smartsheet_sync_state WHERE singleton=true FOR UPDATE`;
      if (state?.syncStatus === "running") return { conflict: true, configId: null };
      const [current] = await tx`
        SELECT value
        FROM app_settings
        WHERE key=${WECOM_SMART_SHEET_SETTING_KEY}
        FOR UPDATE
      `;
      const sameFields = current?.value?.configId && JSON.stringify(current.value.fields) === JSON.stringify(fields);
      const configId = sameFields ? String(current.value.configId) : randomUUID();
      if (!sameFields) await tx`DELETE FROM wecom_smartsheet_product_records`;
      await tx`
        INSERT INTO app_settings(key,value,updated_at)
        VALUES(${WECOM_SMART_SHEET_SETTING_KEY},${tx.json({
          enabled: true,
          configId,
          webhookEncrypted: encryptWecomWebhook(webhookUrl),
          fields,
          configuredAt: new Date().toISOString(),
        } as never)},now())
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
      `;
      await tx`
        INSERT INTO wecom_smartsheet_sync_state(singleton,config_id,sync_status,sync_requested_at,updated_at)
        VALUES(true,${configId}::uuid,'pending',now(),now())
        ON CONFLICT(singleton) DO UPDATE
        SET config_id=EXCLUDED.config_id,sync_status='pending',sync_requested_at=now(),
            sync_started_at=null,sync_heartbeat_at=null,synced_at=CASE WHEN ${sameFields} THEN wecom_smartsheet_sync_state.synced_at ELSE null END,
            sync_error=null,total_count=0,progress_count=0,added_count=0,updated_count=0,updated_at=now()
      `;
      return { conflict: false, configId };
    });
    if (result.conflict) return Response.json({ ok: false, message: "当前正在同步，请等待完成后再更换配置" }, { status: 409 });
    await writeAudit(user, "wecom_smartsheet.configured", "app_setting", WECOM_SMART_SHEET_SETTING_KEY, "配置企业微信智能表格并开始首次同步", { fields: WECOM_SMART_SHEET_FIELDS.map((field) => field.title) }, requestIp(request));
    return ok(await status());
  } catch (error) {
    return configError(error);
  }
}

export async function POST(request: Request) {
  try {
    await validateCsrf(request);
    const user = await requireSuperAdmin();
    const sql = getDb();
    const [setting] = await sql`
      SELECT value
      FROM app_settings
      WHERE key=${WECOM_SMART_SHEET_SETTING_KEY}
    `;
    if (!setting?.value?.enabled || !setting.value.configId) {
      return Response.json({ ok: false, message: "请先配置智能表格 Webhook" }, { status: 409 });
    }
    await sql`
      UPDATE wecom_smartsheet_sync_state
      SET sync_status=CASE WHEN sync_status='running' THEN 'running' ELSE 'pending' END,
          sync_requested_at=now(),sync_error=null,updated_at=now()
      WHERE singleton=true AND config_id=${setting.value.configId}::uuid
    `;
    await writeAudit(user, "wecom_smartsheet.sync_requested", "app_setting", WECOM_SMART_SHEET_SETTING_KEY, "手动触发企业微信智能表格同步", undefined, requestIp(request));
    return ok(await status());
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await validateCsrf(request);
    const user = await requireSuperAdmin();
    const sql = getDb();
    const result = await sql.begin(async (tx) => {
      const [state] = await tx`SELECT sync_status FROM wecom_smartsheet_sync_state WHERE singleton=true FOR UPDATE`;
      if (state?.syncStatus === "running") return false;
      await tx`DELETE FROM app_settings WHERE key=${WECOM_SMART_SHEET_SETTING_KEY}`;
      await tx`DELETE FROM wecom_smartsheet_product_records`;
      await tx`
        UPDATE wecom_smartsheet_sync_state
        SET config_id=null,sync_status='idle',sync_requested_at=null,sync_started_at=null,
            sync_heartbeat_at=null,synced_at=null,sync_error=null,total_count=0,
            progress_count=0,added_count=0,updated_count=0,updated_at=now()
        WHERE singleton=true
      `;
      return true;
    });
    if (!result) return Response.json({ ok: false, message: "当前正在同步，请等待完成后再停用" }, { status: 409 });
    await writeAudit(user, "wecom_smartsheet.disabled", "app_setting", WECOM_SMART_SHEET_SETTING_KEY, "停用企业微信智能表格同步", undefined, requestIp(request));
    return ok(await status());
  } catch (error) {
    return apiError(error);
  }
}
