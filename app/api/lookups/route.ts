import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PERMISSION_GROUPS } from "@/lib/permissions";

export async function GET() {
  try {
    await requireUser();
    const sql = getDb();
    const [departments, locations, categories, tags, users, roles] = await Promise.all([
      sql`SELECT id, name, kind FROM departments WHERE active = true ORDER BY kind, name`,
      sql`SELECT l.id, l.name, l.code, l.department_id, d.name AS department_name
          FROM locations l JOIN departments d ON d.id = l.department_id
          WHERE l.active = true AND d.active = true ORDER BY d.name, l.name`,
      sql`SELECT id, name FROM categories WHERE active = true ORDER BY name`,
      sql`SELECT id, name, color FROM tags WHERE active = true ORDER BY name`,
      sql`SELECT u.id, u.name, u.username, u.department_id, d.name AS department_name
          FROM users u JOIN departments d ON d.id = u.department_id
          WHERE u.active = true ORDER BY d.name, u.name`,
      sql`SELECT id, name FROM roles WHERE active = true ORDER BY name`,
    ]);
    return ok({ departments, locations, categories, tags, users, roles, permissionGroups: PERMISSION_GROUPS });
  } catch (error) {
    return apiError(error);
  }
}

