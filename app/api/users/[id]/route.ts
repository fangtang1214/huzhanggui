import bcrypt from "bcryptjs";
import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { AuthError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { accountPermissionsSchema, assertCanChangeAccountPermissions } from "@/lib/account-permissions";

const schema = z.object({ username: z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N}_.-]+$/u), name: z.string().trim().min(1).max(100), departmentId: z.string().uuid(), permissions: accountPermissionsSchema, password: z.string().min(8).max(100).optional().or(z.literal("")), mustChangePassword: z.boolean().default(false) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("users:manage"); const { id } = await context.params; const input = schema.parse(await readJson(request)); const sql = getDb();
    const [existing] = await sql`SELECT username, permissions, is_super_admin FROM users WHERE id = ${id} AND active = true`;
    if (!existing) return Response.json({ ok: false, message: "账号不存在" }, { status: 404 });
    if (existing.isSuperAdmin && !user.isSuperAdmin) throw new AuthError("普通账号不能编辑超级管理员", 403);
    const previousPermissions = Array.isArray(existing.permissions) ? existing.permissions as string[] : [];
    const nextPermissions = existing.isSuperAdmin ? previousPermissions : input.permissions;
    assertCanChangeAccountPermissions(user, previousPermissions, nextPermissions, id === user.id);
    const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : null;
    const [row] = await sql`
      UPDATE users SET username = ${input.username.toLowerCase()}, name = ${input.name}, department_id = ${input.departmentId},
        permissions = ${sql.json(nextPermissions)}, password_hash = coalesce(${passwordHash}, password_hash),
        must_change_password = CASE WHEN ${Boolean(input.password)} THEN ${input.mustChangePassword} ELSE must_change_password END,
        updated_at = now()
      WHERE id = ${id} RETURNING id, username, name, department_id, permissions
    `;
    if (input.password) await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    await writeAudit(user, "user.update", "user", id, `修改账号 ${row.username}`, { ...input, password: input.password ? "[已重置]" : undefined }, requestIp(request)); return ok(row);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("users:manage"); const { id } = await context.params;
    if (id === user.id) return Response.json({ ok: false, message: "不能停用自己的账号" }, { status: 409 });
    const sql = getDb(); const [target] = await sql`SELECT username, is_super_admin FROM users WHERE id = ${id} AND active = true`;
    if (!target) return Response.json({ ok: false, message: "账号不存在" }, { status: 404 });
    if (target.isSuperAdmin) return Response.json({ ok: false, message: "超级管理员账号不能停用" }, { status: 409 });
    const [row] = await sql`UPDATE users SET active = false, updated_at = now() WHERE id = ${id} AND active = true RETURNING username`;
    if (!row) return Response.json({ ok: false, message: "账号不存在" }, { status: 404 });
    await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    await writeAudit(user, "user.disable", "user", id, `停用账号 ${row.username}`, undefined, requestIp(request)); return ok({ disabled: true });
  } catch (error) { return apiError(error); }
}
