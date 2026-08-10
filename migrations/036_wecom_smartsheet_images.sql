ALTER TABLE wecom_smartsheet_sync_state
  ADD COLUMN IF NOT EXISTS image_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS image_error text;
