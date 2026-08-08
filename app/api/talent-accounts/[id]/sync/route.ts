import { apiError, ok, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { runTalentWindowSync } from "@/lib/talent-window";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireUser("products:create");
    const { id } = await context.params;
    const sql = getDb();
    const claimed = await sql`
      UPDATE talent_accounts
      SET sync_status = 'syncing', sync_error = null, updated_at = now()
      WHERE id = ${id} AND active = true AND (sync_status <> 'syncing' OR updated_at < now() - interval '15 minutes')
      RETURNING id, name
    `;
    if (!claimed.length) {
      const [existing] = await sql`SELECT sync_status, active FROM talent_accounts WHERE id = ${id}`;
      if (!existing) return Response.json({ ok: false, message: "带货账号不存在" }, { status: 404 });
      if (!existing.active) return Response.json({ ok: false, message: "带货账号已停用" }, { status: 400 });
      return Response.json({ ok: false, message: "该账号正在同步中，请稍候" }, { status: 409 });
    }
    await writeAudit(user, "talent_account.sync", "talent_account", id, `同步橱窗商品 ${claimed[0].name}`, null, requestIp(request));
    void runTalentWindowSync(id).catch((error) => console.error("橱窗同步失败", error));
    return ok({ id, syncing: true });
  } catch (error) { return apiError(error); }
}
