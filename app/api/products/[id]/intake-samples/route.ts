import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser("products:create");
    const { id } = await context.params;
    const sql = getDb();
    const [product] = await sql`
      SELECT id, sku, name, archived
      FROM products
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!product) return Response.json({ ok: false, message: "关联的商品已不存在" }, { status: 404 });

    const samples = await sql`
      SELECT s.id, s.code, s.arrived_at, s.status, s.spec, s.archived,
             d.name AS department_name, l.name AS location_name, s.updated_at
      FROM samples s
      LEFT JOIN departments d ON d.id = s.current_department_id
      LEFT JOIN locations l ON l.id = s.current_location_id
      WHERE s.product_id = ${id}
        AND (s.archived = false OR ${Boolean(product.archived)} = true)
      ORDER BY s.created_at DESC
    `;
    return ok({ product, samples });
  } catch (error) {
    return apiError(error);
  }
}
