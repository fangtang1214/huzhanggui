import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { SAMPLE_STATUSES, statusLabel } from "@/lib/constants";

const values = SAMPLE_STATUSES.map((item) => item.value) as [string, ...string[]];
const schema = z.object({
  batchId: z.string().uuid().optional(),
  sampleIds: z.array(z.string().uuid()).min(1, "请选择样品").max(100, "单批最多处理 100 件样品")
    .refine((ids) => new Set(ids).size === ids.length, "同一批次不能包含重复样品"),
  status: z.enum(values),
  departmentId: z.string().uuid().optional().nullable(),
  locationId: z.string().uuid().optional().nullable(),
  remark: z.string().trim().max(500).optional().nullable(),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser("samples:move");
    const input = schema.parse(await readJson(request));
    if (input.status === "active" && !input.departmentId) {
      return Response.json({ ok: false, message: "在用/在库样品必须选择所在部门" }, { status: 400 });
    }

    const sql = getDb();
    const batchId = input.batchId || randomUUID();
    const toDepartmentId = input.status === "active" ? input.departmentId || null : null;
    const toLocationId = input.status === "active" ? input.locationId || null : null;
    if (toLocationId) {
      const location = await sql`
        SELECT id FROM locations
        WHERE id = ${toLocationId} AND department_id = ${toDepartmentId} AND active = true
      `;
      if (location.length === 0) {
        return Response.json({ ok: false, message: "具体位置不属于所选部门" }, { status: 400 });
      }
    }

    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;
    const outcome = await sql.begin(async (tx) => {
      const samples = await tx`
        SELECT s.id, s.code, s.status, s.current_department_id, s.current_location_id
        FROM samples s
        JOIN products p ON p.id = s.product_id
        WHERE s.id IN ${tx(input.sampleIds)} AND s.archived = false AND p.archived = false
          AND (${scopedDepartment}::uuid IS NULL OR s.current_department_id = ${scopedDepartment}
            OR EXISTS (
              SELECT 1 FROM product_departments pd
              WHERE pd.product_id = s.product_id AND pd.department_id = ${scopedDepartment}
            ))
        FOR UPDATE OF s
      `;
      const availableIds = samples.map((sample) => sample.id as string);
      const previous = availableIds.length > 0
        ? await tx`
            SELECT sample_id FROM sample_movements
            WHERE batch_id = ${batchId} AND sample_id IN ${tx(availableIds)}
          `
        : [];
      const previouslyCompleted = new Set(previous.map((row) => row.sampleId as string));
      const unchanged = new Set<string>();
      const changed = new Set<string>();

      for (const sample of samples) {
        const sampleId = sample.id as string;
        if (previouslyCompleted.has(sampleId)) continue;
        const alreadyAtTarget = sample.status === input.status
          && (sample.currentDepartmentId || null) === toDepartmentId
          && (sample.currentLocationId || null) === toLocationId;
        if (alreadyAtTarget) {
          unchanged.add(sampleId);
          continue;
        }
        await tx`
          UPDATE samples SET status = ${input.status}, current_department_id = ${toDepartmentId},
            current_location_id = ${toLocationId}, updated_at = now()
          WHERE id = ${sampleId}
        `;
        await tx`
          INSERT INTO sample_movements (
            batch_id, sample_id, from_status, from_department_id, from_location_id,
            to_status, to_department_id, to_location_id, operator_id, remark
          ) VALUES (${batchId}, ${sampleId}, ${sample.status}, ${sample.currentDepartmentId},
                    ${sample.currentLocationId}, ${input.status}, ${toDepartmentId}, ${toLocationId},
                    ${user.id}, ${input.remark || null})
        `;
        changed.add(sampleId);
      }

      return { samples, previouslyCompleted, unchanged, changed };
    });

    const sampleMap = new Map(outcome.samples.map((sample) => [sample.id as string, sample]));
    const results = input.sampleIds.map((sampleId) => {
      const sample = sampleMap.get(sampleId);
      if (!sample) {
        return { sampleId, success: false, changed: false, message: "样品不存在、已归档或无权操作" };
      }
      if (outcome.previouslyCompleted.has(sampleId)) {
        return { sampleId, code: sample.code, success: true, changed: false, message: "该批次已处理，本次未重复流转" };
      }
      if (outcome.unchanged.has(sampleId)) {
        return { sampleId, code: sample.code, success: true, changed: false, message: "已处于目标状态和位置" };
      }
      return { sampleId, code: sample.code, success: true, changed: true };
    });
    const succeeded = results.filter((result) => result.success).length;

    await writeAudit(
      user,
      "sample.batch_move",
      "sample",
      null,
      `批量流转 ${succeeded} 件样品为“${statusLabel(input.status)}”，实际变更 ${outcome.changed.size} 件`,
      { ...input, batchId, results },
      requestIp(request),
    );
    return ok({ batchId, updated: outcome.changed.size, results });
  } catch (error) {
    return apiError(error);
  }
}
