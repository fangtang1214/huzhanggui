import { apiError, ok, requestIp } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireSuperAdmin();
    const { id } = await context.params;
    const sql = getDb();
    const [account] = await sql`SELECT id,name,active FROM league_accounts WHERE id=${id}`;
    if (!account) return Response.json({ ok: false, message: "机构账号不存在" }, { status: 404 });
    if (!account.active) return Response.json({ ok: false, message: "请先启用该机构账号" }, { status: 409 });
    const [state] = await sql`
      INSERT INTO league_cooperative_cache_state(
        league_account_id,item_count,synced_at,sync_status,sync_requested_at
      ) VALUES(${id},0,'1970-01-01 00:00:00+00','pending',now())
      ON CONFLICT(league_account_id) DO UPDATE
      SET sync_requested_at=now(),sync_error=null,
          sync_status=CASE WHEN league_cooperative_cache_state.sync_status='running' THEN 'running' ELSE 'pending' END
      RETURNING sync_status
    `;
    await writeAudit(user, "league_account.directory_sync", "league_account", id, `手动同步机构目录 ${account.name}`, undefined, requestIp(request));
    return ok({ id, status: state.syncStatus });
  } catch (error) { return apiError(error); }
}
