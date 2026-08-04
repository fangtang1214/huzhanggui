import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const user = await requireUser("movements:view"); const sql = getDb(); const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim(); const like = `%${search}%`;
    const page = Math.max(1, Number(url.searchParams.get("page") || 1)); const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 30))); const offset = (page - 1) * pageSize;
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const rows = await sql`
      SELECT m.id, m.batch_id, m.from_status, m.to_status, m.remark, m.created_at,
             s.id AS sample_id, s.code, p.sku, p.name AS product_name,
             fd.name AS from_department_name, fl.name AS from_location_name,
             td.name AS to_department_name, tl.name AS to_location_name, u.name AS operator_name
      FROM sample_movements m JOIN samples s ON s.id = m.sample_id JOIN products p ON p.id = s.product_id
      LEFT JOIN departments fd ON fd.id = m.from_department_id LEFT JOIN locations fl ON fl.id = m.from_location_id
      LEFT JOIN departments td ON td.id = m.to_department_id LEFT JOIN locations tl ON tl.id = m.to_location_id
      LEFT JOIN users u ON u.id = m.operator_id
      WHERE (${search} = '' OR s.code ILIKE ${like} OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR u.name ILIKE ${like}
        OR EXISTS (SELECT 1 FROM sample_code_aliases sca WHERE sca.sample_id=s.id AND sca.alias ILIKE ${like})
        OR EXISTS (SELECT 1 FROM product_sku_aliases psa WHERE psa.product_id=p.id AND psa.alias ILIKE ${like}))
        AND (${scopedDepartment}::uuid IS NULL OR m.from_department_id = ${scopedDepartment} OR m.to_department_id = ${scopedDepartment}
          OR EXISTS (SELECT 1 FROM product_departments pd WHERE pd.product_id = p.id AND pd.department_id = ${scopedDepartment}))
      ORDER BY m.created_at DESC LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [count] = await sql`
      SELECT count(*)::int AS total FROM sample_movements m JOIN samples s ON s.id = m.sample_id JOIN products p ON p.id = s.product_id LEFT JOIN users u ON u.id = m.operator_id
      WHERE (${search} = '' OR s.code ILIKE ${like} OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR u.name ILIKE ${like}
        OR EXISTS (SELECT 1 FROM sample_code_aliases sca WHERE sca.sample_id=s.id AND sca.alias ILIKE ${like})
        OR EXISTS (SELECT 1 FROM product_sku_aliases psa WHERE psa.product_id=p.id AND psa.alias ILIKE ${like}))
        AND (${scopedDepartment}::uuid IS NULL OR m.from_department_id = ${scopedDepartment} OR m.to_department_id = ${scopedDepartment}
          OR EXISTS (SELECT 1 FROM product_departments pd WHERE pd.product_id = p.id AND pd.department_id = ${scopedDepartment}))
    `;
    return ok({ rows, total: count.total, page, pageSize });
  } catch (error) { return apiError(error); }
}
