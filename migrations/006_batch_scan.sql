-- 批量流转沿用“修改位置或状态”权限，不再维护单独的批量权限。
UPDATE roles
SET permissions = permissions - 'samples:batch', updated_at = now()
WHERE permissions ? 'samples:batch';

-- 客户端重试同一批次时，不允许为同一样品重复生成流转记录。
CREATE UNIQUE INDEX IF NOT EXISTS sample_movements_batch_sample_unique
  ON sample_movements(batch_id, sample_id)
  WHERE batch_id IS NOT NULL;
