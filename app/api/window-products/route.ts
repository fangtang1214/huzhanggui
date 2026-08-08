import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { fetchLeagueProductDetail, loadLeagueAccount } from "@/lib/league-product";
import { setCurrentProductApiId } from "@/lib/product-api-ids";

const confirmSchema = z.object({
  windowProductId: z.string().uuid(),
  candidateId: z.string().uuid(),
});

export async function GET(request: Request) {
  try {
    await requireUser("products:create");
    const sql = getDb();
    const requestedAccountId = new URL(request.url).searchParams.get("accountId") || null;
    const accounts = await sql`
      SELECT a.id, a.name, a.appid, a.sync_status, a.sync_error, a.synced_at,
             (SELECT count(*)::int FROM talent_window_products w WHERE w.account_id = a.id) AS product_count
      FROM talent_accounts a
      WHERE a.active = true
      ORDER BY a.created_at
    `;
    const [leagueState] = await sql`
      SELECT count(*)::int AS active_count,
             coalesce(bool_or(is_primary), false) AS has_primary
      FROM league_accounts
      WHERE active = true
    `;
    const effectiveAccountId = requestedAccountId || (accounts[0] as { id?: string } | undefined)?.id || null;
    if (!effectiveAccountId) return ok({ accounts, products: [], leagueState });

    const products = await sql`
       SELECT w.id, w.product_id, w.product_source, w.title, w.img_url,
              w.selling_price_fen, w.stock, w.sales, w.status, w.is_hide, w.synced_at,
              w.shop_name, w.shop_score, w.shop_icon, w.good_evaluation_ratio, w.quality_synced_at,
              w.commission_ratio, w.normal_commission_ratio, w.service_ratio, w.commission_type, w.plan_type,
              w.promotion_link, w.promotion_error, w.promotion_synced_at,
              w.promotion_status, w.promotion_confirmed, w.promotion_account_id, la.name AS promotion_account_name,
              w.promotion_link AS link,
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
       LEFT JOIN league_accounts la ON la.id = w.promotion_account_id
       LEFT JOIN LATERAL (
         SELECT candidate_product.id, candidate_product.sku, candidate_product.product_url
         FROM products candidate_product
         WHERE candidate_product.archived = false AND (
           EXISTS (
             SELECT 1 FROM product_api_ids pai
             WHERE pai.product_id = candidate_product.id AND pai.is_current = true
               AND pai.value = w.product_id
           )
           OR candidate_product.product_url = w.promotion_link
           OR EXISTS (
             SELECT 1 FROM product_link_history history
             WHERE history.product_id = candidate_product.id AND history.url = w.promotion_link
           )
         )
         ORDER BY CASE WHEN EXISTS (
           SELECT 1 FROM product_api_ids exact_id
            WHERE exact_id.product_id = candidate_product.id AND exact_id.is_current = true
             AND exact_id.value = w.product_id
         ) THEN 0 ELSE 1 END, candidate_product.updated_at DESC
         LIMIT 1
       ) p ON true
      WHERE w.account_id = ${effectiveAccountId}
      ORDER BY w.synced_at DESC, w.product_id DESC
    `;
    return ok({ accounts, products, leagueState });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create");
    const input = confirmSchema.parse(await readJson(request));
    const sql = getDb();
    const [qualitySource] = await sql`
      SELECT c.league_account_id, w.product_id, w.shop_appid
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
        SELECT c.*, w.product_id AS window_product_id_value,
               w.promotion_link AS old_window_link, w.title
        FROM talent_window_promotion_candidates c
        JOIN talent_window_products w ON w.id = c.window_product_id
        WHERE c.id = ${input.candidateId} AND w.id = ${input.windowProductId}
        FOR UPDATE OF w
      `;
      if (!candidate) return null;
      const [registered] = await tx`
        SELECT p.id, p.sku, p.product_url
        FROM products p
        WHERE p.archived = false AND EXISTS (
          SELECT 1 FROM product_api_ids pai
          WHERE pai.product_id = p.id AND pai.is_current = true
            AND pai.value = ${String(candidate.windowProductIdValue)}
        )
        ORDER BY p.updated_at DESC, p.id
        LIMIT 1
        FOR UPDATE
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
        await setCurrentProductApiId(tx, String(registered.id), String(candidate.windowProductIdValue));
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
