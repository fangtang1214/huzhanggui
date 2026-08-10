ALTER TABLE league_cooperative_item_cache
  ADD COLUMN IF NOT EXISTS promotion_detail_link text,
  ADD COLUMN IF NOT EXISTS link_type varchar(32) NOT NULL DEFAULT 'merchant_assigned'
    CHECK (link_type IN ('merchant_assigned', 'institution_assigned')),
  ADD COLUMN IF NOT EXISTS cooperative_item_id text;

UPDATE league_cooperative_item_cache
SET promotion_detail_link = head_supplier_item_link
WHERE promotion_detail_link IS NULL;

ALTER TABLE league_cooperative_item_cache
  ALTER COLUMN promotion_detail_link SET NOT NULL;

CREATE INDEX IF NOT EXISTS league_cooperative_item_type_idx
  ON league_cooperative_item_cache(product_id, link_type, league_account_id);

ALTER TABLE talent_window_promotion_candidates
  ADD COLUMN IF NOT EXISTS link_type varchar(32) NOT NULL DEFAULT 'merchant_assigned'
    CHECK (link_type IN ('merchant_assigned', 'institution_assigned'));

UPDATE talent_window_promotion_candidates
SET link_type = 'institution_assigned'
WHERE promotion_link LIKE 'weixinstoresubhs/%';
