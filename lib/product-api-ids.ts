import type { Sql, TransactionSql } from "postgres";

type Queryable = Sql<Record<string, unknown>> | TransactionSql<Record<string, unknown>>;

export type ProductApiIds = {
  productId?: string | null;
  outProductId?: string | null;
};

function normalize(value: string | null | undefined) {
  const text = value?.trim() || "";
  return text || null;
}

export async function setCurrentProductApiIds(tx: Queryable, productId: string, values: ProductApiIds) {
  let changed = false;
  for (const [idType, rawValue] of [["product_id", values.productId], ["out_product_id", values.outProductId]] as const) {
    const value = normalize(rawValue);
    if (!value) continue;
    const [existing] = await tx`
      SELECT id, is_current
      FROM product_api_ids
      WHERE product_id = ${productId} AND id_type = ${idType} AND value = ${value}
      FOR UPDATE
    `;
    if (existing?.isCurrent) continue;
    await tx`UPDATE product_api_ids SET is_current = false, updated_at = now() WHERE product_id = ${productId} AND id_type = ${idType} AND is_current = true`;
    if (existing) await tx`UPDATE product_api_ids SET is_current = true, updated_at = now() WHERE id = ${existing.id}`;
    else await tx`INSERT INTO product_api_ids(product_id, id_type, value, is_current) VALUES (${productId}, ${idType}, ${value}, true)`;
    changed = true;
  }
  return changed;
}
