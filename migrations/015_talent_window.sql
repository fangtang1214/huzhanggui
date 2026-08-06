CREATE TABLE IF NOT EXISTS talent_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  appid varchar(80) NOT NULL,
  app_secret text NOT NULL,
  access_token text,
  token_expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  sync_status varchar(20) NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'failed')),
  sync_error text,
  synced_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS talent_accounts_appid_unique ON talent_accounts (appid);

CREATE TABLE IF NOT EXISTS talent_window_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES talent_accounts(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  out_product_id text,
  shop_appid text,
  product_source int,
  title text,
  img_url text,
  selling_price_fen int,
  stock int,
  sales int,
  status int,
  is_hide boolean,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, product_id)
);
CREATE INDEX IF NOT EXISTS talent_window_products_account_idx ON talent_window_products (account_id);
