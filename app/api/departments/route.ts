import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({
  name: z.string().trim().min(1, "请填写部门名称").max(100),
  kind: z.enum(["business", "live_room", "management", "other"]),
  description: z.string().trim().max(500).optional().nullable(),
});

export async function GET() {
  try {
    await requireUser("departments:view");
    const sql = getDb();
    const rows = await sql`
      SELECT d.*, count(DISTINCT u.id)::int AS user_count,
             count(DISTINCT s.id) FILTER (WHERE s.status = 'active' AND s.archived = false)::int AS sample_count
      FROM departments d
      LEFT JOIN users u ON u.department_id = d.id AND u.active = true
      LEFT JOIN samples s ON s.current_department_id = d.id
      WHERE d.active = true GROUP BY d.id ORDER BY d.kind, d.name
    `;
    return ok(rows);
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("departments:manage");
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const [row] = await sql`
      INSERT INTO departments (name, kind, description) VALUES (${input.name}, ${input.kind}, ${input.description || null})
      RETURNING *
    `;
    await writeAudit(user, "department.create", "department", row.id, `创建部门 ${row.name}`, input, requestIp(request));
    return created(row);
  } catch (error) { return apiError(error); }
}

