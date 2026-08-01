import { apiError, ok, requestIp } from "@/lib/api";
import { destroySession, getCurrentUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (user) await writeAudit(user, "auth.logout", "session", null, "退出系统", undefined, requestIp(request));
    await destroySession();
    return ok({ loggedOut: true });
  } catch (error) {
    return apiError(error);
  }
}

