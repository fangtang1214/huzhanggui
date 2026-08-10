ALTER TABLE league_cooperative_item_cache
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS image_urls,
  DROP COLUMN IF EXISTS selling_price_fen,
  DROP COLUMN IF EXISTS shop_appid,
  DROP COLUMN IF EXISTS shop_name,
  DROP COLUMN IF EXISTS shop_score,
  DROP COLUMN IF EXISTS shop_icon,
  DROP COLUMN IF EXISTS good_evaluation_ratio;

CREATE INDEX IF NOT EXISTS league_cooperative_item_product_idx
  ON league_cooperative_item_cache(product_id, league_account_id);

ALTER TABLE league_cooperative_cache_state
  ADD COLUMN IF NOT EXISTS sync_status varchar(20) NOT NULL DEFAULT 'idle'
    CHECK (sync_status IN ('idle', 'pending', 'running', 'failed')),
  ADD COLUMN IF NOT EXISTS sync_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_error text;

INSERT INTO league_cooperative_cache_state(
  league_account_id, item_count, synced_at, sync_status, sync_requested_at
)
SELECT id, 0, '1970-01-01 00:00:00+00', 'pending', now()
FROM league_accounts
WHERE active = true
ON CONFLICT (league_account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS league_product_lookup_throttles (
  league_account_id uuid NOT NULL REFERENCES league_accounts(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_account_id, product_id)
);

CREATE INDEX IF NOT EXISTS league_product_lookup_throttle_cleanup_idx
  ON league_product_lookup_throttles(last_attempt_at);
