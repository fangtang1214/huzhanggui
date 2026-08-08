ALTER TABLE league_accounts
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;

UPDATE league_accounts
SET is_primary = true
WHERE id = (
  SELECT id FROM league_accounts ORDER BY created_at, id LIMIT 1
)
  AND NOT EXISTS (SELECT 1 FROM league_accounts WHERE is_primary = true);

CREATE UNIQUE INDEX IF NOT EXISTS league_accounts_one_primary_unique
ON league_accounts (is_primary)
WHERE is_primary = true;

ALTER TABLE product_link_history DROP CONSTRAINT IF EXISTS product_link_history_source_check;
ALTER TABLE product_link_history
  ADD CONSTRAINT product_link_history_source_check
  CHECK (source IN ('product_edit', 'link_issue', 'intake_merge', 'recognition_correction', 'window_registration', 'league_link_correction'));

ALTER TABLE talent_window_products
  ADD COLUMN IF NOT EXISTS promotion_product_id text,
  ADD COLUMN IF NOT EXISTS promotion_out_product_id text,
  ADD COLUMN IF NOT EXISTS promotion_error text,
  ADD COLUMN IF NOT EXISTS promotion_synced_at timestamptz;

CREATE TABLE IF NOT EXISTS product_api_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  id_type varchar(20) NOT NULL CHECK (id_type IN ('product_id', 'out_product_id')),
  value text NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_pair_unique
ON product_api_ids (product_id, id_type, value);

CREATE UNIQUE INDEX IF NOT EXISTS product_api_ids_one_current_unique
ON product_api_ids (product_id)
WHERE is_current = true;

CREATE INDEX IF NOT EXISTS product_api_ids_current_lookup_idx
ON product_api_ids (id_type, value)
WHERE is_current = true;

CREATE INDEX IF NOT EXISTS product_api_ids_product_created_idx
ON product_api_ids (product_id, is_current DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS product_link_correction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_count integer NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  success_count integer NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  retry_of uuid REFERENCES product_link_correction_runs(id) ON DELETE SET NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_link_correction_runs_created_idx
ON product_link_correction_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS product_link_correction_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES product_link_correction_runs(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_product_url text,
  new_product_url text,
  api_product_id text,
  api_out_product_id text,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (run_id, product_id)
);

CREATE INDEX IF NOT EXISTS product_link_correction_items_run_status_idx
ON product_link_correction_items (run_id, status, created_at);
