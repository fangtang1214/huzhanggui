import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { authenticate, createSession, getCurrentUser, validateCsrf } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { checkLoginLimit, clearLoginFailures, loginLimitKey, recordLoginFailure } from "@/lib/rate-limit";

const schema = z.object({
  username: z.string().trim().min(1, "请输入账号"),
  password: z.string().min(1, "请输入密码"),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    await validateCsrf(request);
    const ip = requestIp(request);
    const limitKey = loginLimitKey(ip, input.username);
    const limit = await checkLoginLimit(limitKey);
    if (!limit.allowed) {
      return Response.json({ ok: false, message: "登录尝试过多，请 15 分钟后再试" }, { status: 429, headers: { "retry-after": String(limit.retryAfter) } });
    }
    const userId = await authenticate(input.username, input.password);
    if (!userId) {
      await recordLoginFailure(limitKey);
      await writeAudit(null, "auth.login_failed", "session", null, `账号 ${input.username} 登录失败`, undefined, ip);
      return Response.json({ ok: false, message: "账号或密码不正确" }, { status: 401 });
    }
    await clearLoginFailures(limitKey);
    await createSession(userId);
    const user = await getCurrentUser();
    await writeAudit(user, "auth.login", "session", null, "登录系统", undefined, ip);
    return ok(user);
  } catch (error) {
    return apiError(error);
  }
}
