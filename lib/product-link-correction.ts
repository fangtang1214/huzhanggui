import { getDb } from "./db";
import { fetchLeagueCooperativeItemLinks, loadActiveLeagueAccounts, resolveLeaguePromotion, type CooperativeItem } from "./league-product";

const ITEM_CONCURRENCY = 5;

export async function processProductLinkCorrection(runId: string) {
  const sql = getDb();
  const claimed = await sql`
    UPDATE product_link_correction_runs
    SET status = 'running', started_at = now(), updated_at = now()
    WHERE id = ${runId} AND status = 'pending'
    RETURNING id
  `;
  if (!claimed.length) return;

  try {
    const [run] = await sql`SELECT requested_by FROM product_link_correction_runs WHERE id = ${runId}`;
    const accounts = await loadActiveLeagueAccounts();
    if (!accounts.length) throw new Error("没有已启用的联盟机构账号");
    const directLookupMaps = await Promise.all(accounts.map(async (account) => {
      try { return await fetchLeagueCooperativeItemLinks(account); }
      catch (error) {
        console.warn("历史商品校正读取机构合作商品列表失败", { accountId: account.id, error });
        return new Map<string, CooperativeItem[]>();
      }
    }));
    const items = await sql`
      SELECT i.id, i.product_id, i.old_product_url, p.sku,
             (SELECT value FROM product_api_ids WHERE product_id = p.id AND is_current = true LIMIT 1) AS api_product_id
      FROM product_link_correction_items i
      JOIN products p ON p.id = i.product_id
      WHERE i.run_id = ${runId} AND i.status = 'pending'
      ORDER BY i.created_at, i.id
    `;
    const typedItems = items as unknown as Array<{ id: string; productId: string; oldProductUrl: string | null; sku: string; apiProductId: string | null }>;
    for (let index = 0; index < typedItems.length; index += ITEM_CONCURRENCY) {
      const batch = typedItems.slice(index, index + ITEM_CONCURRENCY);
      await Promise.all(batch.map((item) => processCorrectionItem(sql, runId, run?.requestedBy || null, accounts, directLookupMaps, item)));
    }
    await sql`
      UPDATE product_link_correction_runs
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = ${runId} AND status = 'running'
    `;
  } catch (error) {
    await sql`
      UPDATE product_link_correction_runs
      SET status = 'failed', error = ${error instanceof Error ? error.message : "校正任务失败"}, completed_at = now(), updated_at = now()
      WHERE id = ${runId}
    `;
  }
}

async function processCorrectionItem(
  sql: ReturnType<typeof getDb>,
  runId: string,
  changedBy: string | null,
  accounts: Awaited<ReturnType<typeof loadActiveLeagueAccounts>>,
  directLookupMaps: Map<string, CooperativeItem[]>[],
  item: { id: string; productId: string; oldProductUrl: string | null; sku: string; apiProductId: string | null },
) {
  try {
    const result = await resolveLeaguePromotion(accounts, {
      productId: item.apiProductId || "",
      existingLink: item.oldProductUrl,
    }, directLookupMaps);
    const hasId = Boolean(item.apiProductId);
    const hasLink = Boolean(result.promotionLink);
    const succeeded = await sql.begin(async (tx) => {
      const [product] = await tx`SELECT id, product_url, archived FROM products WHERE id = ${item.productId} FOR UPDATE`;
      if (!product || product.archived) throw new Error("商品已归档或不存在");
      if (String(product.productUrl || "") !== String(item.oldProductUrl || "")) throw new Error("商品当前链接已发生变化，请重新校正");
      if (hasLink && result.promotionLink !== product.productUrl) {
        if (product.productUrl) await tx`
          INSERT INTO product_link_history(product_id, url, replaced_by_url, source, source_entity_id, changed_by)
          VALUES (${item.productId}, ${product.productUrl}, ${result.promotionLink}, 'league_link_correction', ${runId}, ${changedBy})
        `;
        await tx`UPDATE products SET product_url = ${result.promotionLink}, version = version + 1, updated_at = now() WHERE id = ${item.productId}`;
      }
      if (!hasLink) {
        await tx`
          UPDATE product_link_correction_items
          SET status = 'failed', api_product_id = ${item.apiProductId},
              error = ${hasId ? "接口返回商品 ID，但未返回推广链接" : result.error || "未获取到机构推广链接"}, completed_at = now(), updated_at = now()
          WHERE id = ${item.id}
        `;
        return false;
      }
      await tx`
        UPDATE product_link_correction_items
        SET status = 'success', new_product_url = ${result.promotionLink}, api_product_id = ${item.apiProductId}, error = null, completed_at = now(), updated_at = now()
        WHERE id = ${item.id}
      `;
      return true;
    });
    await sql`
      UPDATE product_link_correction_runs
      SET processed_count = processed_count + 1,
          success_count = success_count + ${succeeded ? 1 : 0},
          failed_count = failed_count + ${succeeded ? 0 : 1}, updated_at = now()
      WHERE id = ${runId}
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : "校正失败";
    await sql`
      UPDATE product_link_correction_items
      SET status = 'failed', error = ${message.slice(0, 1000)}, completed_at = now(), updated_at = now()
      WHERE id = ${item.id}
    `;
    await sql`UPDATE product_link_correction_runs SET processed_count = processed_count + 1, failed_count = failed_count + 1, updated_at = now() WHERE id = ${runId}`;
  }
}
