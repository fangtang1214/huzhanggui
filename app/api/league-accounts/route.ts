import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireSuperAdmin, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const accountSchema = z.object({
  name: z.string().trim().min(1, "请填写账号名称").max(100),
  appid: z.string().trim().min(1, "请填写机构 AppID").max(80).regex(/^[a-zA-Z0-9_-]+$/, "AppID 格式不正确"),
  appSecret: z.string().trim().min(1, "请填写 AppSecret").max(200),
});

export async function GET(request: Request) {
  try {
    if (new URL(request.url).searchParams.get("minimal") === "1") {
      await requireUser();
      const sql = getDb();
      const rows = await sql`SELECT id, name, active FROM league_accounts WHERE active = true ORDER BY name`;
      return ok(rows);
    }
    await requireSuperAdmin();
    const sql = getDb();
    const rows = await sql`
      SELECT a.id, a.name, a.appid, a.active, a.created_at, u.name AS created_by_name
      FROM league_accounts a LEFT JOIN users u ON u.id = a.created_by
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
      INSERT INTO league_accounts (name, appid, app_secret, created_by)
      VALUES (${input.name}, ${input.appid}, ${input.appSecret}, ${user.id})
      RETURNING id, name, appid, active, created_at
    `;
    await writeAudit(user, "league_account.create", "league_account", row.id, `添加机构账号 ${row.name}（${row.appid}）`, { name: input.name, appid: input.appid }, requestIp(request));
    return created(row);
  } catch (error) { return apiError(error); }
}
