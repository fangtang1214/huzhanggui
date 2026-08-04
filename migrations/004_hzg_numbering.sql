CREATE TABLE product_sku_aliases (
  alias varchar(100) PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_sku_aliases_lower_unique ON product_sku_aliases(lower(alias));
CREATE INDEX product_sku_aliases_product_idx ON product_sku_aliases(product_id);

CREATE TABLE sample_code_aliases (
  alias varchar(64) PRIMARY KEY,
  sample_id uuid NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sample_code_aliases_lower_unique ON sample_code_aliases(lower(alias));
CREATE INDEX sample_code_aliases_sample_idx ON sample_code_aliases(sample_id);

CREATE TABLE product_sample_sequences (
  product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  last_value integer NOT NULL CHECK (last_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 所有历史商品按北京时间的创建日期重新生成 HZG 基础货号。
-- 旧货号进入别名表，既修复 SP-日期-NaN，也保留旧编号搜索能力。
CREATE TEMP TABLE _hzg_product_codes ON COMMIT DROP AS
SELECT p.id AS product_id,
       (p.created_at AT TIME ZONE 'Asia/Shanghai')::date AS sku_date,
       'HZG-' || to_char(p.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD') || '-' ||
       lpad(row_number() OVER (
         PARTITION BY (p.created_at AT TIME ZONE 'Asia/Shanghai')::date
         ORDER BY p.created_at, p.id
       )::text, 3, '0') AS new_sku
FROM products p;

INSERT INTO product_sku_aliases(alias, product_id)
SELECT p.sku, p.id FROM products p
JOIN _hzg_product_codes c ON c.product_id=p.id
WHERE lower(p.sku) <> lower(c.new_sku)
ON CONFLICT DO NOTHING;

UPDATE products SET sku='MIG-P-' || replace(id::text, '-', '');
UPDATE products p SET sku=c.new_sku
FROM _hzg_product_codes c WHERE c.product_id=p.id;

DELETE FROM product_sku_sequences;
INSERT INTO product_sku_sequences(sku_date,last_value)
SELECT sku_date,count(*)::int FROM _hzg_product_codes GROUP BY sku_date;

-- 每件历史实物改成“商品基础货号-件序号”；旧二维码编号作为别名继续可用。
CREATE TEMP TABLE _hzg_sample_codes ON COMMIT DROP AS
SELECT s.id AS sample_id, s.product_id,
       row_number() OVER (PARTITION BY s.product_id ORDER BY s.created_at, s.id) AS sequence,
       p.sku || '-' || lpad(row_number() OVER (
         PARTITION BY s.product_id ORDER BY s.created_at, s.id
       )::text, 3, '0') AS new_code
FROM samples s JOIN products p ON p.id=s.product_id;

INSERT INTO sample_code_aliases(alias,sample_id)
SELECT s.code,s.id FROM samples s
JOIN _hzg_sample_codes c ON c.sample_id=s.id
WHERE lower(s.code) <> lower(c.new_code)
ON CONFLICT DO NOTHING;

UPDATE samples SET code='MIG-S-' || replace(id::text, '-', '');
UPDATE samples s SET code=c.new_code
FROM _hzg_sample_codes c WHERE c.sample_id=s.id;

INSERT INTO product_sample_sequences(product_id,last_value)
SELECT product_id,max(sequence)::int FROM _hzg_sample_codes GROUP BY product_id;
