ALTER TABLE samples ADD COLUMN IF NOT EXISTS archived_with_product boolean NOT NULL DEFAULT false;

-- 升级前随商品归档的样品没有来源标记；按归档商品补齐，以便恢复完整档案。
UPDATE samples s
SET archived_with_product = true
FROM products p
WHERE s.product_id = p.id
  AND s.archived = true
  AND p.archived = true;

CREATE INDEX IF NOT EXISTS samples_archived_with_product_idx
ON samples(product_id)
WHERE archived_with_product = true;
