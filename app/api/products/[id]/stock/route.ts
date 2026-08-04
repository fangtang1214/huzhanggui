import { z } from "zod";
import { apiError, created, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { nextProductSampleCode } from "@/lib/sku";

const schema = z.object({
  quantity: z.coerce.number().int().min(1).max(500),
  arrivedAt: z.string().date("请选择到样日期"),
  departmentId: z.string().uuid(),
  locationId: z.string().uuid().optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("products:edit");
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const [product] = await sql`SELECT id, sku, name FROM products WHERE id = ${id} AND archived = false`;
    if (!product) return Response.json({ ok: false, message: "商品不存在" }, { status: 404 });
    if (input.locationId) {
      const location = await sql`SELECT id FROM locations WHERE id = ${input.locationId} AND department_id = ${input.departmentId} AND active = true`;
      if (location.length === 0) return Response.json({ ok: false, message: "存放位置不属于所选部门" }, { status: 400 });
    }
    const codes = await sql.begin(async (tx) => {
      const values: string[] = [];
      for (let index = 0; index < input.quantity; index += 1) {
        const code = await nextProductSampleCode(tx as never, String(product.id), String(product.sku));
        const [sample] = await tx`
          INSERT INTO samples (code, product_id, arrived_at, status, current_department_id, current_location_id, note, created_by)
          VALUES (${code}, ${id}, ${input.arrivedAt}, 'active', ${input.departmentId}, ${input.locationId || null}, ${input.note || null}, ${user.id})
          RETURNING id
        `;
        await tx`
          INSERT INTO sample_movements (sample_id, to_status, to_department_id, to_location_id, operator_id, remark)
          VALUES (${sample.id}, 'active', ${input.departmentId}, ${input.locationId || null}, ${user.id}, ${input.note || '追加到样'})
        `;
        values.push(code);
      }
      return values;
    });
    await writeAudit(user, "product.add_stock", "product", id, `商品 ${product.sku} 追加到样 ${input.quantity} 件`, input, requestIp(request));
    return created({ codes });
  } catch (error) {
    return apiError(error);
  }
}
