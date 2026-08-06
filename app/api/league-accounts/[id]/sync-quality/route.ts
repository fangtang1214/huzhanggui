import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { syncWindowQuality } from "@/lib/league-product";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    await requireUser("products:create");
    const { id: leagueAccountId } = await context.params;
    const { searchParams } = new URL(request.url);
    const talentAccountId = searchParams.get("talentAccountId");
    if (!talentAccountId) return Response.json({ ok: false, message: "缺少 talentAccountId 参数" }, { status: 400 });
    void syncWindowQuality(leagueAccountId, talentAccountId)
      .catch((error) => console.error("评分同步失败", error));
    return ok({ leagueAccountId, talentAccountId, syncing: true });
  } catch (error) { return apiError(error); }
}
