import { getDb } from "./db";

const API_BASE = "https://api.weixin.qq.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DETAIL_CONCURRENCY = 10;

function safeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

export type TalentAccountRow = {
  id: string;
  name: string;
  appid: string;
  appSecret: string;
  accessToken: string | null;
  tokenExpiresAt: string | null;
  active: boolean;
  syncStatus: "idle" | "syncing" | "failed";
  syncError: string | null;
  syncedAt: string | null;
};

export type WindowListItem = {
  productId: string;
  shopAppid: string | null;
  outProductId: string | null;
  productSource: number;
};

export type WindowProductDetail = {
  productId: string;
  shopAppid: string | null;
  outProductId: string | null;
  title: string;
  imgUrl: string;
  sellingPriceFen: number | null;
  stock: number | null;
  sales: number | null;
  status: number | null;
  isHide: boolean | null;
};

export class TalentApiError extends Error {
  constructor(public errcode: number, message: string) {
    super(describeTalentError(errcode, message));
  }
}

function describeTalentError(errcode: number, errmsg: string) {
  const known: Record<number, string> = {
    40001: "接口凭证无效，请重新获取",
    40013: "AppID 不正确，请检查带货账号配置",
    40125: "AppSecret 不正确，请检查带货账号配置",
    40164: "服务器 IP 不在微信接口白名单中，请在微信开发者平台添加服务器公网 IP",
    40243: "AppSecret 已被冻结，请在微信开发者平台解冻",
    10200006: "达人平台账号异常，请登录微信小店带货助手后台确认账号状态",
    10200007: "商品未在达人橱窗中",
    10200008: "商品状态异常，请在带货助手后台确认",
  };
  return known[errcode] || `微信接口返回错误（${errcode}）：${errmsg || "未知原因"}`;
}

function errcodeOf(payload: Record<string, unknown>): number {
  const code = Number(payload.errcode ?? 0);
  return Number.isFinite(code) ? code : -1;
}

async function wechatGet(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const payload = await response.json().catch(() => null);
  if (!payload) throw new TalentApiError(-1, "网络响应格式不正确");
  const errcode = errcodeOf(payload);
  if (errcode !== 0) throw new TalentApiError(errcode, String(payload.errmsg || ""));
  return payload;
}

async function wechatPost(path: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`${API_BASE}${path}?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!payload) throw new TalentApiError(-1, "网络响应格式不正确");
  const errcode = errcodeOf(payload);
  if (errcode !== 0) throw new TalentApiError(errcode, String(payload.errmsg || ""));
  return payload;
}

export async function loadTalentAccount(accountId: string): Promise<TalentAccountRow | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, name, appid, app_secret, access_token, token_expires_at, active, sync_status, sync_error, synced_at
    FROM talent_accounts WHERE id = ${accountId} LIMIT 1
  `;
  return (rows[0] as TalentAccountRow | undefined) || null;
}

export async function getTalentAccessToken(account: TalentAccountRow, forceRefresh = false): Promise<string> {
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!forceRefresh && account.accessToken && expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return account.accessToken;
  }
  const url = `${API_BASE}/cgi-bin/token?appid=${encodeURIComponent(account.appid)}&secret=${encodeURIComponent(account.appSecret)}&grant_type=client_credential`;
  const payload = await wechatGet(url);
  const token = String(payload.access_token || "");
  if (!token) throw new TalentApiError(-1, "未获取到接口凭证");
  const expiresIn = Number(payload.expires_in) || 7200;
  const sql = getDb();
  await sql`
    UPDATE talent_accounts
    SET access_token = ${token}, token_expires_at = now() + (${expiresIn} || ' seconds')::interval, updated_at = now()
    WHERE id = ${account.id}
  `;
  account.accessToken = token;
  account.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return token;
}

async function callWindowApi<T>(account: TalentAccountRow, path: string, body: Record<string, unknown>): Promise<T> {
  let token = await getTalentAccessToken(account);
  try {
    return (await wechatPost(path, token, body)) as T;
  } catch (error) {
    if (error instanceof TalentApiError && (error.errcode === 40001 || error.errcode === 42001)) {
      token = await getTalentAccessToken(account, true);
      return (await wechatPost(path, token, body)) as T;
    }
    throw error;
  }
}

export async function fetchWindowProductList(account: TalentAccountRow): Promise<WindowListItem[]> {
  const items: WindowListItem[] = [];
  let lastBuffer = "";
  for (let round = 0; round < 200; round += 1) {
    const body: Record<string, unknown> = { page_size: 500 };
    if (lastBuffer) body.last_buffer = lastBuffer;
    const payload = await callWindowApi<{
      products?: Array<{ product_id?: string | number; appid?: string; out_product_id?: string; product_source?: number }>;
      last_buffer?: string;
    }>(account, "/channels/ec/talent/window/product/list/get", body);
    const products = Array.isArray(payload.products) ? payload.products : [];
    for (const item of products) {
      if (item.product_id === undefined || item.product_id === null) continue;
      items.push({
        productId: safeText(item.product_id) || "",
        shopAppid: safeText(item.appid),
        outProductId: safeText(item.out_product_id),
        productSource: Number(item.product_source) || 0,
      });
    }
    if (!payload.last_buffer || products.length === 0 || payload.last_buffer === lastBuffer) break;
    lastBuffer = payload.last_buffer;
  }
  return items;
}

export async function fetchWindowProductDetail(account: TalentAccountRow, productId: string): Promise<WindowProductDetail> {
  const payload = await callWindowApi<{
    product?: {
      product_id?: string | number;
      appid?: string;
      out_product_id?: string;
      title?: string;
      img_url?: string;
      selling_price?: number;
      stock?: number;
      sales?: number;
      status?: number;
      is_hide?: boolean;
    };
  }>(account, "/channels/ec/talent/window/product/get", { product_id: productId });
  const product = payload.product || {};
  return {
    productId: String(product.product_id ?? productId),
    shopAppid: safeText(product.appid),
    outProductId: safeText(product.out_product_id),
    title: product.title || "",
    imgUrl: product.img_url || "",
    sellingPriceFen: typeof product.selling_price === "number" ? product.selling_price : null,
    stock: typeof product.stock === "number" ? product.stock : null,
    sales: typeof product.sales === "number" ? product.sales : null,
    status: typeof product.status === "number" ? product.status : null,
    isHide: typeof product.is_hide === "boolean" ? product.is_hide : null,
  };
}

export async function syncTalentWindow(accountId: string): Promise<{ total: number; detailed: number }> {
  const sql = getDb();
  const account = await loadTalentAccount(accountId);
  if (!account) throw new Error("带货账号不存在");
  if (!account.active) throw new Error("带货账号已停用");

  const items = await fetchWindowProductList(account);
  const keepIds = items.map((item) => item.productId);

  if (items.length > 0) {
    const productIds = items.map(i => i.productId);
    const outProductIds = items.map(i => i.outProductId);
    const shopAppids = items.map(i => i.shopAppid);
    const productSources = items.map(i => i.productSource);

    await sql`
      INSERT INTO talent_window_products (account_id, product_id, out_product_id, shop_appid, product_source, synced_at)
      SELECT ${accountId}, t.pid, t.oid, t.said, t.ps, now()
      FROM unnest(${productIds}::text[], ${outProductIds}::text[], ${shopAppids}::text[], ${productSources}::int[]) AS t(pid, oid, said, ps)
      ON CONFLICT (account_id, product_id) DO UPDATE
      SET out_product_id = EXCLUDED.out_product_id, shop_appid = EXCLUDED.shop_appid,
          product_source = EXCLUDED.product_source, synced_at = now()
    `;
  }

  if (keepIds.length) {
    await sql`DELETE FROM talent_window_products WHERE account_id = ${accountId} AND product_id <> ALL (${keepIds})`;
  } else {
    await sql`DELETE FROM talent_window_products WHERE account_id = ${accountId}`;
  }

  const detailRows: Array<{ productId: string; detail: WindowProductDetail }> = [];
  for (let index = 0; index < items.length; index += DETAIL_CONCURRENCY) {
    const batch = items.slice(index, index + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((item) => fetchWindowProductDetail(account, item.productId)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      const result = results[offset];
      if (result.status !== "fulfilled") continue;
      detailRows.push({ productId: batch[offset].productId, detail: result.value });
    }
  }

  if (detailRows.length > 0) {
    const uProductIds = detailRows.map(r => r.productId);
    const titles = detailRows.map(r => r.detail.title);
    const imgUrls = detailRows.map(r => r.detail.imgUrl);
    const spfs = detailRows.map(r => r.detail.sellingPriceFen);
    const stocks = detailRows.map(r => r.detail.stock);
    const sales = detailRows.map(r => r.detail.sales);
    const statuses = detailRows.map(r => r.detail.status);
    const isHides = detailRows.map(r => r.detail.isHide === true ? 1 : r.detail.isHide === false ? 0 : null);
    const outProdIds = detailRows.map(r => r.detail.outProductId);
    const shopApps = detailRows.map(r => r.detail.shopAppid);

    await sql`
      UPDATE talent_window_products wp
      SET title = t.title, img_url = t.img_url, selling_price_fen = t.spf,
          stock = t.stock, sales = t.sales, status = t.status, is_hide = (t.is_hide = 1),
          out_product_id = coalesce(t.oid, out_product_id),
          shop_appid = coalesce(t.said, shop_appid),
          synced_at = now()
      FROM unnest(${uProductIds}::text[], ${titles}::text[], ${imgUrls}::text[],
                   ${spfs}::int[], ${stocks}::int[], ${sales}::int[],
                   ${statuses}::int[], ${isHides}::int[],
                   ${outProdIds}::text[], ${shopApps}::text[]) AS t(id, title, img_url, spf, stock, sales, status, is_hide, oid, said)
      WHERE wp.account_id = ${accountId} AND wp.product_id = t.id
    `;
  }

  return { total: items.length, detailed: detailRows.length };
}

export async function runTalentWindowSync(accountId: string) {
  const sql = getDb();
  try {
    const result = await syncTalentWindow(accountId);
    const { syncWindowPromotions } = await import("./league-product");
    const promotionResult = await syncWindowPromotions(accountId);
    await sql`
      UPDATE talent_accounts
      SET sync_status = 'idle', sync_error = null, synced_at = now(), updated_at = now()
      WHERE id = ${accountId}
    `;
    return { ...result, promotion: promotionResult };
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步失败";
    await sql`
      UPDATE talent_accounts
      SET sync_status = 'failed', sync_error = ${message}, updated_at = now()
      WHERE id = ${accountId}
    `;
    throw error;
  }
}
