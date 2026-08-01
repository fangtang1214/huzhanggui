import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { ALL_PERMISSIONS } from "@/lib/permissions";

const schema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).optional().nullable(), permissions: z.array(z.string()).refine((items) => items.every((item) => ALL_PERMISSIONS.includes(item as never)), "包含无效权限"), dataScope: z.enum(["all", "department"]) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("roles:manage"); const { id } = await context.params; const input = schema.parse(await readJson(request)); const sql = getDb();
    const [existing] = await sql`SELECT is_system FROM roles WHERE id = ${id} AND active = true`;
    if (!existing) return Response.json({ ok: false, message: "角色不存在" }, { status: 404 });
    if (existing.isSystem) return Response.json({ ok: false, message: "系统管理员角色不能修改" }, { status: 409 });
    const [row] = await sql`UPDATE roles SET name = ${input.name}, description = ${input.description || null}, permissions = ${sql.json(input.permissions)}, data_scope = ${input.dataScope}, updated_at = now() WHERE id = ${id} RETURNING *`;
    await writeAudit(user, "role.update", "role", id, `修改角色 ${row.name}`, input, requestIp(request)); return ok(row);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("roles:manage"); const { id } = await context.params; const sql = getDb();
    const [role] = await sql`SELECT name, is_system FROM roles WHERE id = ${id} AND active = true`;
    if (!role) return Response.json({ ok: false, message: "角色不存在" }, { status: 404 });
    if (role.isSystem) return Response.json({ ok: false, message: "系统管理员角色不能删除" }, { status: 409 });
    const [usage] = await sql`SELECT count(*)::int AS count FROM users WHERE role_id = ${id} AND active = true`;
    if (usage.count > 0) return Response.json({ ok: false, message: "该角色仍有账号，不能删除" }, { status: 409 });
    await sql`UPDATE roles SET active = false, updated_at = now() WHERE id = ${id}`;
    await writeAudit(user, "role.disable", "role", id, `停用角色 ${role.name}`, undefined, requestIp(request)); return ok({ disabled: true });
  } catch (error) { return apiError(error); }
}

