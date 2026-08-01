import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";

const schema = z.object({ type: z.enum(["category", "tag"]), name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });

export async function GET() {
  try {
    await requireUser(); const sql = getDb();
    const [categories, tags] = await Promise.all([sql`SELECT * FROM categories WHERE active = true ORDER BY name`, sql`SELECT * FROM tags WHERE active = true ORDER BY name`]);
    return ok({ categories, tags });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("catalog:manage"); const input = schema.parse(await readJson(request)); const sql = getDb();
    const [row] = input.type === "category"
      ? await sql`INSERT INTO categories(name) VALUES (${input.name}) RETURNING *`
      : await sql`INSERT INTO tags(name, color) VALUES (${input.name}, ${input.color || '#56736a'}) RETURNING *`;
    await writeAudit(user, `${input.type}.create`, input.type, row.id, `创建${input.type === 'category' ? '分类' : '标签'} ${input.name}`, input, requestIp(request));
    return created(row);
  } catch (error) { return apiError(error); }
}

