import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const updateSchema = z.object({
  name: z.string().trim().min(1, "请填写账号名称").max(100),
  appid: z.string().trim().min(1, "请填写机构 AppID").max(80).regex(/^[a-zA-Z0-9_-]+$/, "AppID 格式不正确"),
  appSecret: z.string().trim().max(200).optional(),
  active: z.boolean(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await requireSuperAdmin();
    const { id } = await context.params;
    const input = updateSchema.parse(await readJson(request));
    const sql = getDb();
    const secretChanging = Boolean(input.appSecret);
    const [row] = await sql`
      UPDATE league_accounts
      SET name = ${input.name}, appid = ${input.appid}, active = ${input.active},
          app_secret = coalesce(${input.appSecret || null}, app_secret),
          access_token = CASE WHEN ${secretChanging} OR appid <> ${input.appid} THEN null ELSE access_token END,
          token_expires_at = CASE WHEN ${secretChanging} OR appid <> ${input.appid} THEN null ELSE token_expires_at END,
          updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, appid, active
    `;
    if (!row) return Response.json({ ok: false, message: "机构账号不存在" }, { status: 404 });
    await writeAudit(user, "league_account.update", "league_account", id, `更新机构账号 ${row.name}（${row.appid}）${secretChanging ? "，已重置密钥" : ""}`, { name: input.name, appid: input.appid, active: input.active, secretChanged: secretChanging }, requestIp(request));
    return ok(row);
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const user = await requireSuperAdmin();
    const { id } = await context.params;
    const sql = getDb();
    const [row] = await sql`DELETE FROM league_accounts WHERE id = ${id} RETURNING name, appid`;
    if (!row) return Response.json({ ok: false, message: "机构账号不存在" }, { status: 404 });
    await writeAudit(user, "league_account.delete", "league_account", id, `删除机构账号 ${row.name}（${row.appid}）`, null, requestIp(request));
    return ok({ id });
  } catch (error) { return apiError(error); }
}
