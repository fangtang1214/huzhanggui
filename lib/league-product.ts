import { getDb } from "./db";
import { fetchWindowProductDetail, loadTalentAccount } from "./talent-window";

const API_BASE = "https://api.weixin.qq.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const QUALITY_CONCURRENCY = 10;

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

export type LeagueItemPromotion = {
  commissionRatio: number | null;
  normalCommissionRatio: number | null;
  serviceRatio: number | null;
  commissionType: number | null;
  planType: number | null;
};

export async function fetchLeagueItemPromotion(account: LeagueAccountRow, headSupplierItemLink: string): Promise<LeagueItemPromotion> {
  const payload = await callLeagueApi<{
    item?: {
      commission_info?: {
        plan_type?: number;
        commission_type?: number;
        ratio?: number;
        service_ratio?: number;
        normal_commission_info?: { ratio?: number };
      };
    };
  }>(account, "/channels/ec/league/headsupplier/item/promotiondetail/get", {
    head_supplier_item_link: headSupplierItemLink,
  });
  const info = payload.item?.commission_info;
  return {
    commissionRatio: typeof info?.ratio === "number" ? info.ratio : null,
    normalCommissionRatio: typeof info?.normal_commission_info?.ratio === "number" ? info.normal_commission_info.ratio : null,
    serviceRatio: typeof info?.service_ratio === "number" ? info.service_ratio : null,
    commissionType: typeof info?.commission_type === "number" ? info.commission_type : null,
    planType: typeof info?.plan_type === "number" ? info.plan_type : null,
  };
}

export async function fetchLeagueCooperativeItemLinks(account: LeagueAccountRow): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  for (const commissionType of [0, 1]) {
    let nextKey = "";
    for (let page = 0; page < 500; page += 1) {
      const payload = await callLeagueApi<{
        list?: Array<{ product_id?: number | string; head_supplier_item_link?: string }>;
        next_key?: string;
      }>(account, "/channels/ec/league/headsupplier/cooperativeitem/list/get", {
        commission_type: commissionType,
        page_size: 100,
        next_key: nextKey,
      });
      const list = Array.isArray(payload.list) ? payload.list : [];
      for (const item of list) {
        const productId = safeText(item.product_id);
        const link = safeText(item.head_supplier_item_link);
        if (productId && link) links.set(productId, link);
      }
      const next = safeText(payload.next_key);
      if (!next || next === nextKey || list.length === 0) break;
      nextKey = next;
    }
  }
  return links;
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
  {
    const shopPatchConcurrency = 10;
    const missingShop = products.filter(p => !p.shopAppid);
    const shopPatches: Array<{ id: string; shopAppid: string; outProductId: string | null }> = [];
    for (let index = 0; index < missingShop.length; index += shopPatchConcurrency) {
      const batch = missingShop.slice(index, index + shopPatchConcurrency);
      const results = await Promise.allSettled(batch.map((p) =>
        fetchWindowProductDetail(talentAccount, p.productId).then((detail) => ({ id: p.id, detail, product: p }))
      ));
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const { id, detail, product } = r.value;
        if (!detail.shopAppid) continue;
        shopPatches.push({ id, shopAppid: detail.shopAppid, outProductId: detail.outProductId });
        product.shopAppid = detail.shopAppid;
        if (detail.outProductId && !product.outProductId) product.outProductId = detail.outProductId;
        patchedShopIds += 1;
      }
    }
    if (shopPatches.length > 0) {
      const patchIds = shopPatches.map(s => s.id);
      const patchApps = shopPatches.map(s => s.shopAppid);
      const patchOutIds = shopPatches.map(s => s.outProductId);
      await sql`
        UPDATE talent_window_products wp
        SET shop_appid = t.said, out_product_id = coalesce(t.oid, out_product_id)
        FROM unnest(${patchIds}::uuid[], ${patchApps}::text[], ${patchOutIds}::text[]) AS t(id, said, oid)
        WHERE wp.id = t.id
      `;
    }
  }

  let patchedLinks = 0;
  const errors: string[] = [];
  let itemLinks = new Map<string, string>();
  try {
    itemLinks = await fetchLeagueCooperativeItemLinks(leagueAccount);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "合作商品列表获取失败");
  }

  const linkPatches: Array<{ id: string; link: string }> = [];
  for (const product of products) {
    const sid = product.outProductId || product.productId;
    const link = sid ? itemLinks.get(sid) : undefined;
    if (link && link !== product.promotionLink) {
      linkPatches.push({ id: product.id, link });
      product.promotionLink = link;
      patchedLinks += 1;
    }
  }
  if (linkPatches.length > 0) {
    const lpIds = linkPatches.map(l => l.id);
    const lpLinks = linkPatches.map(l => l.link);
    await sql`
      UPDATE talent_window_products wp
      SET promotion_link = t.link
      FROM unnest(${lpIds}::uuid[], ${lpLinks}::text[]) AS t(id, link)
      WHERE wp.id = t.id
    `;
  }

  let detailed = 0;
  const qualityRows: Array<{
    id: string;
    shopName: string | null; shopScore: number | null; shopIcon: string | null; goodEvaluationRatio: number | null;
    commissionRatio: number | null; normalCommissionRatio: number | null; serviceRatio: number | null;
    commissionType: number | null; planType: number | null;
  }> = [];

  for (let index = 0; index < products.length; index += QUALITY_CONCURRENCY) {
    const batch = products.slice(index, index + QUALITY_CONCURRENCY);
    const results = await Promise.all(batch.map(async (item) => {
      const sid = item.outProductId || item.productId;
      const [qualityResult, promotionResult] = await Promise.allSettled([
        sid && item.shopAppid ? fetchLeagueProductDetail(leagueAccount, item.shopAppid, sid) : Promise.resolve(null),
        item.promotionLink ? fetchLeagueItemPromotion(leagueAccount, item.promotionLink) : Promise.resolve(null),
      ]);
      return { item, qualityResult, promotionResult };
    }));

    for (const { item, qualityResult, promotionResult } of results) {
      for (const result of [qualityResult, promotionResult]) {
        if (result.status === "rejected" && errors.length < 3) errors.push(result.reason instanceof Error ? result.reason.message : "联盟接口调用失败");
      }
      const quality = qualityResult.status === "fulfilled" ? qualityResult.value : null;
      const promotion = promotionResult.status === "fulfilled" ? promotionResult.value : null;
      if (!quality && !promotion) continue;
      qualityRows.push({
        id: item.id,
        shopName: quality?.shopName ?? null,
        shopScore: quality?.shopScore ?? null,
        shopIcon: quality?.shopIcon ?? null,
        goodEvaluationRatio: quality?.goodEvaluationRatio ?? null,
        commissionRatio: promotion?.commissionRatio ?? null,
        normalCommissionRatio: promotion?.normalCommissionRatio ?? null,
        serviceRatio: promotion?.serviceRatio ?? null,
        commissionType: promotion?.commissionType ?? null,
        planType: promotion?.planType ?? null,
      });
    }
  }

  if (qualityRows.length > 0) {
    const qIds = qualityRows.map(r => r.id);
    const shopNames = qualityRows.map(r => r.shopName);
    const shopScores = qualityRows.map(r => r.shopScore);
    const shopIcons = qualityRows.map(r => r.shopIcon);
    const goodRatios = qualityRows.map(r => r.goodEvaluationRatio);
    const commRatios = qualityRows.map(r => r.commissionRatio);
    const normalCommRatios = qualityRows.map(r => r.normalCommissionRatio);
    const serviceRatios = qualityRows.map(r => r.serviceRatio);
    const commTypes = qualityRows.map(r => r.commissionType);
    const planTypes = qualityRows.map(r => r.planType);

    await sql`
      UPDATE talent_window_products wp
      SET shop_name = coalesce(t.sn, shop_name),
          shop_score = coalesce(t.ss, shop_score),
          shop_icon = coalesce(t.si, shop_icon),
          good_evaluation_ratio = coalesce(t.gr, good_evaluation_ratio),
          commission_ratio = coalesce(t.cr, commission_ratio),
          normal_commission_ratio = coalesce(t.ncr, normal_commission_ratio),
          service_ratio = coalesce(t.sr, service_ratio),
          commission_type = coalesce(t.ct, commission_type),
          plan_type = coalesce(t.pt, plan_type),
          quality_synced_at = now()
      FROM unnest(${qIds}::uuid[], ${shopNames}::text[], ${shopScores}::int[],
                   ${shopIcons}::text[], ${goodRatios}::int[],
                   ${commRatios}::int[], ${normalCommRatios}::int[],
                   ${serviceRatios}::int[], ${commTypes}::int[], ${planTypes}::int[])
           AS t(id, sn, ss, si, gr, cr, ncr, sr, ct, pt)
      WHERE wp.id = t.id
    `;
    detailed = qualityRows.length;
  }
  const eligible = products.filter((item) => (item.shopAppid && (item.outProductId || item.productId)) || item.promotionLink).length;
  if (detailed === 0 && eligible > 0 && errors.length) {
    throw new Error(`评分同步失败：${errors[0]}`);
  }
  if (errors.length) console.warn("联盟数据同步部分失败", { leagueAccountId, talentAccountId, errors });
  return { total: products.length, detailed, patchedShopIds, patchedLinks };
}
