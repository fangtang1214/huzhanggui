-- 带货商品需要保留货源小店商品 ID，用于联盟机构匹配。
-- talent_window_products.product_id 仍是橱窗内部 ID；带货商品对外统一使用 out_product_id。
ALTER TABLE talent_window_products
  ADD COLUMN IF NOT EXISTS out_product_id text;

CREATE INDEX IF NOT EXISTS talent_window_products_out_product_idx
ON talent_window_products (out_product_id)
WHERE out_product_id IS NOT NULL;
