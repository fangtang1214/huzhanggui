import bcrypt from "bcryptjs";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("缺少 DATABASE_URL 环境变量");

const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const adminName = (process.env.ADMIN_NAME || "系统管理员").trim();
const permissions = ["*"];
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  await sql.begin(async (tx) => {
    const [department] = await tx`
      INSERT INTO departments (name, kind, description)
      VALUES ('管理部', 'management', '系统管理账号所属部门')
      ON CONFLICT ((lower(name))) DO UPDATE SET active = true
      RETURNING id
    `;
    await tx`
      INSERT INTO departments (name, kind, description)
      VALUES ('商务部', 'business', '样品到货登记与存放部门')
      ON CONFLICT ((lower(name))) DO UPDATE SET active = true
    `;
    const [role] = await tx`
      INSERT INTO roles (name, description, permissions, data_scope, is_system)
      VALUES ('超级管理员', '拥有系统全部权限', ${tx.json(permissions)}, 'all', true)
      ON CONFLICT ((lower(name))) DO UPDATE
      SET permissions = EXCLUDED.permissions, data_scope = 'all', active = true
      RETURNING id
    `;
    const existing = await tx`SELECT id FROM users WHERE lower(username) = ${username}`;
    if (existing.length === 0) {
      const passwordHash = await bcrypt.hash(password, 12);
      await tx`
        INSERT INTO users (username, name, password_hash, department_id, role_id)
        VALUES (${username}, ${adminName}, ${passwordHash}, ${department.id}, ${role.id})
      `;
      console.log(`已创建初始管理员：${username}`);
    }
    await tx`
      INSERT INTO app_settings (key, value)
      VALUES ('company', ${tx.json({ name: "狐掌柜-直播样品管理系统" })})
      ON CONFLICT (key) DO NOTHING
    `;
  });
} finally {
  await sql.end();
}
