-- 角色权限迁移为账号直接授权；超级管理员改为账号自身的系统标记。
ALTER TABLE users ADD COLUMN permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false;

UPDATE users u
SET permissions = coalesce((
      SELECT jsonb_agg(permission)
      FROM jsonb_array_elements_text(r.permissions) AS permissions_list(permission)
      WHERE permission NOT IN ('*', 'roles:view', 'roles:manage')
    ), '[]'::jsonb),
    is_super_admin = r.is_system
FROM roles r
WHERE r.id = u.role_id;

-- 系统只允许存在一个固定超级管理员账号。
CREATE UNIQUE INDEX users_single_super_admin_unique
  ON users(is_super_admin)
  WHERE is_super_admin = true;

DROP INDEX users_role_idx;
ALTER TABLE users DROP COLUMN role_id;
DROP TABLE roles;
