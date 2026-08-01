CREATE TABLE product_sku_sequences (
  sku_date date PRIMARY KEY,
  last_value integer NOT NULL CHECK (last_value > 0)
);

ALTER TABLE products ADD COLUMN version bigint NOT NULL DEFAULT 1;

CREATE TABLE product_image_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  url_hash char(64) NOT NULL,
  model varchar(120) NOT NULL DEFAULT 'Xenova/clip-vit-base-patch32',
  embedding real[],
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, url_hash)
);
CREATE INDEX product_image_features_status_idx ON product_image_features(status, updated_at);
CREATE INDEX product_image_features_product_idx ON product_image_features(product_id);

CREATE TABLE image_match_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  image_url text NOT NULL,
  image_url_hash char(64) NOT NULL,
  threshold_mode varchar(20) NOT NULL DEFAULT 'standard'
    CHECK (threshold_mode IN ('strict', 'standard', 'relaxed')),
  threshold real NOT NULL,
  status varchar(20) NOT NULL
    CHECK (status IN ('matched', 'no_match', 'failed')),
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  decision varchar(30) NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'matched', 'new', 'failed_continue')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX image_match_runs_user_idx ON image_match_runs(user_id, created_at DESC);
CREATE INDEX image_match_runs_created_idx ON image_match_runs(created_at DESC);

CREATE TABLE product_intake_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  match_run_id uuid REFERENCES image_match_runs(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  sample_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_data jsonb NOT NULL,
  previous_product_data jsonb,
  merged_product_version bigint,
  status varchar(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'corrected')),
  corrected_product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  corrected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  correction_note text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_intake_batches_product_idx ON product_intake_batches(product_id, created_at DESC);
CREATE INDEX product_intake_batches_status_idx ON product_intake_batches(status, created_at DESC);

INSERT INTO app_settings (key, value)
VALUES ('image_matching', '{"mode":"standard","model":"Xenova/clip-vit-base-patch32"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
