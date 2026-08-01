import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({ departmentId: z.string().uuid(), name: z.string().trim().min(1).max(100), code: z.string().trim().max(50).optional().nullable(), description: z.string().trim().max(500).optional().nullable() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("locations:manage"); const { id } = await context.params;
    const input = schema.parse(await readJson(request)); const sql = getDb();
    const [row] = await sql`UPDATE locations SET department_id = ${input.departmentId}, name = ${input.name}, code = ${input.code || null}, description = ${input.description || null}, updated_at = now() WHERE id = ${id} AND active = true RETURNING *`;
    if (!row) return Response.json({ ok: false, message: "位置不存在" }, { status: 404 });
    await writeAudit(user, "location.update", "location", id, `修改位置 ${row.name}`, input, requestIp(request)); return ok(row);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("locations:manage"); const { id } = await context.params; const sql = getDb();
    const [usage] = await sql`SELECT count(*)::int AS count FROM samples WHERE current_location_id = ${id} AND status = 'active' AND archived = false`;
    if (usage.count > 0) return Response.json({ ok: false, message: "该位置仍有样品，不能删除" }, { status: 409 });
    const [row] = await sql`UPDATE locations SET active = false, updated_at = now() WHERE id = ${id} RETURNING name`;
    if (!row) return Response.json({ ok: false, message: "位置不存在" }, { status: 404 });
    await writeAudit(user, "location.disable", "location", id, `停用位置 ${row.name}`, undefined, requestIp(request)); return ok({ disabled: true });
  } catch (error) { return apiError(error); }
}

