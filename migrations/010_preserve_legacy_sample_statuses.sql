-- 兼容曾成功执行 009 旧版本的安装：数据库允许读取历史状态，应用接口不再允许新选择这些状态。
ALTER TABLE samples DROP CONSTRAINT IF EXISTS samples_status_check;
ALTER TABLE samples
  ADD CONSTRAINT samples_status_check
  CHECK (status IN ('active', 'returned', 'consumed', 'damaged', 'lost', 'gifted', 'scrapped'));
