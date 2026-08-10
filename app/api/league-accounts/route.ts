import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireSuperAdmin, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const accountSchema = z.object({
  name: z.string().trim().min(1, "请填写账号名称").max(100),
  appid: z.string().trim().min(1, "请填写机构 AppID").max(80).regex(/^[a-zA-Z0-9_-]+$/, "AppID 格式不正确"),
  appSecret: z.string().trim().min(1, "请填写 AppSecret").max(200),
  isPrimary: z.boolean().optional().default(false),
});

export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("minimal") === "1") {
      await requireUser();
      const sql = getDb();
      const rows = await sql`SELECT id, name, active, is_primary FROM league_accounts WHERE active = true ORDER BY is_primary DESC, name`;
      return ok(rows);
    }
    await requireSuperAdmin();
    const sql = getDb();
    const rows = await sql`
       SELECT a.id, a.name, a.appid, a.active, a.is_primary, a.created_at, u.name AS created_by_name,
              state.item_count AS directory_item_count,
              CASE WHEN state.synced_at > '1970-01-02 00:00:00+00' THEN state.synced_at ELSE null END AS directory_synced_at,
              coalesce(state.sync_status, CASE WHEN a.active THEN 'pending' ELSE 'idle' END) AS directory_sync_status,
              state.sync_error AS directory_sync_error,
              state.sync_started_at AS directory_sync_started_at,
              state.sync_progress_count AS directory_sync_progress_count,
              state.sync_heartbeat_at AS directory_sync_heartbeat_at
       FROM league_accounts a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN league_cooperative_cache_state state ON state.league_account_id = a.id
       ORDER BY a.is_primary DESC, a.created_at
    `;
    return ok(rows);
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin();
    const input = accountSchema.parse(await readJson(request));
    const sql = getDb();
    const row = await sql.begin(async (tx) => {
      if (input.isPrimary) await tx`UPDATE league_accounts SET is_primary = false, updated_at = now() WHERE is_primary = true`;
      const [createdAccount] = await tx`
        INSERT INTO league_accounts (name, appid, app_secret, is_primary, created_by)
        VALUES (${input.name}, ${input.appid}, ${input.appSecret}, ${input.isPrimary}, ${user.id})
        RETURNING id, name, appid, active, is_primary, created_at
      `;
      await tx`
        INSERT INTO league_cooperative_cache_state(
          league_account_id, item_count, synced_at, sync_status, sync_requested_at
        ) VALUES(${createdAccount.id}, 0, '1970-01-01 00:00:00+00', 'pending', now())
        ON CONFLICT(league_account_id) DO UPDATE
        SET sync_requested_at=now(),sync_status=CASE WHEN league_cooperative_cache_state.sync_status='running' THEN 'running' ELSE 'pending' END
      `;
      return createdAccount;
    });
    await writeAudit(user, "league_account.create", "league_account", row.id, `添加机构账号 ${row.name}（${row.appid}）`, { name: input.name, appid: input.appid }, requestIp(request));
    return created(row);
  } catch (error) { return apiError(error); }
}
