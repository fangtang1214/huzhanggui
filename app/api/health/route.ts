import { getDb } from "@/lib/db";

export async function GET() {
  try { const sql = getDb(); await sql`SELECT 1`; return Response.json({ ok: true, service: "huzhanggui" }); }
  catch { return Response.json({ ok: false }, { status: 503 }); }
}
