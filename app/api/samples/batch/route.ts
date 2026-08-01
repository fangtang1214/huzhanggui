import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { SAMPLE_STATUSES, statusLabel } from "@/lib/constants";

const values = SAMPLE_STATUSES.map((item) => item.value) as [string, ...string[]];
const schema = z.object({
  sampleIds: z.array(z.string().uuid()).min(1, "请选择样品").max(500),
  status: z.enum(values),
  departmentId: z.string().uuid().optional().nullable(),
  locationId: z.string().uuid().optional().nullable(),
  remark: z.string().trim().max(500).optional().nullable(),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser("samples:batch");
    const input = schema.parse(await readJson(request));
    if (input.status === "active" && !input.departmentId) {
      return Response.json({ ok: false, message: "在用/在库样品必须选择所在部门" }, { status: 400 });
    }
    const sql = getDb();
    if (input.locationId) {
      const location = await sql`SELECT id FROM locations WHERE id = ${input.locationId} AND department_id = ${input.departmentId || null} AND active = true`;
      if (location.length === 0) return Response.json({ ok: false, message: "具体位置不属于所选部门" }, { status: 400 });
    }
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const samples = await sql`
      SELECT s.id, s.code, s.status, s.current_department_id, s.current_location_id
      FROM samples s
      WHERE s.id IN ${sql(input.sampleIds)} AND s.archived = false
        AND (${scopedDepartment}::uuid IS NULL OR s.current_department_id = ${scopedDepartment}
          OR EXISTS (SELECT 1 FROM product_departments pd WHERE pd.product_id = s.product_id AND pd.department_id = ${scopedDepartment}))
    `;
    if (samples.length !== input.sampleIds.length) {
      return Response.json({ ok: false, message: "部分样品不存在或无权操作" }, { status: 403 });
    }
    const toDepartmentId = input.status === "active" ? input.departmentId || null : null;
    const toLocationId = input.status === "active" ? input.locationId || null : null;
    await sql.begin(async (tx) => {
      const [batch] = await tx`SELECT gen_random_uuid() AS id`;
      for (const sample of samples) {
        await tx`
          UPDATE samples SET status = ${input.status}, current_department_id = ${toDepartmentId},
            current_location_id = ${toLocationId}, updated_at = now() WHERE id = ${sample.id}
        `;
        await tx`
          INSERT INTO sample_movements (
            batch_id, sample_id, from_status, from_department_id, from_location_id,
            to_status, to_department_id, to_location_id, operator_id, remark
          ) VALUES (${batch.id}, ${sample.id}, ${sample.status}, ${sample.currentDepartmentId},
                    ${sample.currentLocationId}, ${input.status}, ${toDepartmentId}, ${toLocationId},
                    ${user.id}, ${input.remark || null})
        `;
      }
    });
    await writeAudit(user, "sample.batch_move", "sample", null, `批量更新 ${samples.length} 件样品为“${statusLabel(input.status)}”`, input, requestIp(request));
    return ok({ updated: samples.length });
  } catch (error) {
    return apiError(error);
  }
}
