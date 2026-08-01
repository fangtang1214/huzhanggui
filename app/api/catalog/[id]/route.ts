import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({ type: z.enum(["category", "tag"]), name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("catalog:manage"); const input = schema.parse(await readJson(request)); const { id } = await context.params; const sql = getDb();
    const [row] = input.type === "category"
      ? await sql`UPDATE categories SET name = ${input.name} WHERE id = ${id} AND active = true RETURNING *`
      : await sql`UPDATE tags SET name = ${input.name}, color = ${input.color || '#56736a'} WHERE id = ${id} AND active = true RETURNING *`;
    if (!row) return Response.json({ ok: false, message: "数据不存在" }, { status: 404 });
    await writeAudit(user, `${input.type}.update`, input.type, id, `修改${input.type === 'category' ? '分类' : '标签'} ${input.name}`, input, requestIp(request)); return ok(row);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("catalog:manage"); const { id } = await context.params; const url = new URL(request.url); const type = url.searchParams.get("type"); const sql = getDb();
    if (type !== "category" && type !== "tag") return Response.json({ ok: false, message: "类型不正确" }, { status: 400 });
    const [row] = type === "category" ? await sql`UPDATE categories SET active = false WHERE id = ${id} RETURNING name` : await sql`UPDATE tags SET active = false WHERE id = ${id} RETURNING name`;
    if (!row) return Response.json({ ok: false, message: "数据不存在" }, { status: 404 });
    await writeAudit(user, `${type}.disable`, type, id, `停用${type === 'category' ? '分类' : '标签'} ${row.name}`, undefined, requestIp(request)); return ok({ disabled: true });
  } catch (error) { return apiError(error); }
}

