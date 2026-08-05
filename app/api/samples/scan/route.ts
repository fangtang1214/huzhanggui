import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    await requireUser("samples:move");
    const code = (new URL(request.url).searchParams.get("code") || "").trim();
    if (!code) {
      return Response.json({ ok: false, message: "请扫描或输入样品条形码" }, { status: 400 });
    }
    if (code.length > 100) {
      return Response.json({ ok: false, message: "条形码内容过长" }, { status: 400 });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT s.id, s.code, s.status, s.arrived_at,
             p.id AS product_id, p.sku, p.name AS product_name, p.image_urls,
             d.id AS department_id, d.name AS department_name,
             l.id AS location_id, l.name AS location_name
      FROM samples s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN departments d ON d.id = s.current_department_id
      LEFT JOIN locations l ON l.id = s.current_location_id
      WHERE (s.id::text = ${code} OR lower(s.code) = ${code.toLowerCase()}
        OR EXISTS (
          SELECT 1 FROM sample_code_aliases sca
          WHERE sca.sample_id = s.id AND lower(sca.alias) = ${code.toLowerCase()}
        ))
        AND s.archived = false AND p.archived = false
      LIMIT 1
    `;
    if (!rows[0]) {
      return Response.json({ ok: false, message: "未找到样品" }, { status: 404 });
    }
    return ok({ sample: rows[0] });
  } catch (error) {
    return apiError(error);
  }
}
