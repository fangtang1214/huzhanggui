import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { ALL_PERMISSIONS, PERMISSION_GROUPS } from "@/lib/permissions";

const schema = z.object({
  name: z.string().trim().min(1, "请填写角色名称").max(100),
  description: z.string().trim().max(500).optional().nullable(),
  permissions: z.array(z.string()).refine((items) => items.every((item) => ALL_PERMISSIONS.includes(item as never)), "包含无效权限"),
  dataScope: z.enum(["all", "department"]),
});

export async function GET() {
  try {
    await requireUser("roles:view"); const sql = getDb();
    const rows = await sql`
      SELECT r.*, count(u.id) FILTER (WHERE u.active = true)::int AS user_count
      FROM roles r LEFT JOIN users u ON u.role_id = r.id
      WHERE r.active = true GROUP BY r.id ORDER BY r.is_system DESC, r.name
    `;
    return ok({ rows, permissionGroups: PERMISSION_GROUPS });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("roles:manage"); const input = schema.parse(await readJson(request)); const sql = getDb();
    const [row] = await sql`
      INSERT INTO roles(name, description, permissions, data_scope)
      VALUES (${input.name}, ${input.description || null}, ${sql.json(input.permissions)}, ${input.dataScope}) RETURNING *
    `;
    await writeAudit(user, "role.create", "role", row.id, `创建角色 ${row.name}`, input, requestIp(request)); return created(row);
  } catch (error) { return apiError(error); }
}

