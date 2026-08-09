import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { fetchLeagueProductDetail, loadLeagueAccount } from "@/lib/league-product";

const confirmSchema = z.object({
  windowProductId: z.string().uuid(),
  candidateId: z.string().uuid(),
});

export async function GET(request: Request) {
  try {
    await requireUser("products:create");
    const sql = getDb();
    const params = new URL(request.url).searchParams;
    const requestedAccountId = params.get("accountId") || null;
    if (params.get("status") === "1") {
      const [account] = requestedAccountId ? await sql`
        SELECT id, sync_status, sync_error, synced_at
        FROM talent_accounts
        WHERE id = ${requestedAccountId} AND active = true
        LIMIT 1
      ` : [null];
      return ok({ account: account || null });
    }
    if (params.get("pending") === "1") {
      if (!requestedAccountId) return ok({ pendingPromotions: [] });
      const pendingPromotions = await sql`
        SELECT w.id, coalesce(w.out_product_id, w.product_id) AS product_id, w.title, w.img_url,
               w.promotion_status,
               p.id AS registered_product_id, p.sku AS registered_sku, p.product_url AS registered_product_url,
               coalesce((
                 SELECT json_agg(json_build_object(
                   'id', c.id,
                   'accountId', c.league_account_id,
                   'accountName', ca.name,
                   'accountIsPrimary', ca.is_primary,
                   'headSupplierItemLink', c.head_supplier_item_link,
                   'promotionLink', c.promotion_link,
                   'serviceRatio', c.service_ratio,
                   'commissionRatio', c.commission_ratio
                 ) ORDER BY ca.is_primary DESC, c.service_ratio DESC NULLS LAST, ca.name, c.id)
                 FROM talent_window_promotion_candidates c
                 JOIN league_accounts ca ON ca.id = c.league_account_id
                 WHERE c.window_product_id = w.id
               ), '[]'::json) AS promotion_candidates
        FROM talent_window_products w
        JOIN talent_accounts a ON a.id = w.account_id AND a.active = true
        LEFT JOIN product_api_ids pai
          ON pai.is_current = true
         AND pai.value = coalesce(w.out_product_id, w.product_id)
        LEFT JOIN products p
          ON p.id = pai.product_id
         AND p.archived = false
        WHERE w.account_id = ${requestedAccountId}
          AND w.promotion_status IN ('needs_choice', 'needs_replacement')
        ORDER BY w.synced_at DESC, w.product_id DESC
      `;
      return ok({ pendingPromotions });
    }
    const [accounts, leagueRows] = await Promise.all([
      sql`
        SELECT a.id, a.name, a.appid, a.sync_status, a.sync_error, a.synced_at,
               (SELECT count(*)::int FROM talent_window_products w WHERE w.account_id = a.id) AS product_count
        FROM talent_accounts a
        WHERE a.active = true
        ORDER BY a.created_at
      `,
      sql`
        SELECT count(*)::int AS active_count,
               coalesce(bool_or(is_primary), false) AS has_primary
        FROM league_accounts
        WHERE active = true
      `,
    ]);
    const leagueState = leagueRows[0];
    const requestedAccount = accounts.find((account) => String(account.id) === requestedAccountId);
    const effectiveAccountId = requestedAccount?.id || (accounts[0] as { id?: string } | undefined)?.id || null;
    const requestedPage = Number(params.get("page") || 1);
    const requestedPageSize = Number(params.get("pageSize") || 20);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
    const pageSize = Number.isFinite(requestedPageSize) ? Math.min(100, Math.max(10, Math.floor(requestedPageSize))) : 20;
    const offset = (page - 1) * pageSize;
    if (!effectiveAccountId) return ok({ accounts, products: [], pendingPromotions: [], total: 0, page, pageSize, leagueState });

    const search = (params.get("search") || "").trim();
    const pattern = `%${search}%`;
    const priceRange = params.get("priceRange") || "";
    const scoreRange = params.get("scoreRange") || "";
    const evalRange = params.get("evalRange") || "";
    const stockFilter = params.get("stockFilter") || "";
    const regFilter = params.get("regFilter") || "";
    const sortField = params.get("sortField") || "";
    const sortDir = params.get("sortDir") === "desc" ? "desc" : "asc";
    const priceFilter = priceRange === "lt10" ? sql`AND w.selling_price_fen < 1000`
      : priceRange === "10to50" ? sql`AND w.selling_price_fen >= 1000 AND w.selling_price_fen < 5000`
        : priceRange === "50to100" ? sql`AND w.selling_price_fen >= 5000 AND w.selling_price_fen < 10000`
          : priceRange === "gt100" ? sql`AND w.selling_price_fen >= 10000` : sql``;
    const scoreFilter = scoreRange === "gte45" ? sql`AND w.shop_score >= 450`
      : scoreRange === "40to45" ? sql`AND w.shop_score >= 400 AND w.shop_score < 450`
        : scoreRange === "lt40" ? sql`AND w.shop_score < 400`
          : scoreRange === "none" ? sql`AND w.shop_score IS NULL` : sql``;
    const evaluationFilter = evalRange === "gte90" ? sql`AND w.good_evaluation_ratio >= 90000`
      : evalRange === "80to90" ? sql`AND w.good_evaluation_ratio >= 80000 AND w.good_evaluation_ratio < 90000`
        : evalRange === "lt80" ? sql`AND w.good_evaluation_ratio < 80000`
          : evalRange === "none" ? sql`AND w.good_evaluation_ratio IS NULL` : sql``;
    const stockCondition = stockFilter === "has" ? sql`AND coalesce(w.stock, 0) > 0`
      : stockFilter === "empty" ? sql`AND coalesce(w.stock, 0) = 0` : sql``;
    const registrationFilter = regFilter === "yes" ? sql`AND p.id IS NOT NULL`
      : regFilter === "no" ? sql`AND p.id IS NULL` : sql``;
    const orderBy = sortField === "price"
      ? sortDir === "desc" ? sql`w.selling_price_fen DESC NULLS LAST, w.synced_at DESC, w.product_id DESC` : sql`w.selling_price_fen ASC NULLS LAST, w.synced_at DESC, w.product_id DESC`
      : sortField === "score"
        ? sortDir === "desc" ? sql`w.shop_score DESC NULLS LAST, w.synced_at DESC, w.product_id DESC` : sql`w.shop_score ASC NULLS LAST, w.synced_at DESC, w.product_id DESC`
        : sortField === "eval"
          ? sortDir === "desc" ? sql`w.good_evaluation_ratio DESC NULLS LAST, w.synced_at DESC, w.product_id DESC` : sql`w.good_evaluation_ratio ASC NULLS LAST, w.synced_at DESC, w.product_id DESC`
          : sql`w.synced_at DESC, w.product_id DESC`;

    const commonWhere = sql`
      w.account_id = ${effectiveAccountId}
      AND (${search} = '' OR w.title ILIKE ${pattern}
        OR coalesce(w.out_product_id, w.product_id) ILIKE ${pattern}
        OR w.shop_name ILIKE ${pattern}
        OR w.promotion_link ILIKE ${pattern})
      ${priceFilter} ${scoreFilter} ${evaluationFilter} ${stockCondition} ${registrationFilter}
    `;

    const [products, countRows] = await Promise.all([sql`
       SELECT w.id, coalesce(w.out_product_id, w.product_id) AS product_id, w.product_source, w.title, w.img_url,
              w.selling_price_fen, w.stock, w.sales, w.status, w.is_hide, w.synced_at,
              w.shop_name, w.shop_score, w.shop_icon, w.good_evaluation_ratio, w.quality_synced_at,
              w.commission_ratio, w.normal_commission_ratio, w.service_ratio, w.commission_type, w.plan_type,
              w.promotion_link, w.promotion_error, w.promotion_synced_at,
              w.promotion_status, w.promotion_confirmed, w.promotion_account_id, la.name AS promotion_account_name,
              w.promotion_link AS link,
              p.id AS registered_product_id, p.sku AS registered_sku, p.product_url AS registered_product_url,
              '[]'::json AS promotion_candidates
       FROM talent_window_products w
       LEFT JOIN league_accounts la ON la.id = w.promotion_account_id
       LEFT JOIN product_api_ids pai
         ON pai.is_current = true
        AND pai.value = coalesce(w.out_product_id, w.product_id)
      LEFT JOIN products p
         ON p.id = pai.product_id
        AND p.archived = false
      WHERE ${commonWhere}
      ORDER BY ${orderBy}
      LIMIT ${pageSize} OFFSET ${offset}
    `, sql`
      SELECT count(*)::int AS total
      FROM talent_window_products w
      LEFT JOIN product_api_ids pai
        ON pai.is_current = true
       AND pai.value = coalesce(w.out_product_id, w.product_id)
      LEFT JOIN products p
        ON p.id = pai.product_id
       AND p.archived = false
      WHERE ${commonWhere}
    `]);
    return ok({ accounts, products, total: countRows[0]?.total || 0, page, pageSize, leagueState });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create");
    const input = confirmSchema.parse(await readJson(request));
    const sql = getDb();
    const [qualitySource] = await sql`
      SELECT c.league_account_id, coalesce(w.out_product_id, w.product_id) AS product_id, w.shop_appid
      FROM talent_window_promotion_candidates c
      JOIN talent_window_products w ON w.id = c.window_product_id
      WHERE c.id = ${input.candidateId} AND w.id = ${input.windowProductId}
    `;
    if (!qualitySource) return Response.json({ ok: false, message: "待确认推广链接不存在，请重新同步" }, { status: 404 });
    const qualityAccount = qualitySource.shopAppid ? await loadLeagueAccount(String(qualitySource.leagueAccountId)) : null;
    const quality = qualityAccount && qualitySource.shopAppid
      ? await fetchLeagueProductDetail(qualityAccount, String(qualitySource.shopAppid), String(qualitySource.productId)).catch((error) => {
          console.warn("人工确认推广链接后获取机构商品详情失败", { accountId: qualityAccount.id, productId: qualitySource.productId, error });
          return null;
        })
      : null;
    const result = await sql.begin(async (tx) => {
      const [candidate] = await tx`
        SELECT c.*, coalesce(w.out_product_id, w.product_id) AS product_id_value, w.title
        FROM talent_window_promotion_candidates c
        JOIN talent_window_products w ON w.id = c.window_product_id
        WHERE c.id = ${input.candidateId} AND w.id = ${input.windowProductId}
        FOR UPDATE OF w
      `;
      if (!candidate) return null;
      const [registered] = await tx`
        SELECT p.id, p.sku, p.product_url
        FROM product_api_ids pai
        JOIN products p ON p.id = pai.product_id
        WHERE pai.is_current = true
          AND pai.value = ${String(candidate.productIdValue)}
          AND p.archived = false
        LIMIT 1
        FOR UPDATE OF p
      `;
      await tx`
        UPDATE talent_window_products
        SET promotion_link = ${candidate.promotionLink},
            promotion_account_id = ${candidate.leagueAccountId},
            promotion_candidate_id = ${candidate.id},
            promotion_status = 'confirmed', promotion_confirmed = true,
            promotion_error = null, promotion_synced_at = now(),
            commission_ratio = ${candidate.commissionRatio},
            normal_commission_ratio = ${candidate.normalCommissionRatio},
            service_ratio = ${candidate.serviceRatio},
            commission_type = ${candidate.commissionType}, plan_type = ${candidate.planType},
            shop_name = coalesce(${quality?.shopName || null}, shop_name),
            shop_score = coalesce(${quality?.shopScore ?? null}, shop_score),
            shop_icon = coalesce(${quality?.shopIcon || null}, shop_icon),
            good_evaluation_ratio = coalesce(${quality?.goodEvaluationRatio ?? null}, good_evaluation_ratio),
            quality_synced_at = CASE WHEN ${Boolean(quality)} THEN now() ELSE quality_synced_at END
        WHERE id = ${input.windowProductId}
      `;
      if (registered) {
        if (String(registered.productUrl || "") !== String(candidate.promotionLink)) {
          if (registered.productUrl) await tx`
            INSERT INTO product_link_history(product_id, url, replaced_by_url, source, source_entity_id, changed_by)
            VALUES (${registered.id}, ${registered.productUrl}, ${candidate.promotionLink}, 'league_link_correction', ${input.windowProductId}, ${user.id})
          `;
          await tx`UPDATE products SET product_url = ${candidate.promotionLink}, version = version + 1, updated_at = now() WHERE id = ${registered.id}`;
        }
      }
      return {
        windowProductId: input.windowProductId,
        promotionLink: String(candidate.promotionLink),
        registeredProductId: registered?.id ? String(registered.id) : null,
        registeredSku: registered?.sku ? String(registered.sku) : null,
        title: String(candidate.title || ""),
      };
    });
    if (!result) return Response.json({ ok: false, message: "待确认推广链接不存在，请重新同步" }, { status: 404 });
    await writeAudit(user, "window_product.promotion_confirm", "talent_window_product", result.windowProductId, `人工确认机构推广链接 ${result.promotionLink}`, result, requestIp(request));
    return ok(result);
  } catch (error) { return apiError(error); }
}
