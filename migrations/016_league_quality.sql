CREATE TABLE IF NOT EXISTS league_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  appid varchar(80) NOT NULL,
  app_secret text NOT NULL,
  access_token text,
  token_expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS league_accounts_appid_unique ON league_accounts (appid);

ALTER TABLE talent_window_products
  ADD COLUMN IF NOT EXISTS shop_name text,
  ADD COLUMN IF NOT EXISTS shop_score int,
  ADD COLUMN IF NOT EXISTS shop_icon text,
  ADD COLUMN IF NOT EXISTS good_evaluation_ratio int,
  ADD COLUMN IF NOT EXISTS quality_synced_at timestamptz;
