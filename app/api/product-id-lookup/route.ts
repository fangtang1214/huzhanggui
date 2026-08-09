import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import {
  lookupLeagueProductCandidates,
  mergeLeagueProductSnapshots,
  preferredLeaguePromotionCandidates,
  type LeagueProductLookupCandidate,
  type LeagueProductSnapshot,
} from "@/lib/league-product";

const schema = z.object({
  outProductId: z.string().trim().min(1, "请填写商品 ID").max(100, "商品 ID 过长"),
});

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
    const [existingProduct, windowFallback, lookup] = await Promise.all([
      loadExistingProduct(input.outProductId),
      loadWindowFallback(input.outProductId),
      lookupLeagueProductCandidates(input.outProductId),
    ]);
    const fallback = existingSnapshot(existingProduct as Record<string, unknown> | null);
    const candidates = lookup.candidates.map((candidate) => enrichCandidate(candidate, windowFallback, fallback));
    const preferred = preferredLeaguePromotionCandidates(candidates) as Array<ReturnType<typeof enrichCandidate>>;

    if (!preferred.length && !existingProduct) {
      const message = lookup.accountCount === 0
        ? "尚未配置已启用的联盟机构账号"
        : lookup.errors.length
          ? `联盟机构未能返回该商品：${lookup.errors[0]}`
          : "所有已启用的联盟机构账号中都未找到该商品 ID";
      await writeAudit(user, "product_id.lookup_not_found", "product_api_id", input.outProductId, `快捷登记未找到商品 ID ${input.outProductId}`, {
        cacheHits: lookup.cacheHits,
        refreshedAccounts: lookup.refreshedAccounts,
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
      ? { ...fallback, key: "existing", accountId: null, accountName: null, accountIsPrimary: false, promotionLink: existingProduct.productUrl || null, headSupplierItemLink: existingProduct.productUrl || null, commissionRatio: null, normalCommissionRatio: null, serviceRatio: null, commissionType: null, planType: null, error: apiWarning }
      : null;

    const usable = selected || choices[0];
    if (!usable?.imageUrls?.length && !existingProduct) {
      return Response.json({ ok: false, message: "联盟接口没有返回可用于疑似同款识别的商品图片" }, { status: 502 });
    }

    await writeAudit(
      user,
      "product_id.lookup",
      "product_api_id",
      input.outProductId,
      `快捷登记查询商品 ID ${input.outProductId}${existingProduct ? "，已关联现有商品" : ""}`,
      {
        candidateCount: candidates.length,
        requiresChoice: choices.length > 1,
        cacheHits: lookup.cacheHits,
        refreshedAccounts: lookup.refreshedAccounts,
        durationMs: Date.now() - lookupStartedAt,
        errors: lookup.errors.slice(0, 5),
      },
      requestIp(request),
    );
    return ok({
      outProductId: input.outProductId,
      existingProduct,
      selected,
      choices,
      warning: apiWarning,
    });
  } catch (error) {
    return apiError(error);
  }
}
