import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const user = await requireUser("dashboard:view");
    const sql = getDb();
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const [summary] = await sql`
      SELECT
        count(*) FILTER (WHERE s.archived = false)::int AS total_samples,
        count(*) FILTER (WHERE s.archived = false AND s.status = 'active')::int AS active_samples,
        count(*) FILTER (WHERE s.archived = false AND s.status = 'returned')::int AS returned_samples,
        count(*) FILTER (WHERE s.archived = false AND s.status IN ('damaged','lost','scrapped'))::int AS exception_samples,
        count(DISTINCT s.product_id) FILTER (WHERE s.archived = false)::int AS total_products
      FROM samples s
      WHERE (${scopedDepartment}::uuid IS NULL OR s.current_department_id = ${scopedDepartment}
        OR EXISTS (SELECT 1 FROM product_departments pd WHERE pd.product_id = s.product_id AND pd.department_id = ${scopedDepartment}))
    `;
    const locations = await sql`
      SELECT d.id, d.name, count(s.id)::int AS count
      FROM departments d
      LEFT JOIN samples s ON s.current_department_id = d.id AND s.status = 'active' AND s.archived = false
      WHERE d.active = true AND (${scopedDepartment}::uuid IS NULL OR d.id = ${scopedDepartment})
      GROUP BY d.id, d.name HAVING count(s.id) > 0
      ORDER BY count DESC, d.name LIMIT 8
    `;
    const recent = await sql`
      SELECT m.id, m.created_at, m.to_status, m.remark, s.code, p.name AS product_name,
             p.sku, u.name AS operator_name, fd.name AS from_department_name,
             td.name AS to_department_name, tl.name AS to_location_name
      FROM sample_movements m
      JOIN samples s ON s.id = m.sample_id
      JOIN products p ON p.id = s.product_id
      LEFT JOIN users u ON u.id = m.operator_id
      LEFT JOIN departments fd ON fd.id = m.from_department_id
      LEFT JOIN departments td ON td.id = m.to_department_id
      LEFT JOIN locations tl ON tl.id = m.to_location_id
      WHERE (${scopedDepartment}::uuid IS NULL OR m.from_department_id = ${scopedDepartment}
             OR m.to_department_id = ${scopedDepartment}
             OR EXISTS (SELECT 1 FROM product_departments pd WHERE pd.product_id = p.id AND pd.department_id = ${scopedDepartment}))
      ORDER BY m.created_at DESC LIMIT 8
    `;
    const newProducts = await sql`
      SELECT p.id, p.sku, p.name, p.image_urls, p.created_at,
             count(s.id)::int AS sample_count,
             string_agg(DISTINCT d.name, '、') AS selected_departments
      FROM products p
      LEFT JOIN samples s ON s.product_id = p.id AND s.archived = false
      LEFT JOIN product_departments pd ON pd.product_id = p.id
      LEFT JOIN departments d ON d.id = pd.department_id
      WHERE p.archived = false AND (${scopedDepartment}::uuid IS NULL OR pd.department_id = ${scopedDepartment}
        OR EXISTS (SELECT 1 FROM samples sx WHERE sx.product_id = p.id AND sx.current_department_id = ${scopedDepartment}))
      GROUP BY p.id ORDER BY p.created_at DESC LIMIT 6
    `;
    return ok({ summary, locations, recent, newProducts });
  } catch (error) {
    return apiError(error);
  }
}

