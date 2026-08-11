import type { Sql } from "postgres";

export function productSearchConditions(sql: Sql, search: string) {
  const like = `%${search}%`;
  const digits = search.replace(/\D/g, "");
  const seq4 = /^\d{1,4}$/.test(digits) ? digits.padStart(4, "0") : null;
  return sql`(${search} = '' OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like} OR p.product_url ILIKE ${like}
    OR (${seq4}::text IS NOT NULL AND right(p.sku, 4) = ${seq4})
    OR EXISTS (SELECT 1 FROM product_api_ids pai WHERE pai.product_id=p.id AND pai.value ILIKE ${like})
    OR EXISTS (SELECT 1 FROM product_sku_aliases psa WHERE psa.product_id=p.id AND psa.alias ILIKE ${like})
    OR EXISTS (SELECT 1 FROM product_link_history history WHERE history.product_id=p.id AND history.url ILIKE ${like}))`;
}

export function sampleSearchConditions(sql: Sql, search: string) {
  const like = `%${search}%`;
  const digits = search.replace(/\D/g, "");
  const seq4 = /^\d{1,4}$/.test(digits) ? digits.padStart(4, "0") : null;
  return sql`(${search} = '' OR s.code ILIKE ${like} OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like} OR p.product_url ILIKE ${like}
    OR (${seq4}::text IS NOT NULL AND right(p.sku, 4) = ${seq4})
    OR EXISTS (SELECT 1 FROM sample_code_aliases sca WHERE sca.sample_id=s.id AND sca.alias ILIKE ${like})
    OR EXISTS (SELECT 1 FROM product_sku_aliases psa WHERE psa.product_id=p.id AND psa.alias ILIKE ${like})
    OR EXISTS (SELECT 1 FROM product_link_history history WHERE history.product_id=p.id AND history.url ILIKE ${like}))`;
}

export function auditSearchConditions(sql: Sql, search: string) {
  const like = `%${search}%`;
  return sql`(${search} = '' OR a.summary ILIKE ${like} OR u.name ILIKE ${like} OR u.username ILIKE ${like})`;
}
