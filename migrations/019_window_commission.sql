ALTER TABLE talent_window_products
  ADD COLUMN IF NOT EXISTS commission_ratio int,
  ADD COLUMN IF NOT EXISTS normal_commission_ratio int,
  ADD COLUMN IF NOT EXISTS service_ratio int,
  ADD COLUMN IF NOT EXISTS commission_type int,
  ADD COLUMN IF NOT EXISTS plan_type int;
