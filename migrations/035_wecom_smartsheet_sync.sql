CREATE TABLE IF NOT EXISTS wecom_smartsheet_product_records (
  config_id uuid NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (config_id, product_id),
  UNIQUE (config_id, record_id)
);

CREATE INDEX IF NOT EXISTS wecom_smartsheet_records_product_idx
  ON wecom_smartsheet_product_records(product_id);

CREATE TABLE IF NOT EXISTS wecom_smartsheet_sync_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  config_id uuid,
  sync_status varchar(20) NOT NULL DEFAULT 'idle'
    CHECK (sync_status IN ('idle', 'pending', 'running', 'failed')),
  sync_requested_at timestamptz,
  sync_started_at timestamptz,
  sync_heartbeat_at timestamptz,
  synced_at timestamptz,
  sync_error text,
  total_count integer NOT NULL DEFAULT 0,
  progress_count integer NOT NULL DEFAULT 0,
  added_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wecom_smartsheet_sync_state(singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

-- 普通在线表格不支持外部取数公式，停用旧的公开 CSV 密钥。
DELETE FROM app_settings
WHERE key = 'wecom_sheet_sync' AND value ? 'tokenHash';
