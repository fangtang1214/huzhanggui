import bcrypt from "bcryptjs";
import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

export async function GET() {
  try {
    return ok(await getCurrentUser());
  } catch (error) {
    return apiError(error);
  }
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(8, "新密码至少需要 8 位").max(100),
});

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const input = passwordSchema.parse(await readJson(request));
    const sql = getDb();
    const [account] = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
    if (!account || !(await bcrypt.compare(input.currentPassword, account.passwordHash))) {
      return Response.json({ ok: false, message: "当前密码不正确" }, { status: 400 });
    }
    const passwordHash = await bcrypt.hash(input.newPassword, 12);
    await sql`
      UPDATE users SET password_hash = ${passwordHash}, must_change_password = false, updated_at = now()
      WHERE id = ${user.id}
    `;
    await writeAudit(user, "user.change_password", "user", user.id, "修改自己的登录密码", undefined, requestIp(request));
    return ok({ changed: true });
  } catch (error) {
    return apiError(error);
  }
}

