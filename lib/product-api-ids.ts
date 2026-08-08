import type { Sql, TransactionSql } from "postgres";

type Queryable = Sql<Record<string, unknown>> | TransactionSql<Record<string, unknown>>;

function normalize(value: string | null | undefined) {
  const text = value?.trim() || "";
  return text || null;
}

export async function setCurrentProductApiId(tx: Queryable, productId: string, rawValue: string | null | undefined) {
  const value = normalize(rawValue);
  if (!value) return false;
  const [existing] = await tx`
    SELECT id, is_current
    FROM product_api_ids
    WHERE product_id = ${productId} AND value = ${value}
    FOR UPDATE
  `;
  if (existing?.isCurrent) return false;
  await tx`UPDATE product_api_ids SET is_current = false, updated_at = now() WHERE product_id = ${productId} AND is_current = true`;
  if (existing) await tx`UPDATE product_api_ids SET is_current = true, updated_at = now() WHERE id = ${existing.id}`;
  else await tx`INSERT INTO product_api_ids(product_id, value, is_current) VALUES (${productId}, ${value}, true)`;
  return true;
}
