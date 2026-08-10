import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const apiBase = "https://api.weixin.qq.com";
const primaryIntervalMinutes = 30;
const secondaryIntervalMinutes = 180;
const tokenRefreshMarginMs = 5 * 60 * 1000;
const requestTimeoutMs = 15_000;
const syncTimeoutMinutes = 20;
const syncTimeoutMs = syncTimeoutMinutes * 60 * 1000;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const safeText = (value) => value === null || value === undefined ? null : String(value).trim() || null;
const requestSignal = (signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs);

function describeLeagueError(errcode, errmsg) {
  const known = {
    40001: "接口凭证无效，请重新获取",
    40013: "AppID 不正确，请检查机构账号配置",
    40125: "AppSecret 不正确，请检查机构账号配置",
    40164: "服务器 IP 不在微信接口白名单中",
  };
  return known[errcode] || `微信接口返回错误（${errcode}）：${errmsg || "未知原因"}`;
}

async function checkedJson(response) {
  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error("微信接口响应格式不正确");
  const errcode = Number(payload.errcode || 0);
  if (errcode !== 0) {
    const error = new Error(describeLeagueError(errcode, String(payload.errmsg || "")));
    error.errcode = errcode;
    throw error;
  }
  return payload;
}

async function getAccessToken(account, force = false, signal) {
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!force && account.accessToken && expiresAt - tokenRefreshMarginMs > Date.now()) return account.accessToken;
  const response = await fetch(`${apiBase}/cgi-bin/token?appid=${encodeURIComponent(account.appid)}&secret=${encodeURIComponent(account.appSecret)}&grant_type=client_credential`, { signal: requestSignal(signal) });
  const payload = await checkedJson(response);
  const token = String(payload.access_token || "");
  if (!token) throw new Error("未获取到微信接口凭证");
  const expiresIn = Number(payload.expires_in) || 7200;
  await sql`UPDATE league_accounts SET access_token=${token},token_expires_at=now()+(${expiresIn} || ' seconds')::interval,updated_at=now() WHERE id=${account.id}`;
  account.accessToken = token;
  account.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return token;
}

async function callLeagueApi(account, path, body, signal) {
  let token = await getAccessToken(account, false, signal);
  const call = async () => checkedJson(await fetch(`${apiBase}${path}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  }));
  try { return await call(); }
  catch (error) {
    if (error?.errcode !== 40001 && error?.errcode !== 42001) throw error;
    token = await getAccessToken(account, true, signal);
    return call();
  }
}

async function updateSyncProgress(accountId, progressCount) {
  await sql`
    UPDATE league_cooperative_cache_state
    SET sync_progress_count=${progressCount},sync_heartbeat_at=now()
    WHERE league_account_id=${accountId} AND sync_status='running'
  `;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

async function fetchInstitutionAssignedLinks(account, cooperativeItemId, signal) {
  const numericId = Number(cooperativeItemId);
  if (!Number.isFinite(numericId) || numericId <= 0) throw new Error("机构合作计划 ID 无效");
  const links = [];
  let nextKey = "";
  const seenKeys = new Set();
  while (true) {
    const payload = await callLeagueApi(account, "/channels/ec/league/headsupplier/subitem/list/get", {
      cooperative_item_id: numericId,
      page_size: 20,
      next_key: nextKey,
    }, signal);
    const list = Array.isArray(payload.list) ? payload.list : [];
    for (const item of list) {
      const link = safeText(item.head_supplier_item_link);
      if (link && (item.status === undefined || Number(item.status) === 1)) links.push(link);
    }
    const next = safeText(payload.next_key);
    if (!next || seenKeys.has(next) || list.length === 0) break;
    seenKeys.add(next);
    nextKey = next;
  }
  return [...new Set(links)];
}

async function fetchDirectory(account, signal) {
  const rows = new Map();
  const productIds = new Set();
  await Promise.all([0, 1].map(async (commissionType) => {
    let nextKey = "";
    const seenKeys = new Set();
    while (true) {
      const payload = await callLeagueApi(account, "/channels/ec/league/headsupplier/cooperativeitem/list/get", {
        commission_type: commissionType,
        page_size: 20,
        next_key: nextKey,
      }, signal);
      const list = Array.isArray(payload.list) ? payload.list : [];
      const pageRows = await mapWithConcurrency(list, 5, async (item) => {
        const productId = safeText(item.product_id);
        const promotionDetailLink = safeText(item.head_supplier_item_link);
        const cooperativeItemId = safeText(item.cooperative_item_id ?? item.id);
        if (!productId || !promotionDetailLink) return [];
        if (commissionType === 0) return [{
          productId,
          link: promotionDetailLink,
          promotionDetailLink,
          linkType: "merchant_assigned",
          cooperativeItemId,
        }];
        if (!cooperativeItemId) return [];
        const subItemLinks = await fetchInstitutionAssignedLinks(account, cooperativeItemId, signal);
        return subItemLinks.map((link) => ({
          productId,
          link,
          promotionDetailLink,
          linkType: "institution_assigned",
          cooperativeItemId,
        }));
      });
      for (const item of pageRows.flat()) {
        rows.set(`${item.productId}\u0000${item.link}`, item);
        productIds.add(item.productId);
      }
      await updateSyncProgress(account.id, productIds.size);
      const next = safeText(payload.next_key);
      if (!next || seenKeys.has(next) || list.length === 0) break;
      seenKeys.add(next);
      nextKey = next;
    }
  }));
  return [...rows.values()];
}

async function markRunning(accountId) {
  await sql`
    INSERT INTO league_cooperative_cache_state(
      league_account_id,item_count,synced_at,sync_status,sync_started_at,sync_error,sync_progress_count,sync_heartbeat_at
    ) VALUES(${accountId},0,'1970-01-01 00:00:00+00','running',now(),null,0,now())
    ON CONFLICT(league_account_id) DO UPDATE
    SET sync_status='running',sync_started_at=now(),sync_error=null,sync_progress_count=0,sync_heartbeat_at=now()
  `;
}

async function saveDirectory(accountId, rows) {
  const itemCount = new Set(rows.map((item) => item.productId)).size;
  await sql.begin(async (tx) => {
    await tx`DELETE FROM league_cooperative_item_cache WHERE league_account_id=${accountId}`;
    if (rows.length) await tx`
      INSERT INTO league_cooperative_item_cache(
        league_account_id,product_id,head_supplier_item_link,promotion_detail_link,
        link_type,cooperative_item_id,synced_at
      )
      SELECT ${accountId}::uuid,items.product_id,items.link,items.promotion_detail_link,
             items.link_type,items.cooperative_item_id,now()
      FROM unnest(
        ${rows.map((item) => item.productId)}::text[],
        ${rows.map((item) => item.link)}::text[],
        ${rows.map((item) => item.promotionDetailLink)}::text[],
        ${rows.map((item) => item.linkType)}::text[],
        ${rows.map((item) => item.cooperativeItemId)}::text[]
      ) AS items(product_id,link,promotion_detail_link,link_type,cooperative_item_id)
    `;
    await tx`
      UPDATE league_cooperative_cache_state
      SET item_count=${itemCount},synced_at=now(),sync_error=null,
          sync_progress_count=${itemCount},sync_heartbeat_at=null,
          sync_status=CASE WHEN sync_requested_at>sync_started_at THEN 'pending' ELSE 'idle' END,
          sync_requested_at=CASE WHEN sync_requested_at>sync_started_at THEN sync_requested_at ELSE null END,
          sync_started_at=null
      WHERE league_account_id=${accountId}
    `;
  });
}

async function markFailed(accountId, error) {
  await sql`
    UPDATE league_cooperative_cache_state
    SET sync_status='failed',sync_error=${String(error instanceof Error ? error.message : error).slice(0, 1000)},sync_heartbeat_at=null
    WHERE league_account_id=${accountId}
  `;
}

async function recoverInterruptedSyncs() {
  const rows = await sql`
    UPDATE league_cooperative_cache_state state
    SET sync_status=CASE WHEN account.active THEN 'pending' ELSE 'idle' END,
        sync_requested_at=CASE WHEN account.active THEN coalesce(state.sync_requested_at,now()) ELSE null END,
        sync_started_at=null,sync_heartbeat_at=null,sync_error=null
    FROM league_accounts account
    WHERE account.id=state.league_account_id AND state.sync_status='running'
    RETURNING state.league_account_id
  `;
  if (rows.length) process.stdout.write(`已重新排队 ${rows.length} 个因服务重启中断的机构目录同步任务\n`);
}

async function nextDueAccount() {
  const rows = await sql`
    SELECT account.id,account.name,account.appid,account.app_secret AS "appSecret",
           account.access_token AS "accessToken",account.token_expires_at AS "tokenExpiresAt",
           account.is_primary AS "isPrimary"
    FROM league_accounts account
    LEFT JOIN league_cooperative_cache_state state ON state.league_account_id=account.id
    WHERE account.active=true AND (
      state.league_account_id IS NULL
      OR state.sync_status='pending'
      OR (state.sync_status='running' AND coalesce(state.sync_heartbeat_at,state.sync_started_at)<now()-interval '5 minutes')
      OR (state.sync_status='failed' AND state.sync_started_at<now()-CASE WHEN account.is_primary THEN interval '30 minutes' ELSE interval '3 hours' END)
      OR (state.sync_status='idle' AND state.synced_at<now()-CASE WHEN account.is_primary THEN interval '30 minutes' ELSE interval '3 hours' END)
    )
    ORDER BY account.is_primary DESC,state.synced_at NULLS FIRST,account.created_at
    LIMIT 1
  `;
  return rows[0] || null;
}

async function processDueAccounts() {
  let account;
  while ((account = await nextDueAccount())) {
    await markRunning(account.id);
    const syncSignal = AbortSignal.timeout(syncTimeoutMs);
    try {
      const rows = await fetchDirectory(account, syncSignal);
      await saveDirectory(account.id, rows);
      process.stdout.write(`机构目录同步完成：${account.name}，${new Set(rows.map((item) => item.productId)).size} 件商品\n`);
    } catch (error) {
      const failure = syncSignal.aborted ? new Error(`目录同步超过 ${syncTimeoutMinutes} 分钟，已停止并等待自动重试`) : error;
      await markFailed(account.id, failure);
      process.stderr.write(`机构目录同步失败：${account.name}：${failure instanceof Error ? failure.message : failure}\n`);
    }
  }
}

while (true) {
  try { await recoverInterruptedSyncs(); break; }
  catch (error) {
    process.stderr.write(`机构目录同步服务等待数据库迁移完成：${error instanceof Error ? error.message : error}\n`);
    await delay(30_000);
  }
}
process.stdout.write(`机构目录同步服务已启动：主机构 ${primaryIntervalMinutes} 分钟，其他机构 ${secondaryIntervalMinutes} 分钟，单次最长 ${syncTimeoutMinutes} 分钟\n`);
while (true) {
  try { await processDueAccounts(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); }
  await delay(30_000);
}
