import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    await requireUser("samples:view");
    const sql = getDb();
    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const like = `%${search}%`;
    const status = url.searchParams.get("status") || null;
    const departmentId = url.searchParams.get("departmentId") || null;
    const locationId = url.searchParams.get("locationId") || null;
    const productId = url.searchParams.get("productId") || null;
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 30)));
    const offset = (page - 1) * pageSize;
    const rows = await sql`
      SELECT s.id, s.code, s.arrived_at, s.status, s.note, s.updated_at,
             p.id AS product_id, p.sku, p.name AS product_name, p.image_urls,
             d.id AS department_id, d.name AS department_name,
             l.id AS location_id, l.name AS location_name
      FROM samples s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN departments d ON d.id = s.current_department_id
      LEFT JOIN locations l ON l.id = s.current_location_id
      WHERE s.archived = false AND p.archived = false
        AND (${search} = '' OR s.code ILIKE ${like} OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like}
          OR EXISTS (SELECT 1 FROM sample_code_aliases sca WHERE sca.sample_id=s.id AND sca.alias ILIKE ${like})
          OR EXISTS (SELECT 1 FROM product_sku_aliases psa WHERE psa.product_id=p.id AND psa.alias ILIKE ${like}))
        AND (${status}::text IS NULL OR s.status = ${status})
        AND (${departmentId}::uuid IS NULL OR s.current_department_id = ${departmentId})
        AND (${locationId}::uuid IS NULL OR s.current_location_id = ${locationId})
        AND (${productId}::uuid IS NULL OR s.product_id = ${productId})
      ORDER BY s.updated_at DESC, s.code DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [count] = await sql`
      SELECT count(*)::int AS total FROM samples s JOIN products p ON p.id = s.product_id
      WHERE s.archived = false AND p.archived = false
        AND (${search} = '' OR s.code ILIKE ${like} OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like}
          OR EXISTS (SELECT 1 FROM sample_code_aliases sca WHERE sca.sample_id=s.id AND sca.alias ILIKE ${like})
          OR EXISTS (SELECT 1 FROM product_sku_aliases psa WHERE psa.product_id=p.id AND psa.alias ILIKE ${like}))
        AND (${status}::text IS NULL OR s.status = ${status})
        AND (${departmentId}::uuid IS NULL OR s.current_department_id = ${departmentId})
        AND (${locationId}::uuid IS NULL OR s.current_location_id = ${locationId})
        AND (${productId}::uuid IS NULL OR s.product_id = ${productId})
    `;
    return ok({ rows, total: count.total, page, pageSize });
  } catch (error) {
    return apiError(error);
  }
}
