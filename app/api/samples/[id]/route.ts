import QRCode from "qrcode";
import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { SAMPLE_STATUSES, statusLabel } from "@/lib/constants";

const values = SAMPLE_STATUSES.map((item) => item.value) as [string, ...string[]];
const schema = z.object({
  status: z.enum(values),
  departmentId: z.string().uuid().optional().nullable(),
  locationId: z.string().uuid().optional().nullable(),
  remark: z.string().trim().max(500).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

async function findSample(id: string, scopedDepartment: string | null) {
  const sql = getDb();
  const rows = await sql`
    SELECT s.*, p.sku, p.name AS product_name, p.store_name, p.product_url, p.image_urls,
           p.price, p.commission, p.supply_chain, d.name AS department_name,
           l.name AS location_name, c.name AS category_name
    FROM samples s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN departments d ON d.id = s.current_department_id
    LEFT JOIN locations l ON l.id = s.current_location_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE (s.id::text = ${id} OR lower(s.code) = ${id.toLowerCase()}) AND s.archived = false
      AND (${scopedDepartment}::uuid IS NULL OR s.current_department_id = ${scopedDepartment}
        OR EXISTS (SELECT 1 FROM product_departments pd WHERE pd.product_id = s.product_id AND pd.department_id = ${scopedDepartment}))
    LIMIT 1
  `;
  return rows[0] || null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("samples:view");
    const { id } = await context.params;
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const sample = await findSample(id, scopedDepartment);
    if (!sample) return Response.json({ ok: false, message: "样品不存在或无权查看" }, { status: 404 });
    const sql = getDb();
    const movements = await sql`
      SELECT m.id, m.from_status, m.to_status, m.remark, m.created_at,
             fd.name AS from_department_name, fl.name AS from_location_name,
             td.name AS to_department_name, tl.name AS to_location_name,
             u.name AS operator_name
      FROM sample_movements m
      LEFT JOIN departments fd ON fd.id = m.from_department_id
      LEFT JOIN locations fl ON fl.id = m.from_location_id
      LEFT JOIN departments td ON td.id = m.to_department_id
      LEFT JOIN locations tl ON tl.id = m.to_location_id
      LEFT JOIN users u ON u.id = m.operator_id
      WHERE m.sample_id = ${sample.id} ORDER BY m.created_at DESC
    `;
    const baseUrl = process.env.APP_URL || new URL(request.url).origin;
    const qrCode = await QRCode.toDataURL(`${baseUrl}/s/${sample.code}`, { width: 360, margin: 2, color: { dark: "#183e35", light: "#ffffff" } });
    return ok({ sample, movements, qrCode });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("samples:move");
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    if (input.status === "active" && !input.departmentId) {
      return Response.json({ ok: false, message: "在用/在库样品必须选择所在部门" }, { status: 400 });
    }
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const sample = await findSample(id, scopedDepartment);
    if (!sample) return Response.json({ ok: false, message: "样品不存在或无权操作" }, { status: 404 });
    const sql = getDb();
    if (input.locationId) {
      const location = await sql`SELECT id FROM locations WHERE id = ${input.locationId} AND department_id = ${input.departmentId || null} AND active = true`;
      if (location.length === 0) return Response.json({ ok: false, message: "具体位置不属于所选部门" }, { status: 400 });
    }
    const departmentId = input.status === "active" ? input.departmentId || null : null;
    const locationId = input.status === "active" ? input.locationId || null : null;
    await sql.begin(async (tx) => {
      await tx`
        UPDATE samples SET status = ${input.status}, current_department_id = ${departmentId},
          current_location_id = ${locationId}, note = coalesce(${input.note || null}, note), updated_at = now()
        WHERE id = ${sample.id}
      `;
      await tx`
        INSERT INTO sample_movements (
          sample_id, from_status, from_department_id, from_location_id,
          to_status, to_department_id, to_location_id, operator_id, remark
        ) VALUES (${sample.id}, ${sample.status}, ${sample.currentDepartmentId}, ${sample.currentLocationId},
                  ${input.status}, ${departmentId}, ${locationId}, ${user.id}, ${input.remark || null})
      `;
    });
    await writeAudit(user, "sample.move", "sample", sample.id, `样品 ${sample.code} 更新为“${statusLabel(input.status)}”`, { before: sample, after: input }, requestIp(request));
    return ok({ id: sample.id });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("samples:archive");
    const { id } = await context.params;
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const sample = await findSample(id, scopedDepartment);
    if (!sample) return Response.json({ ok: false, message: "样品不存在或无权操作" }, { status: 404 });
    if (sample.status === "active") return Response.json({ ok: false, message: "请先将样品处理为结束状态，再归档" }, { status: 409 });
    const sql = getDb();
    await sql`UPDATE samples SET archived = true, updated_at = now() WHERE id = ${sample.id}`;
    await writeAudit(user, "sample.archive", "sample", sample.id, `归档样品 ${sample.code}`, undefined, requestIp(request));
    return ok({ archived: true });
  } catch (error) {
    return apiError(error);
  }
}

