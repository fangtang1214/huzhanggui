-- 商品货号升级为 HZG-年份-四位年度序号，实物继续追加三位独立序号。
-- 当前编号先写入别名表，因此旧搜索、旧标签和旧二维码仍然可用。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products
    GROUP BY date_trunc('year', created_at AT TIME ZONE 'Asia/Shanghai')
    HAVING count(*) > 9999
  ) THEN
    RAISE EXCEPTION '单年度商品数量超过 9999，无法迁移为四位年度序号';
  END IF;
END $$;

CREATE TEMP TABLE _hzg_year_product_codes ON COMMIT DROP AS
SELECT p.id AS product_id,
       date_trunc('year', p.created_at AT TIME ZONE 'Asia/Shanghai')::date AS sequence_date,
       'HZG-' || to_char(p.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY') || '-' ||
       lpad(row_number() OVER (
         PARTITION BY date_trunc('year', p.created_at AT TIME ZONE 'Asia/Shanghai')
         ORDER BY p.created_at, p.id
       )::text, 4, '0') AS new_sku
FROM products p;

INSERT INTO product_sku_aliases(alias, product_id)
SELECT p.sku, p.id
FROM products p
JOIN _hzg_year_product_codes c ON c.product_id=p.id
WHERE lower(p.sku) <> lower(c.new_sku)
ON CONFLICT DO NOTHING;

UPDATE products SET sku='MIG-Y-P-' || replace(id::text, '-', '');
UPDATE products p SET sku=c.new_sku
FROM _hzg_year_product_codes c WHERE c.product_id=p.id;

DELETE FROM product_sku_sequences;
INSERT INTO product_sku_sequences(sku_date,last_value)
SELECT sequence_date,count(*)::int
FROM _hzg_year_product_codes
GROUP BY sequence_date;

CREATE TEMP TABLE _hzg_year_sample_codes ON COMMIT DROP AS
SELECT s.id AS sample_id,
       p.sku || '-' || lpad(row_number() OVER (
         PARTITION BY s.product_id ORDER BY s.created_at,s.id
       )::text,3,'0') AS new_code,
       row_number() OVER (
         PARTITION BY s.product_id ORDER BY s.created_at,s.id
       )::int AS sample_sequence
FROM samples s
JOIN products p ON p.id=s.product_id;

INSERT INTO sample_code_aliases(alias,sample_id)
SELECT s.code,s.id
FROM samples s
JOIN _hzg_year_sample_codes c ON c.sample_id=s.id
WHERE lower(s.code) <> lower(c.new_code)
ON CONFLICT DO NOTHING;

UPDATE samples SET code='MIG-Y-S-' || replace(id::text, '-', '');
UPDATE samples s SET code=c.new_code
FROM _hzg_year_sample_codes c WHERE c.sample_id=s.id;

DELETE FROM product_sample_sequences;
INSERT INTO product_sample_sequences(product_id,last_value)
SELECT s.product_id,max(c.sample_sequence)
FROM samples s
JOIN _hzg_year_sample_codes c ON c.sample_id=s.id
GROUP BY s.product_id;
