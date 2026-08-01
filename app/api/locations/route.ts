import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({
  departmentId: z.string().uuid(),
  name: z.string().trim().min(1, "请填写位置名称").max(100),
  code: z.string().trim().max(50).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
});

export async function GET() {
  try {
    await requireUser("locations:view");
    const sql = getDb();
    const rows = await sql`
      SELECT l.*, d.name AS department_name,
             count(s.id) FILTER (WHERE s.status = 'active' AND s.archived = false)::int AS sample_count
      FROM locations l JOIN departments d ON d.id = l.department_id
      LEFT JOIN samples s ON s.current_location_id = l.id
      WHERE l.active = true AND d.active = true GROUP BY l.id, d.name ORDER BY d.name, l.name
    `;
    return ok(rows);
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("locations:manage");
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO locations(department_id, name, code, description)
      VALUES (${input.departmentId}, ${input.name}, ${input.code || null}, ${input.description || null}) RETURNING *
    `;
    await writeAudit(user, "location.create", "location", row.id, `创建位置 ${row.name}`, input, requestIp(request));
    return created(row);
  } catch (error) { return apiError(error); }
}

