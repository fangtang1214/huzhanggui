import bcrypt from "bcryptjs";
import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({
  username: z.string().trim().min(2, "账号至少 2 位").max(80).regex(/^[\p{L}\p{N}_.-]+$/u, "账号只能包含文字、数字、点、横线或下划线"),
  name: z.string().trim().min(1, "请填写姓名").max(100),
  password: z.string().min(8, "密码至少需要 8 位").max(100),
  departmentId: z.string().uuid(),
  roleId: z.string().uuid(),
  mustChangePassword: z.boolean().default(true),
});

export async function GET() {
  try {
    await requireUser("users:view"); const sql = getDb();
    const rows = await sql`
      SELECT u.id, u.username, u.name, u.department_id, d.name AS department_name,
             u.role_id, r.name AS role_name, u.active, u.must_change_password,
             u.last_login_at, u.created_at
      FROM users u JOIN departments d ON d.id = u.department_id JOIN roles r ON r.id = u.role_id
      WHERE u.active = true ORDER BY d.name, u.name
    `;
    return ok(rows);
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("users:manage"); const input = schema.parse(await readJson(request)); const sql = getDb();
    const passwordHash = await bcrypt.hash(input.password, 12);
    const [row] = await sql`
      INSERT INTO users(username, name, password_hash, department_id, role_id, must_change_password)
      VALUES (${input.username.toLowerCase()}, ${input.name}, ${passwordHash}, ${input.departmentId}, ${input.roleId}, ${input.mustChangePassword})
      RETURNING id, username, name, department_id, role_id
    `;
    await writeAudit(user, "user.create", "user", row.id, `创建账号 ${row.username}`, { ...input, password: "[已隐藏]" }, requestIp(request)); return created(row);
  } catch (error) { return apiError(error); }
}

