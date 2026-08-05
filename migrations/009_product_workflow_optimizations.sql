-- 商品复制配置按账号保存；默认复制主图、价格和商品链接。
ALTER TABLE users
  ADD COLUMN product_copy_config jsonb NOT NULL DEFAULT '{"order":["image","sku","name","departments","businessContact","storeName","price","commission","storeRating","productUrl","supplyChain","cooperationMechanism","category","tags","notes","createdAt","updatedAt"],"enabled":["image","price","productUrl"]}'::jsonb;

-- “已消耗”和“已报废”从可选业务状态中移除，但历史数据保持原样，避免升级阻断或改写记录。
