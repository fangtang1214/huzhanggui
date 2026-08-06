import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const accountSchema = z.object({
  name: z.string().trim().min(1, "请填写账号名称").max(100),
  appid: z.string().trim().min(1, "请填写带货者 AppID").max(80).regex(/^[a-zA-Z0-9_-]+$/, "AppID 格式不正确"),
  appSecret: z.string().trim().min(1, "请填写 AppSecret").max(200),
});

export async function GET() {
  try {
    await requireSuperAdmin();
    const sql = getDb();
    const rows = await sql`
      SELECT a.id, a.name, a.appid, a.active, a.sync_status, a.sync_error, a.synced_at, a.created_at,
             u.name AS created_by_name,
             (SELECT count(*)::int FROM talent_window_products w WHERE w.account_id = a.id) AS product_count
      FROM talent_accounts a LEFT JOIN users u ON u.id = a.created_by
      ORDER BY a.created_at
    `;
    return ok(rows);
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin();
    const input = accountSchema.parse(await readJson(request));
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO talent_accounts (name, appid, app_secret, created_by)
      VALUES (${input.name}, ${input.appid}, ${input.appSecret}, ${user.id})
      RETURNING id, name, appid, active, sync_status, synced_at, created_at
    `;
    await writeAudit(user, "talent_account.create", "talent_account", row.id, `添加带货账号 ${row.name}（${row.appid}）`, { name: input.name, appid: input.appid }, requestIp(request));
    return created(row);
  } catch (error) { return apiError(error); }
}
