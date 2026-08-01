import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const user = await requireUser("audits:view"); const sql = getDb(); const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim(); const like = `%${search}%`;
    const page = Math.max(1, Number(url.searchParams.get("page") || 1)); const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 40))); const offset = (page - 1) * pageSize;
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const rows = await sql`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.summary, a.changes, a.ip_address, a.created_at,
             u.name AS user_name, u.username, d.name AS department_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN departments d ON d.id = u.department_id
      WHERE (${search} = '' OR a.summary ILIKE ${like} OR u.name ILIKE ${like} OR u.username ILIKE ${like})
        AND (${scopedDepartment}::uuid IS NULL OR u.department_id = ${scopedDepartment})
      ORDER BY a.created_at DESC LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [count] = await sql`
      SELECT count(*)::int AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE (${search} = '' OR a.summary ILIKE ${like} OR u.name ILIKE ${like} OR u.username ILIKE ${like})
        AND (${scopedDepartment}::uuid IS NULL OR u.department_id = ${scopedDepartment})
    `;
    return ok({ rows, total: count.total, page, pageSize });
  } catch (error) { return apiError(error); }
}

