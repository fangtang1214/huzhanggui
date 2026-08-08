DROP INDEX IF EXISTS product_api_ids_one_current_unique;

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_one_current_per_type_unique
ON product_api_ids (product_id, id_type)
WHERE is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_current_value_unique
ON product_api_ids (id_type, value)
WHERE is_current = true;

ALTER TABLE talent_window_products
  ADD COLUMN IF NOT EXISTS promotion_account_id uuid REFERENCES league_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS promotion_candidate_id uuid,
  ADD COLUMN IF NOT EXISTS promotion_status varchar(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS promotion_confirmed boolean NOT NULL DEFAULT false;

ALTER TABLE talent_window_products DROP CONSTRAINT IF EXISTS talent_window_products_promotion_status_check;
ALTER TABLE talent_window_products
  ADD CONSTRAINT talent_window_products_promotion_status_check
  CHECK (promotion_status IN ('pending', 'selected', 'confirmed', 'needs_choice', 'needs_replacement'));

UPDATE talent_window_products
SET promotion_status = CASE WHEN promotion_link IS NOT NULL AND promotion_error IS NULL THEN 'confirmed' ELSE 'pending' END,
    promotion_confirmed = promotion_link IS NOT NULL AND promotion_error IS NULL,
    promotion_error = CASE
      WHEN promotion_link IS NOT NULL AND promotion_error IS NULL THEN NULL
      ELSE coalesce(promotion_error, '请重新同步以核验机构推广链接')
    END
WHERE promotion_status = 'pending';

CREATE TABLE IF NOT EXISTS talent_window_promotion_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_product_id uuid NOT NULL REFERENCES talent_window_products(id) ON DELETE CASCADE,
  league_account_id uuid NOT NULL REFERENCES league_accounts(id) ON DELETE CASCADE,
  head_supplier_item_link text NOT NULL,
  promotion_link text NOT NULL,
  product_id text,
  out_product_id text,
  commission_ratio int,
  normal_commission_ratio int,
  service_ratio int,
  commission_type int,
  plan_type int,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_product_id, league_account_id, head_supplier_item_link)
);

CREATE INDEX IF NOT EXISTS talent_window_promotion_candidates_window_idx
ON talent_window_promotion_candidates (window_product_id, service_ratio DESC, fetched_at DESC);

ALTER TABLE talent_window_products DROP CONSTRAINT IF EXISTS talent_window_products_promotion_candidate_fk;
ALTER TABLE talent_window_products
  ADD CONSTRAINT talent_window_products_promotion_candidate_fk
  FOREIGN KEY (promotion_candidate_id)
  REFERENCES talent_window_promotion_candidates(id)
  ON DELETE SET NULL;
