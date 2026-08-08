-- 商品唯一接口 ID 统一使用达人橱窗接口返回的 product_id。
DELETE FROM product_api_ids WHERE id_type = 'out_product_id';

DROP INDEX IF EXISTS product_api_ids_pair_unique;
DROP INDEX IF EXISTS product_api_ids_one_current_per_type_unique;
DROP INDEX IF EXISTS product_api_ids_current_value_unique;
DROP INDEX IF EXISTS product_api_ids_current_lookup_idx;

ALTER TABLE product_api_ids
  DROP CONSTRAINT IF EXISTS product_api_ids_id_type_check,
  DROP COLUMN IF EXISTS id_type;

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_pair_unique
ON product_api_ids (product_id, value);

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_one_current_unique
ON product_api_ids (product_id)
WHERE is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_current_value_unique
ON product_api_ids (value)
WHERE is_current = true;

ALTER TABLE talent_window_products
  DROP COLUMN IF EXISTS out_product_id,
  DROP COLUMN IF EXISTS promotion_product_id,
  DROP COLUMN IF EXISTS promotion_out_product_id;

ALTER TABLE talent_window_promotion_candidates
  DROP COLUMN IF EXISTS product_id,
  DROP COLUMN IF EXISTS out_product_id;

ALTER TABLE product_link_correction_items
  DROP COLUMN IF EXISTS api_out_product_id;

UPDATE product_intake_batches
SET submitted_data = submitted_data - 'apiOutProductId'
WHERE submitted_data ? 'apiOutProductId';
