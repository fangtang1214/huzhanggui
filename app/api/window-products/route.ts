import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { setCurrentProductApiIds } from "@/lib/product-api-ids";

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
       SELECT w.id, w.product_id, w.out_product_id, w.product_source, w.title, w.img_url,
              w.selling_price_fen, w.stock, w.sales, w.status, w.is_hide, w.synced_at,
              w.shop_name, w.shop_score, w.shop_icon, w.good_evaluation_ratio, w.quality_synced_at,
              w.commission_ratio, w.normal_commission_ratio, w.service_ratio, w.commission_type, w.plan_type,
              w.promotion_link, w.promotion_product_id, w.promotion_out_product_id, w.promotion_error, w.promotion_synced_at,
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
                  'productId', c.product_id,
                  'outProductId', c.out_product_id,
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
               AND ((pai.id_type = 'product_id' AND pai.value IN (w.product_id, w.promotion_product_id))
                 OR (pai.id_type = 'out_product_id' AND pai.value IN (w.out_product_id, w.promotion_out_product_id)))
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
             AND exact_id.id_type = 'product_id' AND exact_id.value = w.product_id
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
    const result = await sql.begin(async (tx) => {
      const [candidate] = await tx`
        SELECT c.*, w.product_id AS window_product_id_value, w.out_product_id AS window_out_product_id,
               w.promotion_link AS old_window_link, w.title
        FROM talent_window_promotion_candidates c
        JOIN talent_window_products w ON w.id = c.window_product_id
        WHERE c.id = ${input.candidateId} AND w.id = ${input.windowProductId}
        FOR UPDATE OF w
      `;
      if (!candidate) return null;
      const productIds = Array.from(new Set([candidate.windowProductIdValue, candidate.productId].filter(Boolean).map(String)));
      const outProductIds = Array.from(new Set([candidate.windowOutProductId, candidate.outProductId].filter(Boolean).map(String)));
      const [registered] = await tx`
        SELECT p.id, p.sku, p.product_url
        FROM products p
        WHERE p.archived = false AND EXISTS (
          SELECT 1 FROM product_api_ids pai
          WHERE pai.product_id = p.id AND pai.is_current = true
            AND ((pai.id_type = 'product_id' AND pai.value = ANY(${productIds}::text[]))
              OR (pai.id_type = 'out_product_id' AND pai.value = ANY(${outProductIds}::text[])))
        )
        ORDER BY p.updated_at DESC, p.id
        LIMIT 1
        FOR UPDATE
      `;
      await tx`
        UPDATE talent_window_products
        SET promotion_link = ${candidate.promotionLink},
            promotion_product_id = coalesce(${candidate.productId}, promotion_product_id),
            promotion_out_product_id = coalesce(${candidate.outProductId}, promotion_out_product_id),
            promotion_account_id = ${candidate.leagueAccountId},
            promotion_candidate_id = ${candidate.id},
            promotion_status = 'confirmed', promotion_confirmed = true,
            promotion_error = null, promotion_synced_at = now(),
            commission_ratio = ${candidate.commissionRatio},
            normal_commission_ratio = ${candidate.normalCommissionRatio},
            service_ratio = ${candidate.serviceRatio},
            commission_type = ${candidate.commissionType}, plan_type = ${candidate.planType}
        WHERE id = ${input.windowProductId}
      `;
      if (registered) {
        await setCurrentProductApiIds(tx, String(registered.id), {
          productId: candidate.productId || candidate.windowProductIdValue,
          outProductId: candidate.outProductId || candidate.windowOutProductId,
        });
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
