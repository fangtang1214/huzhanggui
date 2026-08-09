CREATE TABLE IF NOT EXISTS league_cooperative_item_cache (
  league_account_id uuid NOT NULL REFERENCES league_accounts(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  head_supplier_item_link text NOT NULL,
  title text,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  selling_price_fen integer,
  shop_appid text,
  shop_name text,
  shop_score integer,
  shop_icon text,
  good_evaluation_ratio integer,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league_account_id, product_id, head_supplier_item_link)
);

CREATE TABLE IF NOT EXISTS league_cooperative_cache_state (
  league_account_id uuid PRIMARY KEY REFERENCES league_accounts(id) ON DELETE CASCADE,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  synced_at timestamptz NOT NULL DEFAULT now()
);
