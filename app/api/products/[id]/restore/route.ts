import { apiError, ok, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("products:archive");
    const { id } = await context.params;
    const sql = getDb();
    const [product] = await sql`SELECT sku, name FROM products WHERE id = ${id} AND archived = true`;
    if (!product) return Response.json({ ok: false, message: "归档商品不存在或已经恢复" }, { status: 404 });

    const restoredSamples = await sql.begin(async (tx) => {
      await tx`UPDATE products SET archived = false, version = version + 1, updated_at = now() WHERE id = ${id}`;
      return tx`UPDATE samples SET archived = false, archived_with_product = false, updated_at = now()
        WHERE product_id = ${id} AND archived_with_product = true RETURNING id`;
    });
    await writeAudit(user, "product.restore", "product", id, `恢复商品 ${product.sku} ${product.name}，恢复 ${restoredSamples.length} 件样品`, undefined, requestIp(request));
    return ok({ restored: true, sampleCount: restoredSamples.length });
  } catch (error) {
    return apiError(error);
  }
}
