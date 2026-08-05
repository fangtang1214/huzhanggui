DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm extension not available, skipping trigram indexes';
    RETURN;
  END;

  CREATE INDEX IF NOT EXISTS idx_products_sku_trgm ON products USING gin (sku gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_products_store_name_trgm ON products USING gin (store_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_products_product_url_trgm ON products USING gin (product_url gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_product_sku_aliases_alias_trgm ON product_sku_aliases USING gin (alias gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_product_link_history_url_trgm ON product_link_history USING gin (url gin_trgm_ops);
END
$$;
