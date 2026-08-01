import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["business", "live_room", "management", "other"]),
  description: z.string().trim().max(500).optional().nullable(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("departments:manage");
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const [row] = await sql`
      UPDATE departments SET name = ${input.name}, kind = ${input.kind}, description = ${input.description || null}, updated_at = now()
      WHERE id = ${id} AND active = true RETURNING *
    `;
    if (!row) return Response.json({ ok: false, message: "部门不存在" }, { status: 404 });
    await writeAudit(user, "department.update", "department", id, `修改部门 ${row.name}`, input, requestIp(request));
    return ok(row);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("departments:manage");
    const { id } = await context.params;
    if (id === user.departmentId) return Response.json({ ok: false, message: "不能停用自己所属的部门" }, { status: 409 });
    const sql = getDb();
    const [usage] = await sql`
      SELECT (SELECT count(*) FROM users WHERE department_id = ${id} AND active = true)::int AS users,
             (SELECT count(*) FROM samples WHERE current_department_id = ${id} AND status = 'active' AND archived = false)::int AS samples
    `;
    if (usage.users > 0 || usage.samples > 0) return Response.json({ ok: false, message: "部门仍有账号或样品，暂时不能删除" }, { status: 409 });
    const [row] = await sql`UPDATE departments SET active = false, updated_at = now() WHERE id = ${id} RETURNING name`;
    if (!row) return Response.json({ ok: false, message: "部门不存在" }, { status: 404 });
    await writeAudit(user, "department.disable", "department", id, `停用部门 ${row.name}`, undefined, requestIp(request));
    return ok({ disabled: true });
  } catch (error) { return apiError(error); }
}

