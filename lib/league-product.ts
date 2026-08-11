import { getDb } from "./db";
import { fetchWindowProductDetail, loadTalentAccount } from "./talent-window";

const API_BASE = "https://api.weixin.qq.com";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const QUALITY_CONCURRENCY = 10;
const LEAGUE_PROMOTION_LINK = /^(weixinstorehs|weixinstoresubhs)\/([A-Za-z0-9_-]+)$/i;

function safeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str || null;
}

export function normalizeLeaguePromotionLink(value: unknown) {
  const text = safeText(value);
  if (!text) return null;
  const match = LEAGUE_PROMOTION_LINK.exec(text);
  return match ? `${match[1].toLowerCase()}/${match[2]}` : null;
}

export function effectiveWindowProductId(productId: unknown, outProductId: unknown) {
  return safeText(outProductId) || safeText(productId) || "";
}

export type LeagueAccountRow = {
  id: string;
  name: string;
  appid: string;
  appSecret: string;
  accessToken: string | null;
  tokenExpiresAt: string | null;
  active: boolean;
  isPrimary?: boolean;
};

export type LeagueProductQuality = {
  shopName: string | null;
  shopScore: number | null;
  shopIcon: string | null;
  goodEvaluationRatio: number | null;
};

export type LeagueProductSnapshot = LeagueProductQuality & {
  title: string | null;
  imageUrls: string[];
  sellingPriceFen: number | null;
  shopAppid: string | null;
};

type LeagueProductDetailItem = {
  product_info?: {
    title?: string;
    head_imgs?: string[];
    selling_price?: number;
    sale_price?: number;
    min_price?: number;
    price_info?: Record<string, unknown>;
    skus?: Array<Record<string, unknown>>;
    sku_list?: Array<Record<string, unknown>>;
    shop_appid?: string;
    good_evaluation_ratio?: number;
  };
  shop?: {
    appid?: string;
    name?: string;
    score?: number;
    icon?: string;
  };
  shop_appid?: string;
  title?: string;
  head_imgs?: string[];
  selling_price?: number;
  skus?: Array<{
    selling_price?: number;
    sale_price?: number;
    min_sale_price?: number;
    market_price?: number;
    price?: number;
  }>;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

const SALE_PRICE_KEYS = [
  "selling_price", "sellingPrice",
  "sale_price", "salePrice",
  "min_sale_price", "minSalePrice",
  "min_price", "minPrice",
  "price",
  "market_price", "marketPrice",
] as const;

function priceFromRecord(record: Record<string, unknown>): number | null {
  for (const key of SALE_PRICE_KEYS) {
    const price = safeNumber(record[key]);
    if (price !== null) return price;
  }
  const priceInfo = object(record.price_info || record.priceInfo || record.price_range || record.priceRange || record.price);
  for (const key of [...SALE_PRICE_KEYS, "min", "value", "amount"] as const) {
    const price = safeNumber(priceInfo[key]);
    if (price !== null) return price;
  }
  return null;
}

function skuSellingPrice(...values: unknown[]): number | null {
  const prices = values
    .flatMap((value) => Array.isArray(value) ? value : [])
    .map((value) => priceFromRecord(object(value)))
    .filter((value): value is number => value !== null);
  return prices.length ? Math.min(...prices) : null;
}

function imageUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return Array.from(new Set(values.map(safeText).filter((item): item is string => Boolean(item))));
}

export function parseLeagueProductSnapshot(value: unknown): LeagueProductSnapshot {
  const detail = object(value);
  const info = object(detail.product_info || detail.productInfo || detail.product || detail.item_info || detail.itemInfo);
  const shop = object(detail.shop || detail.shop_info || detail.shopInfo);
  const sellingPriceFen = priceFromRecord(info) ?? priceFromRecord(detail) ?? skuSellingPrice(
    info.skus, info.sku_list, info.skuList,
    detail.skus, detail.sku_list, detail.skuList,
  );
  const images = imageUrls(
    info.head_imgs || info.headImgs || info.image_urls || info.imageUrls || info.img_urls || info.imgUrls
      || detail.head_imgs || detail.headImgs || detail.image_urls || detail.imageUrls || detail.img_urls || detail.imgUrls
      || info.head_img || info.headImg || info.img_url || info.imgUrl || detail.head_img || detail.headImg || detail.img_url || detail.imgUrl,
  );
  return {
    title: safeText(info.title || info.product_name || info.productName || detail.title || detail.product_name || detail.productName),
    imageUrls: images,
    sellingPriceFen,
    shopAppid: safeText(detail.shop_appid || detail.shopAppid || info.shop_appid || info.shopAppid || shop.appid || shop.app_id || shop.appId),
    shopName: safeText(shop.name || shop.shop_name || shop.shopName || detail.shop_name || detail.shopName),
    shopScore: safeNumber(shop.score ?? shop.shop_score ?? shop.shopScore ?? detail.shop_score ?? detail.shopScore),
    shopIcon: safeText(shop.icon || shop.shop_icon || shop.shopIcon || detail.shop_icon || detail.shopIcon),
    goodEvaluationRatio: safeNumber(info.good_evaluation_ratio ?? info.goodEvaluationRatio ?? detail.good_evaluation_ratio ?? detail.goodEvaluationRatio),
  };
}

export function mergeLeagueProductSnapshots(...snapshots: Array<Partial<LeagueProductSnapshot> | null | undefined>): LeagueProductSnapshot {
  const usable = snapshots.filter(Boolean) as Array<Partial<LeagueProductSnapshot>>;
  const first = <K extends keyof LeagueProductSnapshot>(key: K) => usable.find((item) => item[key] !== null && item[key] !== undefined)?.[key] ?? null;
  return {
    title: first("title") as string | null,
    imageUrls: Array.from(new Set(usable.flatMap((item) => item.imageUrls || []))),
    sellingPriceFen: first("sellingPriceFen") as number | null,
    shopAppid: first("shopAppid") as string | null,
    shopName: first("shopName") as string | null,
    shopScore: first("shopScore") as number | null,
    shopIcon: first("shopIcon") as string | null,
    goodEvaluationRatio: first("goodEvaluationRatio") as number | null,
  };
}

export function parseLeagueProductDetail(payload: { product?: LeagueProductDetailItem; item?: LeagueProductDetailItem }): LeagueProductSnapshot {
  return parseLeagueProductSnapshot(payload.product || payload.item);
}

export function parseLeagueProductQuality(payload: { product?: LeagueProductDetailItem; item?: LeagueProductDetailItem }): LeagueProductQuality {
  const detail = parseLeagueProductDetail(payload);
  return {
    shopName: detail.shopName,
    shopScore: detail.shopScore,
    shopIcon: detail.shopIcon,
    goodEvaluationRatio: detail.goodEvaluationRatio,
  };
}

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
    SELECT id, name, appid, app_secret, access_token, token_expires_at, active, is_primary
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
): Promise<LeagueProductSnapshot> {
  const payload = await callLeagueApi<{ product?: LeagueProductDetailItem; item?: LeagueProductDetailItem }>(
    account,
    "/channels/ec/league/headsupplier/productdetail/get",
    {
      shop_appid: shopAppid,
      product_id: (Number(productId) || 0),
    },
  );
  const detail = parseLeagueProductDetail(payload);
  if (!detail.title && !detail.imageUrls.length && detail.shopName === null && detail.shopScore === null && detail.goodEvaluationRatio === null) {
    throw new Error("联盟商品详情未返回有效商品资料");
  }
  return detail;
}

export type LeagueItemPromotion = {
  headSupplierItemLink: string;
  commissionRatio: number | null;
  normalCommissionRatio: number | null;
  serviceRatio: number | null;
  commissionType: number | null;
  planType: number | null;
  promotionLink: string | null;
  product: LeagueProductSnapshot;
};

export type LeaguePromotionLinkType = "merchant_assigned" | "institution_assigned";

type InstitutionPromotionLink = {
  link: string;
  subItemId: string | null;
  ratio: number | null;
  ratioExt: number | null;
};

export async function fetchLeagueItemPromotion(account: LeagueAccountRow, headSupplierItemLink: string): Promise<LeagueItemPromotion> {
  const payload = await callLeagueApi<{
    item?: {
      head_supplier_item_link?: string;
      product_promotion_link?: string;
      promotion_link?: string;
      commission_info?: {
        plan_type?: number;
        commission_type?: number;
        ratio?: number;
        service_ratio?: number;
        normal_commission_info?: { ratio?: number };
      };
      cooperative_info?: {
        cooperative_status?: number;
        link?: string;
        head_supplier_item_link?: string;
      };
    };
  }>(account, "/channels/ec/league/headsupplier/item/promotiondetail/get", {
    head_supplier_item_link: headSupplierItemLink,
  });
  const info = payload.item?.commission_info;
  // The cooperative-item list is the authoritative source of the institution promotion link.
  // Promotion-detail validates that link and returns commission data; it must never be rebuilt from a product ID.
  const coopLink = safeText(headSupplierItemLink);
  return {
    headSupplierItemLink,
    commissionRatio: typeof info?.ratio === "number" ? info.ratio : null,
    normalCommissionRatio: typeof info?.normal_commission_info?.ratio === "number" ? info.normal_commission_info.ratio : null,
    serviceRatio: typeof info?.service_ratio === "number" ? info.service_ratio : null,
    commissionType: typeof info?.commission_type === "number" ? info.commission_type : null,
    planType: typeof info?.plan_type === "number" ? info.plan_type : null,
    promotionLink: coopLink,
    product: parseLeagueProductSnapshot(payload.item),
  };
}

export async function fetchLeagueInstitutionPromotionLinks(account: LeagueAccountRow, cooperativeItemId: string): Promise<InstitutionPromotionLink[]> {
  const numericId = Number(cooperativeItemId);
  if (!Number.isFinite(numericId) || numericId <= 0) throw new Error("机构合作计划 ID 无效");
  const results: InstitutionPromotionLink[] = [];
  let nextKey = "";
  const seenKeys = new Set<string>();
  while (true) {
    const payload = await callLeagueApi<{
      list?: Array<{
        sub_item_id?: number | string;
        head_supplier_item_link?: string;
        status?: number;
        ratio?: number;
        ratio_ext?: number;
      }>;
      next_key?: string;
    }>(account, "/channels/ec/league/headsupplier/subitem/list/get", {
      cooperative_item_id: numericId,
      page_size: 20,
      next_key: nextKey,
    });
    const list = Array.isArray(payload.list) ? payload.list : [];
    for (const item of list) {
      const link = safeText(item.head_supplier_item_link);
      if (!link || (item.status !== undefined && Number(item.status) !== 1)) continue;
      results.push({
        link,
        subItemId: safeText(item.sub_item_id),
        ratio: typeof item.ratio === "number" ? item.ratio : null,
        ratioExt: typeof item.ratio_ext === "number" ? item.ratio_ext : null,
      });
    }
    const next = safeText(payload.next_key);
    if (!next || seenKeys.has(next) || list.length === 0) break;
    seenKeys.add(next);
    nextKey = next;
  }
  return Array.from(new Map(results.map((item) => [item.link, item])).values());
}

export type CooperativeItem = Partial<LeagueProductSnapshot> & {
  productId: string;
  link: string;
  promotionDetailLink: string;
  linkType: LeaguePromotionLinkType;
  cooperativeItemId: string | null;
};

async function cooperativeItemsFromApiItem(account: LeagueAccountRow, item: Record<string, unknown>, commissionType: number): Promise<CooperativeItem[]> {
  const productId = safeText(item.product_id);
  const promotionDetailLink = safeText(item.head_supplier_item_link);
  if (!productId || !promotionDetailLink) return [];
  const product = parseLeagueProductSnapshot(item);
  const cooperativeItemId = safeText(item.cooperative_item_id ?? item.id);
  if (commissionType === 0) {
    return [{ productId, link: promotionDetailLink, promotionDetailLink, linkType: "merchant_assigned", cooperativeItemId, ...product }];
  }
  if (!cooperativeItemId) return [];
  const subItems = await fetchLeagueInstitutionPromotionLinks(account, cooperativeItemId);
  return subItems.map((subItem) => ({
    productId,
    link: subItem.link,
    promotionDetailLink,
    linkType: "institution_assigned" as const,
    cooperativeItemId,
    ...product,
  }));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

export async function fetchLeagueCooperativeItemLinks(account: LeagueAccountRow): Promise<Map<string, CooperativeItem[]>> {
  await getLeagueAccessToken(account);
  const links = new Map<string, CooperativeItem[]>();
  const add = (key: string | null, item: CooperativeItem) => {
    if (!key) return;
    const current = links.get(key) || [];
    if (!current.some((entry) => entry.link === item.link)) current.push(item);
    links.set(key, current);
  };
  const itemGroups = await Promise.all([0, 1].map(async (commissionType) => {
    const items: CooperativeItem[] = [];
    let nextKey = "";
    const seenKeys = new Set<string>();
    while (true) {
      const payload = await callLeagueApi<{
        list?: Array<Record<string, unknown> & { product_id?: number | string; cooperative_item_id?: number | string; head_supplier_item_link?: string }>;
        next_key?: string;
      }>(account, "/channels/ec/league/headsupplier/cooperativeitem/list/get", {
        commission_type: commissionType,
        page_size: 20,
        next_key: nextKey,
      });
      const list = Array.isArray(payload.list) ? payload.list : [];
      const pageItems = await mapWithConcurrency(list, 5, (item) => cooperativeItemsFromApiItem(account, item, commissionType));
      items.push(...pageItems.flat());
      const next = safeText(payload.next_key);
      if (!next || seenKeys.has(next) || list.length === 0) break;
      seenKeys.add(next);
      nextKey = next;
    }
    return items;
  }));
  for (const item of itemGroups.flat()) add(item.productId, item);
  return links;
}

async function saveLeagueCooperativeItemCache(accountId: string, items: Map<string, CooperativeItem[]>) {
  const sql = getDb();
  const rows = Array.from(items.values()).flat();
  const itemCount = new Set(rows.map((item) => item.productId)).size;
  await sql.begin(async (tx) => {
    await tx`DELETE FROM league_cooperative_item_cache WHERE league_account_id = ${accountId}`;
    if (rows.length) await tx`
      INSERT INTO league_cooperative_item_cache(
        league_account_id, product_id, head_supplier_item_link, promotion_detail_link,
        link_type, cooperative_item_id, synced_at
      )
      SELECT ${accountId}::uuid, cached.product_id, cached.head_supplier_item_link,
             cached.promotion_detail_link, cached.link_type, cached.cooperative_item_id, now()
      FROM unnest(
        ${rows.map((item) => item.productId)}::text[],
        ${rows.map((item) => item.link)}::text[],
        ${rows.map((item) => item.promotionDetailLink)}::text[],
        ${rows.map((item) => item.linkType)}::text[],
        ${rows.map((item) => item.cooperativeItemId)}::text[]
      ) AS cached(product_id, head_supplier_item_link, promotion_detail_link, link_type, cooperative_item_id)
    `;
    await tx`
      INSERT INTO league_cooperative_cache_state(league_account_id, item_count, synced_at, sync_status, sync_error)
      VALUES (${accountId}, ${itemCount}, now(), 'idle', null)
      ON CONFLICT (league_account_id) DO UPDATE
      SET item_count = excluded.item_count, synced_at = excluded.synced_at,
          sync_status = 'idle', sync_error = null
    `;
  });
}

const cooperativeCacheRefreshes = new Map<string, Promise<Map<string, CooperativeItem[]>>>();

export function refreshLeagueCooperativeItemCache(account: LeagueAccountRow): Promise<Map<string, CooperativeItem[]>> {
  const running = cooperativeCacheRefreshes.get(account.id);
  if (running) return running;
  const refresh = (async () => {
    const items = await fetchLeagueCooperativeItemLinks(account);
    await saveLeagueCooperativeItemCache(account.id, items);
    return items;
  })();
  cooperativeCacheRefreshes.set(account.id, refresh);
  refresh.then(
    () => cooperativeCacheRefreshes.delete(account.id),
    () => cooperativeCacheRefreshes.delete(account.id),
  );
  return refresh;
}

async function loadCachedLeagueCooperativeItems(accountId: string, productId: string) {
  const sql = getDb();
  const rows = await sql`
    SELECT product_id, head_supplier_item_link, promotion_detail_link, link_type, cooperative_item_id
    FROM league_cooperative_item_cache
    WHERE league_account_id = ${accountId} AND product_id = ${productId}
    ORDER BY head_supplier_item_link
  `;
  const items = rows.map((row) => ({
    productId: String(row.productId),
    link: String(row.headSupplierItemLink),
    promotionDetailLink: String(row.promotionDetailLink),
    linkType: row.linkType as LeaguePromotionLinkType,
    cooperativeItemId: row.cooperativeItemId ? String(row.cooperativeItemId) : null,
  } satisfies CooperativeItem));
  return items;
}

async function loadCachedLeagueCooperativeItemsByLink(accountId: string, promotionLink: string) {
  const sql = getDb();
  const rows = await sql`
    SELECT product_id, head_supplier_item_link, promotion_detail_link, link_type, cooperative_item_id
    FROM league_cooperative_item_cache
    WHERE league_account_id = ${accountId} AND head_supplier_item_link = ${promotionLink}
    ORDER BY product_id
  `;
  return rows.map((row) => ({
    productId: String(row.productId),
    link: String(row.headSupplierItemLink),
    promotionDetailLink: String(row.promotionDetailLink),
    linkType: row.linkType as LeaguePromotionLinkType,
    cooperativeItemId: row.cooperativeItemId ? String(row.cooperativeItemId) : null,
  } satisfies CooperativeItem));
}

type TargetedCooperativeScanResult = {
  matches: CooperativeItem[];
  limited: boolean;
};

const targetedCooperativeScans = new Map<string, Promise<TargetedCooperativeScanResult>>();

async function fetchLeagueCooperativeProductMatches(account: LeagueAccountRow, productId: string) {
  const key = `${account.id}\u0000${productId}`;
  const running = targetedCooperativeScans.get(key);
  if (running) return running;
  const scan = (async () => {
    if (!(await reservePrimaryProductScan(account.id, productId))) {
      return { matches: [], limited: true } satisfies TargetedCooperativeScanResult;
    }
    const groups = await Promise.all([0, 1].map(async (commissionType) => {
      const matches: CooperativeItem[] = [];
      let nextKey = "";
      const seenKeys = new Set<string>();
      while (true) {
        const payload = await callLeagueApi<{
          list?: Array<Record<string, unknown> & { product_id?: number | string; cooperative_item_id?: number | string; head_supplier_item_link?: string }>;
          next_key?: string;
        }>(account, "/channels/ec/league/headsupplier/cooperativeitem/list/get", {
          commission_type: commissionType,
          page_size: 20,
          next_key: nextKey,
        });
        const list = Array.isArray(payload.list) ? payload.list : [];
        for (const item of list) {
          if (safeText(item.product_id) !== productId) continue;
          matches.push(...await cooperativeItemsFromApiItem(account, item, commissionType));
        }
        if (matches.length) break;
        const next = safeText(payload.next_key);
        if (!next || seenKeys.has(next) || list.length === 0) break;
        seenKeys.add(next);
        nextKey = next;
      }
      return matches;
    }));
    return {
      matches: uniqueCooperativeItems(groups.flat()),
      limited: false,
    } satisfies TargetedCooperativeScanResult;
  })();
  targetedCooperativeScans.set(key, scan);
  scan.then(
    () => targetedCooperativeScans.delete(key),
    () => targetedCooperativeScans.delete(key),
  );
  return scan;
}

async function saveTargetedCooperativeMatches(accountId: string, productId: string, matches: CooperativeItem[]) {
  const sql = getDb();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM league_cooperative_item_cache WHERE league_account_id = ${accountId} AND product_id = ${productId}`;
    if (matches.length) await tx`
      INSERT INTO league_cooperative_item_cache(
        league_account_id, product_id, head_supplier_item_link, promotion_detail_link,
        link_type, cooperative_item_id, synced_at
      )
      SELECT ${accountId}::uuid, ${productId}, links.link, links.promotion_detail_link,
             links.link_type, links.cooperative_item_id, now()
      FROM unnest(
        ${matches.map((item) => item.link)}::text[],
        ${matches.map((item) => item.promotionDetailLink)}::text[],
        ${matches.map((item) => item.linkType)}::text[],
        ${matches.map((item) => item.cooperativeItemId)}::text[]
      ) AS links(link, promotion_detail_link, link_type, cooperative_item_id)
      ON CONFLICT (league_account_id, product_id, head_supplier_item_link)
      DO UPDATE SET promotion_detail_link=excluded.promotion_detail_link,
        link_type=excluded.link_type,cooperative_item_id=excluded.cooperative_item_id,
        synced_at=excluded.synced_at
    `;
    await tx`
      UPDATE league_cooperative_cache_state
      SET item_count = (
        SELECT count(DISTINCT product_id)::int
        FROM league_cooperative_item_cache
        WHERE league_account_id = ${accountId}
      )
      WHERE league_account_id = ${accountId}
    `;
  });
}

async function reservePrimaryProductScan(accountId: string, productId: string) {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO league_product_lookup_throttles(
      league_account_id, product_id, window_started_at, attempt_count, last_attempt_at
    ) VALUES (${accountId}, ${productId}, now(), 1, now())
    ON CONFLICT (league_account_id, product_id) DO UPDATE
    SET attempt_count = CASE
          WHEN league_product_lookup_throttles.window_started_at <= now() - interval '5 minutes' THEN 1
          ELSE league_product_lookup_throttles.attempt_count + 1
        END,
        window_started_at = CASE
          WHEN league_product_lookup_throttles.window_started_at <= now() - interval '5 minutes' THEN now()
          ELSE league_product_lookup_throttles.window_started_at
        END,
        last_attempt_at = now()
    WHERE league_product_lookup_throttles.window_started_at <= now() - interval '5 minutes'
       OR league_product_lookup_throttles.attempt_count < 3
    RETURNING attempt_count
  `;
  return rows.length > 0;
}

export async function loadActiveLeagueAccounts(): Promise<LeagueAccountRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, name, appid, app_secret, access_token, token_expires_at, active, is_primary
    FROM league_accounts
    WHERE active = true
    ORDER BY is_primary DESC, created_at, id
  `;
  return rows as unknown as LeagueAccountRow[];
}

export type LeaguePromotionResolution = {
  promotionLink: string | null;
  commissionRatio: number | null;
  normalCommissionRatio: number | null;
  serviceRatio: number | null;
  commissionType: number | null;
  planType: number | null;
  accountId: string | null;
  linkType?: LeaguePromotionLinkType | null;
  error: string | null;
};

export type LeaguePromotionCandidate = LeaguePromotionResolution & {
  promotionLink: string;
  accountId: string;
  accountName: string;
  accountIsPrimary: boolean;
  headSupplierItemLink: string;
  linkType: LeaguePromotionLinkType;
};

export type LeagueProductLookupCandidate = LeaguePromotionCandidate & LeagueProductSnapshot;

export type LeaguePromotionSelection = {
  selected: LeaguePromotionCandidate | null;
  requiresChoice: boolean;
  candidates: LeaguePromotionCandidate[];
};

function uniqueCooperativeItems(items: CooperativeItem[]) {
  return Array.from(new Map(items.map((item) => [item.link, item])).values());
}

function isInstitutionAssignedLink(candidate: Pick<LeaguePromotionCandidate, "promotionLink"> & { linkType?: LeaguePromotionLinkType | null }) {
  return candidate.linkType === "institution_assigned" || candidate.promotionLink.startsWith("weixinstoresubhs/");
}

export function needsInstitutionPromotionRefresh(candidates: Array<Pick<LeaguePromotionCandidate, "promotionLink"> & { linkType?: LeaguePromotionLinkType | null }>) {
  return !candidates.some(isInstitutionAssignedLink);
}

export function preferredLeaguePromotionCandidates(candidates: LeaguePromotionCandidate[]) {
  const linked = candidates.filter((candidate) => Boolean(candidate.promotionLink));
  if (!linked.length) return [];
  const institutionAssigned = linked.filter(isInstitutionAssignedLink);
  const typePool = institutionAssigned.length ? institutionAssigned : linked;
  const primary = typePool.filter((candidate) => candidate.accountIsPrimary);
  const pool = primary.length ? primary : typePool;
  const highestServiceRatio = Math.max(...pool.map((candidate) => candidate.serviceRatio ?? -1));
  return Array.from(new Map(
    pool
      .filter((candidate) => (candidate.serviceRatio ?? -1) === highestServiceRatio)
      .map((candidate) => [`${candidate.accountId}\u0000${candidate.promotionLink}`, candidate]),
  ).values());
}

export function selectLeaguePromotionCandidate(candidates: LeaguePromotionCandidate[]): LeaguePromotionSelection {
  const linked = candidates.filter((candidate) => Boolean(candidate.promotionLink));
  if (!linked.length) return { selected: null, requiresChoice: false, candidates: [] };
  const unique = preferredLeaguePromotionCandidates(linked);
  return {
    selected: unique.length === 1 ? unique[0] : null,
    requiresChoice: unique.length > 1,
    candidates: linked,
  };
}

async function resolveLeagueLookupMatches(account: LeagueAccountRow, productId: string, matches: CooperativeItem[]) {
  const errors: string[] = [];
  const candidates: LeagueProductLookupCandidate[] = [];
  for (const match of uniqueCooperativeItems(matches)) {
    try {
      const promotion = await fetchLeagueItemPromotion(account, match.promotionDetailLink);
      const preliminary = mergeLeagueProductSnapshots(promotion.product, match);
      let detail: LeagueProductSnapshot | null = null;
      if (preliminary.shopAppid) {
        try { detail = await fetchLeagueProductDetail(account, preliminary.shopAppid, productId); }
        catch (error) { errors.push(`${account.name}：${error instanceof Error ? error.message : "商品详情获取失败"}`); }
      }
      const product = mergeLeagueProductSnapshots(detail, promotion.product, match);
      candidates.push({
        promotionLink: match.link,
        commissionRatio: promotion.commissionRatio,
        normalCommissionRatio: promotion.normalCommissionRatio,
        serviceRatio: promotion.serviceRatio,
        commissionType: promotion.commissionType,
        planType: promotion.planType,
        accountId: account.id,
        accountName: account.name,
        accountIsPrimary: Boolean(account.isPrimary),
        headSupplierItemLink: match.link,
        linkType: match.linkType,
        error: null,
        ...product,
      });
    } catch (error) {
      errors.push(`${account.name}：${error instanceof Error ? error.message : "推广详情接口调用失败"}`);
    }
  }
  return { candidates, errors };
}

async function lookupLeagueAccountProductCandidates(account: LeagueAccountRow, productId: string, allowTargetedScan: boolean) {
  const cached = await loadCachedLeagueCooperativeItems(account.id, productId);
  let matches = cached;
  let refreshed = false;
  let scanLimited = false;
  let refreshError: string | null = null;
  let resolved = await resolveLeagueLookupMatches(account, productId, matches);
  if (allowTargetedScan && needsInstitutionPromotionRefresh(resolved.candidates)) {
    try {
      const scan = await fetchLeagueCooperativeProductMatches(account, productId);
      if (scan.limited) {
        scanLimited = true;
      } else {
        matches = scan.matches;
        await saveTargetedCooperativeMatches(account.id, productId, matches);
        refreshed = true;
        resolved = await resolveLeagueLookupMatches(account, productId, matches);
      }
    } catch (error) {
      refreshError = `${account.name}：${error instanceof Error ? error.message : "合作商品目录扫描失败"}`;
    }
  }
  return {
    candidates: resolved.candidates,
    errors: [...(refreshError ? [refreshError] : []), ...resolved.errors],
    cacheHit: !refreshed && cached.length > 0,
    refreshed,
    scanLimited,
  };
}

export async function lookupLeagueProductCandidates(productId: string): Promise<{
  candidates: LeagueProductLookupCandidate[];
  errors: string[];
  accountCount: number;
  cacheHits: number;
  refreshedAccounts: number;
  scanLimited: boolean;
}> {
  const accounts = await loadActiveLeagueAccounts();
  const primary = accounts.find((account) => account.isPrimary) || null;
  const others = primary ? accounts.filter((account) => account.id !== primary.id) : accounts;
  const primaryResult = primary ? await lookupLeagueAccountProductCandidates(primary, productId, true) : null;
  if (primaryResult?.candidates.some(isInstitutionAssignedLink)) {
    return {
      candidates: primaryResult.candidates,
      errors: primaryResult.errors,
      accountCount: accounts.length,
      cacheHits: primaryResult.cacheHit ? 1 : 0,
      refreshedAccounts: primaryResult.refreshed ? 1 : 0,
      scanLimited: primaryResult.scanLimited,
    };
  }
  const otherResults = await Promise.all(others.map((account) => lookupLeagueAccountProductCandidates(account, productId, true)));
  const results = [...(primaryResult ? [primaryResult] : []), ...otherResults];
  return {
    candidates: results.flatMap((result) => result.candidates),
    errors: results.flatMap((result) => result.errors),
    accountCount: accounts.length,
    cacheHits: results.filter((result) => result.cacheHit).length,
    refreshedAccounts: results.filter((result) => result.refreshed).length,
    scanLimited: results.some((result) => result.scanLimited),
  };
}

export async function lookupLeagueProductCandidatesByPromotionLink(promotionLink: string): Promise<{
  outProductId: string | null;
  candidates: LeagueProductLookupCandidate[];
  errors: string[];
  accountCount: number;
  cacheHits: number;
  refreshedAccounts: number;
  scanLimited: boolean;
  duplicate: boolean;
}> {
  const normalizedLink = normalizeLeaguePromotionLink(promotionLink);
  if (!normalizedLink) throw new Error("推广链接格式不正确");
  const accounts = await loadActiveLeagueAccounts();
  const matchesByAccount = await Promise.all(accounts.map(async (account) => ({
    account,
    matches: await loadCachedLeagueCooperativeItemsByLink(account.id, normalizedLink),
  })));
  const occurrences = matchesByAccount.flatMap(({ account, matches }) => matches.map((match) => ({ account, match })));
  const identities = new Set(occurrences.map(({ account, match }) => `${account.id}\u0000${match.productId}`));
  if (identities.size > 1) {
    return {
      outProductId: null,
      candidates: [],
      errors: ["同一推广链接对应多个机构账号或商品 ID，请先检查机构商品目录"],
      accountCount: accounts.length,
      cacheHits: occurrences.length,
      refreshedAccounts: 0,
      scanLimited: false,
      duplicate: true,
    };
  }
  const occurrence = occurrences[0];
  if (!occurrence) {
    return {
      outProductId: null,
      candidates: [],
      errors: [],
      accountCount: accounts.length,
      cacheHits: 0,
      refreshedAccounts: 0,
      scanLimited: false,
      duplicate: false,
    };
  }
  const matches = occurrences
    .filter(({ account, match }) => account.id === occurrence.account.id && match.productId === occurrence.match.productId)
    .map(({ match }) => match);
  const resolved = await resolveLeagueLookupMatches(occurrence.account, occurrence.match.productId, matches);
  return {
    outProductId: occurrence.match.productId,
    candidates: resolved.candidates,
    errors: resolved.errors,
    accountCount: accounts.length,
    cacheHits: 1,
    refreshedAccounts: 0,
    scanLimited: false,
    duplicate: false,
  };
}

export async function resolveLeaguePromotionCandidates(
  accounts: LeagueAccountRow[],
  item: { productId: string; existingLink?: string | null },
  cooperativeItems?: Map<string, CooperativeItem[]>[],
): Promise<{ candidates: LeaguePromotionCandidate[]; errors: string[] }> {
  const resolved = await Promise.all(accounts.map(async (account, accountIndex) => {
    const errors: string[] = [];
    let cooperative = cooperativeItems?.[accountIndex];
    if (!cooperative) {
      try { cooperative = await refreshLeagueCooperativeItemCache(account); }
      catch (error) {
        return { candidates: [] as LeaguePromotionCandidate[], errors: [`${account.name}：${error instanceof Error ? error.message : "合作商品列表获取失败"}`] };
      }
    }
    const idMatches = cooperative.get(item.productId) || [];
    const linkMatches = idMatches.length || !item.existingLink
      ? []
      : Array.from(cooperative.values()).flat().filter((entry) => entry.link === item.existingLink);
    const matches = uniqueCooperativeItems([...idMatches, ...linkMatches]);
    if (!matches.length) {
      return { candidates: [] as LeaguePromotionCandidate[], errors: [`${account.name}：合作商品列表中未找到商品 ID ${item.productId}`] };
    }
    const candidates: LeaguePromotionCandidate[] = [];
    for (const match of matches) {
      try {
        const promotion = await fetchLeagueItemPromotion(account, match.promotionDetailLink);
        const promotionLink = match.link;
        candidates.push({
          promotionLink,
          commissionRatio: promotion.commissionRatio,
          normalCommissionRatio: promotion.normalCommissionRatio,
          serviceRatio: promotion.serviceRatio,
          commissionType: promotion.commissionType,
          planType: promotion.planType,
          accountId: account.id,
          accountName: account.name,
          accountIsPrimary: Boolean(account.isPrimary),
          headSupplierItemLink: match.link,
          linkType: match.linkType,
          error: null,
        });
      } catch (error) {
        errors.push(`${account.name}：${error instanceof Error ? error.message : "推广详情接口调用失败"}`);
      }
    }
    return { candidates, errors };
  }));
  return {
    candidates: resolved.flatMap((result) => result.candidates),
    errors: resolved.flatMap((result) => result.errors),
  };
}

export async function resolveLeaguePromotion(
  accounts: LeagueAccountRow[],
  item: { productId: string; existingLink?: string | null },
  cooperativeItems?: Map<string, CooperativeItem[]>[],
): Promise<LeaguePromotionResolution> {
  const resolved = await resolveLeaguePromotionCandidates(accounts, item, cooperativeItems);
  const selection = selectLeaguePromotionCandidate(resolved.candidates);
  if (selection.selected) return selection.selected;
  const error = selection.requiresChoice
    ? "多个同优先级推广链接的机构服务费率相同，请人工选择推广链接"
    : resolved.errors[0] || "未找到可用的机构推广商品";
  return { promotionLink: null, commissionRatio: null, normalCommissionRatio: null, serviceRatio: null, commissionType: null, planType: null, accountId: null, error };
}

export async function syncWindowPromotions(talentAccountId: string) {
  const sql = getDb();
  const startedAt = Date.now();
  const accounts = await loadActiveLeagueAccounts();
  const rows = await sql`
    SELECT id, product_id, out_product_id, shop_appid, promotion_link, promotion_confirmed
    FROM talent_window_products
    WHERE account_id = ${talentAccountId}
    ORDER BY synced_at DESC
  `;
  if (!accounts.length) {
    await sql`
      UPDATE talent_window_products
      SET promotion_link = CASE WHEN promotion_confirmed THEN promotion_link ELSE NULL END,
          promotion_status = 'pending', promotion_error = '未配置已启用的联盟机构账号', promotion_synced_at = now()
      WHERE account_id = ${talentAccountId}
    `;
    return { total: rows.length, detailed: 0, accounts: 0 };
  }
  const cooperativeLoads = await Promise.all(accounts.map(async (account) => {
    try {
      return { items: await refreshLeagueCooperativeItemCache(account), error: null };
    } catch (error) {
      return { items: new Map<string, CooperativeItem[]>(), error: `${account.name}：${error instanceof Error ? error.message : "合作商品列表获取失败"}` };
    }
  }));
  const cooperativeItems = cooperativeLoads.map((load) => load.items);
  const cooperativeErrors = cooperativeLoads.map((load) => load.error).filter(Boolean) as string[];
  let detailed = 0;
  const concurrency = 5;
  for (let index = 0; index < rows.length; index += concurrency) {
    const batch = rows.slice(index, index + concurrency);
    const resolutions = await Promise.all(batch.map(async (row) => {
      const effectiveProductId = effectiveWindowProductId(row.productId, row.outProductId);
      const resolved = await resolveLeaguePromotionCandidates(accounts, {
        productId: effectiveProductId,
        existingLink: row.promotionLink ? String(row.promotionLink) : null,
      }, cooperativeItems);
      const selection = selectLeaguePromotionCandidate(resolved.candidates);
      const selectedAccount = selection.selected
        ? accounts.find((account) => account.id === selection.selected?.accountId) || null
        : null;
      const quality = selectedAccount && row.shopAppid
        ? await fetchLeagueProductDetail(selectedAccount, String(row.shopAppid), effectiveProductId).catch((error) => {
            console.warn("最终推广机构的商品详情获取失败", { accountId: selectedAccount.id, productId: effectiveProductId, error });
            return null;
          })
        : null;
      return { resolved: { ...resolved, errors: [...cooperativeErrors, ...resolved.errors] }, selection, quality };
    }));
    for (let offset = 0; offset < batch.length; offset += 1) {
      const row = batch[offset];
      const { resolved, selection, quality } = resolutions[offset];
      const effectiveProductId = effectiveWindowProductId(row.productId, row.outProductId);
      await sql.begin(async (tx) => {
        await tx`DELETE FROM talent_window_promotion_candidates WHERE window_product_id = ${row.id}`;
        const candidateIds = new Map<string, string>();
        for (const candidate of resolved.candidates) {
          const [inserted] = await tx`
            INSERT INTO talent_window_promotion_candidates(
              window_product_id, league_account_id, head_supplier_item_link, promotion_link,
              link_type, commission_ratio, normal_commission_ratio, service_ratio, commission_type, plan_type
            ) VALUES (
              ${row.id}, ${candidate.accountId}, ${candidate.headSupplierItemLink}, ${candidate.promotionLink},
              ${candidate.linkType}, ${candidate.commissionRatio}, ${candidate.normalCommissionRatio}, ${candidate.serviceRatio},
              ${candidate.commissionType}, ${candidate.planType}
            ) RETURNING id
          `;
          candidateIds.set(`${candidate.accountId}\u0000${candidate.promotionLink}`, String(inserted.id));
        }

        const selected = selection.selected;
        const [registered] = await tx`
          SELECT p.id, p.product_url
          FROM product_api_ids pai
          JOIN products p ON p.id = pai.product_id
          WHERE pai.is_current = true
            AND pai.value = ${effectiveProductId}
            AND p.archived = false
          LIMIT 1
        `;
        let registeredLink = safeText(registered?.productUrl);
        let promotionStatus: "pending" | "selected" | "confirmed" | "needs_choice" | "needs_replacement" = "pending";
        let promotionError: string | null = null;
        if (selection.requiresChoice) {
          promotionStatus = "needs_choice";
          promotionError = "多个同优先级推广链接的机构服务费率相同，请人工选择推广链接";
        } else if (selected) {
          if (registeredLink && registeredLink !== selected.promotionLink) {
            if (row.promotionConfirmed) {
              promotionStatus = "needs_replacement";
              promotionError = "已获取新的机构推广链接，等待人工确认是否替换已登记商品链接";
            } else {
              await tx`
                INSERT INTO product_link_history(product_id, url, replaced_by_url, source, source_entity_id)
                VALUES (${registered.id}, ${registeredLink}, ${selected.promotionLink}, 'league_link_correction', ${row.id})
              `;
              await tx`UPDATE products SET product_url = ${selected.promotionLink}, version = version + 1, updated_at = now() WHERE id = ${registered.id}`;
              registeredLink = selected.promotionLink;
              promotionStatus = "selected";
            }
          } else if (registered && !registeredLink) {
            await tx`UPDATE products SET product_url = ${selected.promotionLink}, version = version + 1, updated_at = now() WHERE id = ${registered.id}`;
            registeredLink = selected.promotionLink;
            promotionStatus = "selected";
          } else if (registeredLink === selected.promotionLink) {
            promotionStatus = "confirmed";
          } else {
            promotionStatus = "selected";
          }
        } else {
          promotionError = resolved.errors.slice(0, 3).join("；") || "联盟机构合作商品列表中未找到该商品";
        }
        const preserveConfirmedLink = !selected && Boolean(row.promotionConfirmed) ? safeText(row.promotionLink) : null;
        const selectedCandidateId = selected ? candidateIds.get(`${selected.accountId}\u0000${selected.promotionLink}`) || null : null;
        await tx`
          UPDATE talent_window_products
          SET promotion_link = ${selected?.promotionLink || preserveConfirmedLink},
              promotion_account_id = ${selected?.accountId || null},
              promotion_candidate_id = ${selectedCandidateId},
              promotion_status = ${promotionStatus},
              promotion_confirmed = ${promotionStatus === "confirmed"},
              promotion_error = ${promotionError}, promotion_synced_at = now(),
              shop_name = coalesce(${quality?.shopName || null}, shop_name),
              shop_score = coalesce(${quality?.shopScore ?? null}, shop_score),
              shop_icon = coalesce(${quality?.shopIcon || null}, shop_icon),
              good_evaluation_ratio = coalesce(${quality?.goodEvaluationRatio ?? null}, good_evaluation_ratio),
              commission_ratio = ${selected?.commissionRatio ?? null},
              normal_commission_ratio = ${selected?.normalCommissionRatio ?? null},
              service_ratio = ${selected?.serviceRatio ?? null},
              commission_type = ${selected?.commissionType ?? null},
              plan_type = ${selected?.planType ?? null},
              quality_synced_at = CASE WHEN ${Boolean(quality)} THEN now() ELSE quality_synced_at END
          WHERE id = ${row.id}
        `;
      });
      if (selection.selected) detailed += 1;
    }
  }
  console.log(`橱窗推广数据同步完成：${rows.length} 件，获取到推广链接 ${detailed} 件，联盟账号 ${accounts.length} 个，用时 ${Date.now() - startedAt}ms`);
  return { total: rows.length, detailed, accounts: accounts.length };
}

export async function syncWindowQuality(leagueAccountId: string, talentAccountId: string): Promise<{ total: number; detailed: number; patchedShopIds: number; patchedLinks: number; backfilledLinks: number }> {
  const sql = getDb();
  const leagueAccount = await loadLeagueAccount(leagueAccountId);
  if (!leagueAccount) throw new Error("机构账号不存在");
  if (!leagueAccount.active) throw new Error("机构账号已停用");

  const talentAccount = await loadTalentAccount(talentAccountId);
  if (!talentAccount) throw new Error("带货账号不存在");

  type ProductBrief = { id: string; productId: string; outProductId: string | null; productSource: number; shopAppid: string | null; promotionLink: string | null };
  const rows = await sql`
    SELECT id, product_id, out_product_id, product_source, shop_appid, promotion_link
    FROM talent_window_products
    WHERE account_id = ${talentAccountId} AND promotion_account_id = ${leagueAccountId}
    ORDER BY synced_at DESC
  `;
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
        if (detail.outProductId) product.outProductId = detail.outProductId;
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
  let itemLinks = new Map<string, CooperativeItem[]>();
  try {
    itemLinks = await refreshLeagueCooperativeItemCache(leagueAccount);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "合作商品列表获取失败");
  }

  const linkPatches: Array<{ id: string; link: string }> = [];
  for (const product of products) {
    const effectiveProductId = effectiveWindowProductId(product.productId, product.outProductId);
    const availableLinks = itemLinks.get(effectiveProductId) || [];
    const link = availableLinks.find((item) => item.linkType === "institution_assigned")?.link || availableLinks[0]?.link;
    if (link && !product.promotionLink) {
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
    promotionLink: string | null;
  }> = [];

  for (let index = 0; index < products.length; index += QUALITY_CONCURRENCY) {
    const batch = products.slice(index, index + QUALITY_CONCURRENCY);
    const results = await Promise.all(batch.map(async (item) => {
      const effectiveProductId = effectiveWindowProductId(item.productId, item.outProductId);
      const [qualityResult, promotionResult] = await Promise.allSettled([
        item.shopAppid ? fetchLeagueProductDetail(leagueAccount, item.shopAppid, effectiveProductId) : Promise.resolve(null),
        effectiveProductId ? resolveLeaguePromotion([leagueAccount], {
          productId: effectiveProductId,
          existingLink: item.promotionLink,
        }, [itemLinks]) : Promise.resolve(null),
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
        promotionLink: promotion?.promotionLink ?? null,
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
    const realLinks = qualityRows.map(r => r.promotionLink);

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
          promotion_link = coalesce(t.rl, promotion_link),
          quality_synced_at = now()
      FROM unnest(${qIds}::uuid[], ${shopNames}::text[], ${shopScores}::int[],
                   ${shopIcons}::text[], ${goodRatios}::int[],
                   ${commRatios}::int[], ${normalCommRatios}::int[],
                   ${serviceRatios}::int[], ${commTypes}::int[], ${planTypes}::int[],
                   ${realLinks}::text[])
           AS t(id, sn, ss, si, gr, cr, ncr, sr, ct, pt, rl)
      WHERE wp.id = t.id
    `;
    detailed = qualityRows.length;
  }
  const eligible = products.filter((item) => (item.shopAppid && (item.outProductId || item.productId)) || item.promotionLink).length;
  if (detailed === 0 && eligible > 0 && errors.length) {
    throw new Error(`评分同步失败：${errors[0]}`);
  }
  if (errors.length) console.warn("联盟数据同步部分失败", { leagueAccountId, talentAccountId, errors });
  return { total: products.length, detailed, patchedShopIds, patchedLinks, backfilledLinks: 0 };
}
