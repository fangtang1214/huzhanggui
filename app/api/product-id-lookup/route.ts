import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import {
  lookupLeagueProductCandidates,
  lookupLeagueProductCandidatesByPromotionLink,
  mergeLeagueProductSnapshots,
  normalizeLeaguePromotionLink,
  preferredLeaguePromotionCandidates,
  type LeagueProductLookupCandidate,
  type LeagueProductSnapshot,
} from "@/lib/league-product";

const lookupValueSchema = z.string().trim().min(1, "请填写商品 ID 或推广链接").max(200, "查询内容过长").refine(
  (value) => Boolean(normalizeLeaguePromotionLink(value)) || !/^(?:https?:\/\/|v\d+=|weixinstore)|\//i.test(value),
  "推广链接仅支持 weixinstorehs/... 或 weixinstoresubhs/... 格式",
);

const schema = z.object({
  query: lookupValueSchema.optional(),
  outProductId: lookupValueSchema.optional(),
}).refine((input) => Boolean(input.query || input.outProductId), {
  message: "请填写商品 ID 或推广链接",
}).transform((input) => ({ query: (input.query || input.outProductId || "").trim() }));

async function loadExistingProduct(value: string) {
  const sql = getDb();
  const [product] = await sql`
    SELECT p.*,
      (SELECT coalesce(json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name), '[]')
       FROM product_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.product_id = p.id) AS departments,
      (SELECT coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name), '[]')
       FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id) AS tags
    FROM product_api_ids pai
    JOIN products p ON p.id = pai.product_id
    WHERE pai.is_current = true AND pai.value = ${value}
    ORDER BY p.archived ASC, pai.updated_at DESC
    LIMIT 1
  `;
  return product || null;
}

async function loadWindowFallback(value: string): Promise<LeagueProductSnapshot | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT title, img_url, selling_price_fen, shop_appid, shop_name, shop_score,
           shop_icon, good_evaluation_ratio
    FROM talent_window_products
    WHERE out_product_id = ${value}
    ORDER BY synced_at DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    title: row.title || null,
    imageUrls: row.imgUrl ? [String(row.imgUrl)] : [],
    sellingPriceFen: row.sellingPriceFen === null ? null : Number(row.sellingPriceFen),
    shopAppid: row.shopAppid || null,
    shopName: row.shopName || null,
    shopScore: row.shopScore === null ? null : Number(row.shopScore),
    shopIcon: row.shopIcon || null,
    goodEvaluationRatio: row.goodEvaluationRatio === null ? null : Number(row.goodEvaluationRatio),
  };
}

function existingSnapshot(product: Record<string, unknown> | null): LeagueProductSnapshot | null {
  if (!product) return null;
  return {
    title: product.name ? String(product.name) : null,
    imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls.map(String) : [],
    sellingPriceFen: product.price === null || product.price === undefined ? null : Math.round(Number(product.price) * 100),
    shopAppid: null,
    shopName: product.storeName ? String(product.storeName) : null,
    shopScore: product.storeRating === null || product.storeRating === undefined ? null : Math.round(Number(product.storeRating) * 100),
    shopIcon: null,
    goodEvaluationRatio: null,
  };
}

function enrichCandidate(candidate: LeagueProductLookupCandidate, ...fallbacks: Array<LeagueProductSnapshot | null>) {
  const product = mergeLeagueProductSnapshots(candidate, ...fallbacks);
  return { ...candidate, ...product, key: `${candidate.accountId}:${candidate.headSupplierItemLink}` };
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create");
    const input = schema.parse(await readJson(request));
    const lookupStartedAt = Date.now();
    const promotionLink = normalizeLeaguePromotionLink(input.query);
    let outProductId = input.query;
    let lookup;
    let existingProduct;
    let windowFallback;

    if (promotionLink) {
      lookup = await lookupLeagueProductCandidatesByPromotionLink(promotionLink);
      if (lookup.duplicate) {
        await writeAudit(user, "promotion_link.lookup_duplicate", "promotion_link", promotionLink, `推广链接 ${promotionLink} 对应多条机构目录记录`, {
          durationMs: Date.now() - lookupStartedAt,
          errors: lookup.errors,
        }, requestIp(request));
        return Response.json({ ok: false, message: lookup.errors[0] }, { status: 409 });
      }
      if (!lookup.outProductId) {
        const message = lookup.accountCount === 0
          ? "尚未配置已启用的联盟机构账号"
          : "未在已同步的联盟机构商品目录中找到该推广链接，请先同步机构目录后重试";
        await writeAudit(user, "promotion_link.lookup_not_found", "promotion_link", promotionLink, `快捷登记未找到推广链接 ${promotionLink}`, {
          cacheHits: lookup.cacheHits,
          durationMs: Date.now() - lookupStartedAt,
        }, requestIp(request));
        return Response.json({ ok: false, message }, { status: 404 });
      }
      outProductId = lookup.outProductId;
      [existingProduct, windowFallback] = await Promise.all([
        loadExistingProduct(outProductId),
        loadWindowFallback(outProductId),
      ]);
    } else {
      [existingProduct, windowFallback, lookup] = await Promise.all([
        loadExistingProduct(outProductId),
        loadWindowFallback(outProductId),
        lookupLeagueProductCandidates(outProductId),
      ]);
    }
    const fallback = existingSnapshot(existingProduct as Record<string, unknown> | null);
    const candidates = lookup.candidates.map((candidate) => enrichCandidate(candidate, windowFallback, fallback));
    const preferred = (promotionLink ? candidates : preferredLeaguePromotionCandidates(candidates)) as Array<ReturnType<typeof enrichCandidate>>;

    if (!preferred.length && !existingProduct) {
      const message = lookup.accountCount === 0
        ? "尚未配置已启用的联盟机构账号"
        : lookup.errors.length
          ? `联盟机构未能返回该商品：${lookup.errors[0]}`
          : "该商品未与任何已启用机构合作";
      await writeAudit(user, promotionLink ? "promotion_link.lookup_failed" : "product_id.lookup_not_found", promotionLink ? "promotion_link" : "product_api_id", promotionLink || outProductId, promotionLink ? `推广链接 ${promotionLink} 未能取得商品资料` : `快捷登记未找到商品 ID ${outProductId}`, {
        cacheHits: lookup.cacheHits,
        refreshedAccounts: lookup.refreshedAccounts,
        primaryScanLimited: lookup.scanLimited,
        durationMs: Date.now() - lookupStartedAt,
        errors: lookup.errors.slice(0, 5),
      }, requestIp(request));
      return Response.json({ ok: false, message }, { status: 404 });
    }

    const apiWarning = preferred.length
      ? lookup.errors.length ? `部分机构资料获取失败：${lookup.errors[0]}` : null
      : "联盟接口资料刷新失败或未找到合作商品，本次显示现有商品档案";
    const choices = preferred.length > 1 ? preferred : [];
    const selected = preferred.length === 1 ? preferred[0] : preferred.length === 0 && existingProduct
      ? { ...fallback, key: "existing", accountId: null, accountName: null, accountIsPrimary: false, promotionLink: promotionLink || existingProduct.productUrl || null, headSupplierItemLink: promotionLink || existingProduct.productUrl || null, commissionRatio: null, normalCommissionRatio: null, serviceRatio: null, commissionType: null, planType: null, error: apiWarning }
      : null;

    const usable = selected || choices[0];
    if (!usable?.imageUrls?.length && !existingProduct) {
      return Response.json({ ok: false, message: "联盟接口没有返回可用于疑似同款识别的商品图片" }, { status: 502 });
    }

    await writeAudit(
      user,
      promotionLink ? "promotion_link.lookup" : "product_id.lookup",
      promotionLink ? "promotion_link" : "product_api_id",
      promotionLink || outProductId,
      promotionLink ? `快捷登记通过推广链接查询商品 ID ${outProductId}${existingProduct ? "，已关联现有商品" : ""}` : `快捷登记查询商品 ID ${outProductId}${existingProduct ? "，已关联现有商品" : ""}`,
      {
        candidateCount: candidates.length,
        requiresChoice: choices.length > 1,
        cacheHits: lookup.cacheHits,
        refreshedAccounts: lookup.refreshedAccounts,
        primaryScanLimited: lookup.scanLimited,
        durationMs: Date.now() - lookupStartedAt,
        errors: lookup.errors.slice(0, 5),
      },
      requestIp(request),
    );
    return ok({
      outProductId,
      lookupType: promotionLink ? "promotion-link" : "product-id",
      promotionLink,
      existingProduct,
      selected,
      choices,
      warning: apiWarning,
    });
  } catch (error) {
    return apiError(error);
  }
}
