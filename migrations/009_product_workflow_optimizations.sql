-- 商品复制配置按账号保存；默认复制主图、价格和商品链接。
ALTER TABLE users
  ADD COLUMN product_copy_config jsonb NOT NULL DEFAULT '{"order":["image","sku","name","departments","businessContact","storeName","price","commission","storeRating","productUrl","supplyChain","cooperationMechanism","category","tags","notes","createdAt","updatedAt"],"enabled":["image","price","productUrl"]}'::jsonb;

-- 业务不再使用“已消耗”和“已报废”。迁移前若意外存在这些状态则中止，避免静默改写历史数据。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM samples WHERE status IN ('consumed', 'scrapped')) THEN
    RAISE EXCEPTION '仍有样品处于已消耗或已报废状态，请先确认历史数据处理方式';
  END IF;
END $$;

ALTER TABLE samples DROP CONSTRAINT IF EXISTS samples_status_check;
ALTER TABLE samples
  ADD CONSTRAINT samples_status_check
  CHECK (status IN ('active', 'returned', 'damaged', 'lost', 'gifted'));
