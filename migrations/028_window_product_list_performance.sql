CREATE INDEX IF NOT EXISTS talent_window_products_account_synced_product_idx
ON talent_window_products (account_id, synced_at DESC, product_id DESC);

CREATE INDEX IF NOT EXISTS talent_window_products_pending_promotion_idx
ON talent_window_products (account_id, synced_at DESC, product_id DESC)
WHERE promotion_status IN ('needs_choice', 'needs_replacement');
