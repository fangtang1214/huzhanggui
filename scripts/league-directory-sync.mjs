import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const apiBase = "https://api.weixin.qq.com";
const primaryIntervalMinutes = 30;
const secondaryIntervalMinutes = 180;
const tokenRefreshMarginMs = 5 * 60 * 1000;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const safeText = (value) => value === null || value === undefined ? null : String(value).trim() || null;

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

async function getAccessToken(account, force = false) {
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!force && account.accessToken && expiresAt - tokenRefreshMarginMs > Date.now()) return account.accessToken;
  const response = await fetch(`${apiBase}/cgi-bin/token?appid=${encodeURIComponent(account.appid)}&secret=${encodeURIComponent(account.appSecret)}&grant_type=client_credential`, { signal: AbortSignal.timeout(15_000) });
  const payload = await checkedJson(response);
  const token = String(payload.access_token || "");
  if (!token) throw new Error("未获取到微信接口凭证");
  const expiresIn = Number(payload.expires_in) || 7200;
  await sql`UPDATE league_accounts SET access_token=${token},token_expires_at=now()+(${expiresIn} || ' seconds')::interval,updated_at=now() WHERE id=${account.id}`;
  account.accessToken = token;
  account.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return token;
}

async function callLeagueApi(account, path, body) {
  let token = await getAccessToken(account);
  const call = async () => checkedJson(await fetch(`${apiBase}${path}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }));
  try { return await call(); }
  catch (error) {
    if (error?.errcode !== 40001 && error?.errcode !== 42001) throw error;
    token = await getAccessToken(account, true);
    return call();
  }
}

async function fetchDirectory(account) {
  const groups = await Promise.all([0, 1].map(async (commissionType) => {
    const rows = [];
    let nextKey = "";
    const seenKeys = new Set();
    while (true) {
      const payload = await callLeagueApi(account, "/channels/ec/league/headsupplier/cooperativeitem/list/get", {
        commission_type: commissionType,
        page_size: 20,
        next_key: nextKey,
      });
      const list = Array.isArray(payload.list) ? payload.list : [];
      for (const item of list) {
        const productId = safeText(item.product_id);
        const link = safeText(item.head_supplier_item_link);
        if (productId && link) rows.push({ productId, link });
      }
      const next = safeText(payload.next_key);
      if (!next || seenKeys.has(next) || list.length === 0) break;
      seenKeys.add(next);
      nextKey = next;
    }
    return rows;
  }));
  return [...new Map(groups.flat().map((item) => [`${item.productId}\u0000${item.link}`, item])).values()];
}

async function markRunning(accountId) {
  await sql`
    INSERT INTO league_cooperative_cache_state(
      league_account_id,item_count,synced_at,sync_status,sync_started_at,sync_error
    ) VALUES(${accountId},0,'1970-01-01 00:00:00+00','running',now(),null)
    ON CONFLICT(league_account_id) DO UPDATE
    SET sync_status='running',sync_started_at=now(),sync_error=null
  `;
}

async function saveDirectory(accountId, rows) {
  const itemCount = new Set(rows.map((item) => item.productId)).size;
  await sql.begin(async (tx) => {
    await tx`DELETE FROM league_cooperative_item_cache WHERE league_account_id=${accountId}`;
    if (rows.length) await tx`
      INSERT INTO league_cooperative_item_cache(league_account_id,product_id,head_supplier_item_link,synced_at)
      SELECT ${accountId}::uuid,items.product_id,items.link,now()
      FROM unnest(
        ${rows.map((item) => item.productId)}::text[],
        ${rows.map((item) => item.link)}::text[]
      ) AS items(product_id,link)
    `;
    await tx`
      UPDATE league_cooperative_cache_state
      SET item_count=${itemCount},synced_at=now(),sync_error=null,
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
    SET sync_status='failed',sync_error=${String(error instanceof Error ? error.message : error).slice(0, 1000)}
    WHERE league_account_id=${accountId}
  `;
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
      OR (state.sync_status='running' AND state.sync_started_at<now()-interval '2 hours')
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
    try {
      const rows = await fetchDirectory(account);
      await saveDirectory(account.id, rows);
      process.stdout.write(`机构目录同步完成：${account.name}，${new Set(rows.map((item) => item.productId)).size} 件商品\n`);
    } catch (error) {
      await markFailed(account.id, error);
      process.stderr.write(`机构目录同步失败：${account.name}：${error instanceof Error ? error.message : error}\n`);
    }
  }
}

process.stdout.write(`机构目录同步服务已启动：主机构 ${primaryIntervalMinutes} 分钟，其他机构 ${secondaryIntervalMinutes} 分钟\n`);
while (true) {
  try { await processDueAccounts(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); }
  await delay(30_000);
}
