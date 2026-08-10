import { apiError, ok, requestIp } from "@/lib/api";
import { ensureCsrfCookie, requireSuperAdmin, validateCsrf } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  createWecomSheetToken,
  hashWecomSheetToken,
  WECOM_SHEET_CSV_PATH,
  WECOM_SHEET_SETTING_KEY,
  wecomSheetUrl,
} from "@/lib/wecom-sheet";

export const dynamic = "force-dynamic";

function publicOrigin(request: Request) {
  return (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

async function status() {
  const sql = getDb();
  const [setting] = await sql`
    SELECT value, updated_at
    FROM app_settings
    WHERE key = ${WECOM_SHEET_SETTING_KEY}
    LIMIT 1
  `;
  const [count] = await sql`SELECT count(*)::int AS count FROM products WHERE archived = false`;
  return {
    enabled: Boolean(setting?.value?.tokenHash),
    updatedAt: setting?.updatedAt || null,
    productCount: Number(count?.count || 0),
    endpointPath: WECOM_SHEET_CSV_PATH,
    fields: ["货号", "商品名称", "价格", "商品链接", "主图链接", "更新时间"],
  };
}

export async function GET() {
  try {
    await requireSuperAdmin();
    await ensureCsrfCookie();
    return ok(await status());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    await validateCsrf(request);
    const user = await requireSuperAdmin();
    const sql = getDb();
    const token = createWecomSheetToken();
    const tokenHash = hashWecomSheetToken(token);
    const configuredAt = new Date().toISOString();
    await sql`
      INSERT INTO app_settings(key, value, updated_at)
      VALUES (${WECOM_SHEET_SETTING_KEY}, ${sql.json({ tokenHash, configuredAt })}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    await writeAudit(user, "wecom_sheet.token_rotated", "app_setting", WECOM_SHEET_SETTING_KEY, "生成企业微信表格商品库同步密钥", undefined, requestIp(request));
    const url = wecomSheetUrl(publicOrigin(request), token);
    return ok({ ...(await status()), url, importFormula: `=IMPORTDATA("${url}")` });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await validateCsrf(request);
    const user = await requireSuperAdmin();
    const sql = getDb();
    await sql`DELETE FROM app_settings WHERE key = ${WECOM_SHEET_SETTING_KEY}`;
    await writeAudit(user, "wecom_sheet.disabled", "app_setting", WECOM_SHEET_SETTING_KEY, "停用企业微信表格商品库同步接口", undefined, requestIp(request));
    return ok(await status());
  } catch (error) {
    return apiError(error);
  }
}
