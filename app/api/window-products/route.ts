import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

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
    const effectiveAccountId = requestedAccountId || (accounts[0] as { id?: string } | undefined)?.id || null;
    if (!effectiveAccountId) return ok({ accounts, products: [] });

    const productLinkFragment = sql`coalesce(w.promotion_link, 'weixinstorehs/' || coalesce(w.out_product_id, w.product_id))`;
    const products = await sql`
      SELECT w.id, w.product_id, w.out_product_id, w.product_source, w.title, w.img_url,
             w.selling_price_fen, w.stock, w.sales, w.status, w.is_hide, w.synced_at,
             w.shop_name, w.shop_score, w.shop_icon, w.good_evaluation_ratio, w.quality_synced_at,
             ${productLinkFragment} AS link,
             p.id AS registered_product_id, p.sku AS registered_sku
      FROM talent_window_products w
      LEFT JOIN products p ON p.product_url IN (
        w.promotion_link,
        'weixinstorehs/' || w.product_id,
        'weixinstorehs/' || coalesce(w.out_product_id, w.product_id),
        'weixinstoresubs/' || w.product_id,
        'weixinstoresubs/' || coalesce(w.out_product_id, w.product_id)
      )
      WHERE w.account_id = ${effectiveAccountId}
      ORDER BY w.synced_at DESC, w.product_id DESC
    `;
    return ok({ accounts, products });
  } catch (error) { return apiError(error); }
}
