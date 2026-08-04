import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    await requireUser();
    const sql = getDb();
    const [row] = await sql`SELECT count(*)::int AS count FROM link_issues WHERE status = 'pending'`;
    return ok({ count: row.count });
  } catch (error) {
    return apiError(error);
  }
}

