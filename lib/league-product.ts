import { getDb } from "./db";
import { fetchWindowProductDetail, loadTalentAccount } from "./talent-window";

const API_BASE = "https://api.weixin.qq.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const QUALITY_CONCURRENCY = 5;

function safeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

export type LeagueAccountRow = {
  id: string;
  name: string;
  appid: string;
  appSecret: string;
  accessToken: string | null;
  tokenExpiresAt: string | null;
  active: boolean;
};

export type LeagueProductQuality = {
  shopName: string | null;
  shopScore: number | null;
  shopIcon: string | null;
  goodEvaluationRatio: number | null;
};

export class LeagueApiError extends Error {
  constructor(public errcode: number, message: string) {
    super(describeLeagueError(errcode, message));
  }
}

function describeLeagueError(errcode: number, errmsg: string) {
  const known: Record<number, string> = {
    40001: "接口凭证无效，请重新获取",
    40013: "AppID 不正确，请检查机构账号配置",
    40125: "AppSecret 不正确，请检查机构账号配置",
    40164: "服务器 IP 不在微信接口白名单中",
    10024000: "参数错误，请确认 shop_appid 和 product_id 正确",
    10024003: "不合法的 AppID",
    10024004: "不存在该商品",
    10024025: "商品计划不在上架中",
    10024043: "商品不属于该店铺",
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
  if (!payload) throw new LeagueApiError(-1, "网络响应格式不正确");
  const errcode = errcodeOf(payload);
  if (errcode !== 0) throw new LeagueApiError(errcode, String(payload.errmsg || ""));
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
  if (!payload) throw new LeagueApiError(-1, "网络响应格式不正确");
  const errcode = errcodeOf(payload);
  if (errcode !== 0) throw new LeagueApiError(errcode, String(payload.errmsg || ""));
  return payload;
}

export async function loadLeagueAccount(accountId: string): Promise<LeagueAccountRow | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, name, appid, app_secret, access_token, token_expires_at, active
    FROM league_accounts WHERE id = ${accountId} LIMIT 1
  `;
  return (rows[0] as LeagueAccountRow | undefined) || null;
}

export async function getLeagueAccessToken(account: LeagueAccountRow, forceRefresh = false): Promise<string> {
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!forceRefresh && account.accessToken && expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
    return account.accessToken;
  }
  const url = `${API_BASE}/cgi-bin/token?appid=${encodeURIComponent(account.appid)}&secret=${encodeURIComponent(account.appSecret)}&grant_type=client_credential`;
  const payload = await wechatGet(url);
  const token = String(payload.access_token || "");
  if (!token) throw new LeagueApiError(-1, "未获取到接口凭证");
  const expiresIn = Number(payload.expires_in) || 7200;
  const sql = getDb();
  await sql`
    UPDATE league_accounts
    SET access_token = ${token}, token_expires_at = now() + (${expiresIn} || ' seconds')::interval, updated_at = now()
    WHERE id = ${account.id}
  `;
  account.accessToken = token;
  account.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  return token;
}

async function callLeagueApi<T>(account: LeagueAccountRow, path: string, body: Record<string, unknown>): Promise<T> {
  let token = await getLeagueAccessToken(account);
  try {
    return (await wechatPost(path, token, body)) as T;
  } catch (error) {
    if (error instanceof LeagueApiError && (error.errcode === 40001 || error.errcode === 42001)) {
      token = await getLeagueAccessToken(account, true);
      return (await wechatPost(path, token, body)) as T;
    }
    throw error;
  }
}

export async function fetchLeagueProductDetail(
  account: LeagueAccountRow,
  shopAppid: string,
  productId: string,
): Promise<LeagueProductQuality> {
  type DetailItem = {
    product_info?: {
      title?: string;
      head_imgs?: string[];
      good_evaluation_ratio?: number;
    };
    shop?: {
      name?: string;
      score?: number;
      icon?: string;
    };
  };
  const payload = await callLeagueApi<{ item?: DetailItem; product?: DetailItem }>(
    account,
    "/channels/ec/league/headsupplier/productdetail/get",
    {
      shop_appid: shopAppid,
      product_id: (Number(productId) || 0),
    },
  );
  const detail = payload.item || payload.product;
  const info = detail?.product_info;
  const shop = detail?.shop;
  return {
    shopName: shop?.name || null,
    shopScore: typeof shop?.score === "number" ? shop.score : null,
    shopIcon: shop?.icon || null,
    goodEvaluationRatio: typeof info?.good_evaluation_ratio === "number" ? info.good_evaluation_ratio : null,
  };
}

export async function fetchLeaguePromotionLink(account: LeagueAccountRow, headSupplierItemLink: string): Promise<string | null> {
  const payload = await callLeagueApi<{
    item?: { cooperative_info?: { link?: string } };
  }>(account, "/channels/ec/league/headsupplier/item/promotiondetail/get", {
    head_supplier_item_link: headSupplierItemLink,
  });
  return safeText(payload.item?.cooperative_info?.link);
}

export async function syncWindowQuality(leagueAccountId: string, talentAccountId: string): Promise<{ total: number; detailed: number; patchedShopIds: number; patchedLinks: number }> {
  const sql = getDb();
  const leagueAccount = await loadLeagueAccount(leagueAccountId);
  if (!leagueAccount) throw new Error("机构账号不存在");
  if (!leagueAccount.active) throw new Error("机构账号已停用");

  const talentAccount = await loadTalentAccount(talentAccountId);
  if (!talentAccount) throw new Error("带货账号不存在");

  type ProductBrief = { id: string; productId: string; outProductId: string | null; productSource: number; shopAppid: string | null; promotionLink: string | null };
  const rows = await sql`SELECT id, product_id, out_product_id, product_source, shop_appid, promotion_link FROM talent_window_products WHERE account_id = ${talentAccountId} ORDER BY synced_at DESC`;
  const products: ProductBrief[] = rows as unknown as ProductBrief[];

  let patchedShopIds = 0;
  for (const product of products) {
    if (product.shopAppid) continue;
    try {
      const detail = await fetchWindowProductDetail(talentAccount, product.productId);
      if (detail.shopAppid) {
        await sql`UPDATE talent_window_products SET shop_appid = ${detail.shopAppid}, out_product_id = coalesce(${detail.outProductId || null}, out_product_id), promotion_link = coalesce(${detail.promotionLink || null}, promotion_link) WHERE id = ${product.id}`;
        product.shopAppid = detail.shopAppid;
        if (detail.outProductId && !product.outProductId) product.outProductId = detail.outProductId;
        if (detail.promotionLink && !product.promotionLink) product.promotionLink = detail.promotionLink;
        patchedShopIds += 1;
      }
    } catch { /* skip individual detail failure */ }
  }

  let patchedLinks = 0;
  const errors: string[] = [];
  for (const product of products) {
    if (product.promotionLink) continue;
    const sid = product.outProductId || product.productId;
    if (!sid) continue;
    try {
      const link = await fetchLeaguePromotionLink(leagueAccount, `weixinstorehs/${sid}`);
      if (link) {
        await sql`UPDATE talent_window_products SET promotion_link = ${link} WHERE id = ${product.id}`;
        product.promotionLink = link;
        patchedLinks += 1;
      }
    } catch (error) {
      if (errors.length < 3) errors.push(error instanceof Error ? error.message : "推广链接获取失败");
    }
  }

  let detailed = 0;
  for (let index = 0; index < products.length; index += QUALITY_CONCURRENCY) {
    const batch = products.slice(index, index + QUALITY_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((item) => {
      const sid = item.outProductId || item.productId;
      if (!sid || !item.shopAppid) return Promise.resolve(null);
      return fetchLeagueProductDetail(leagueAccount, item.shopAppid, sid);
    }));

    for (let offset = 0; offset < batch.length; offset += 1) {
      const result = results[offset];
      if (result.status !== "fulfilled") {
        if (result.status === "rejected" && errors.length < 3) errors.push(result.reason instanceof Error ? result.reason.message : "评分接口调用失败");
        continue;
      }
      if (!result.value) continue;
      const quality = result.value;
      await sql`
        UPDATE talent_window_products
        SET shop_name = coalesce(${quality.shopName}, shop_name),
            shop_score = coalesce(${quality.shopScore}, shop_score),
            shop_icon = coalesce(${quality.shopIcon}, shop_icon),
            good_evaluation_ratio = coalesce(${quality.goodEvaluationRatio}, good_evaluation_ratio),
            quality_synced_at = now()
        WHERE id = ${batch[offset].id}
      `;
      detailed += 1;
    }
  }
  const eligible = products.filter((item) => item.shopAppid && (item.outProductId || item.productId)).length;
  if (detailed === 0 && eligible > 0 && errors.length) {
    throw new Error(`评分同步失败：${errors[0]}`);
  }
  if (errors.length) console.warn("联盟数据同步部分失败", { leagueAccountId, talentAccountId, errors });
  return { total: products.length, detailed, patchedShopIds, patchedLinks };
}
