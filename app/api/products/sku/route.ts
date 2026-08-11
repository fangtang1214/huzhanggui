import { requireUser } from "@/lib/auth";
import { apiError, ok } from "@/lib/api";
import { getDb } from "@/lib/db";
import { beijingDate, isProductSkuForDate, productSkuPrefix, suggestNextProductSku } from "@/lib/sku";

export async function GET(request: Request) {
  try {
    await requireUser("products:create");
    const sql = getDb();
    const date = beijingDate();
    const prefix = productSkuPrefix(date);
    const sku = (new URL(request.url).searchParams.get("sku") || "").trim();
    if (!sku) return ok({ prefix, suggestedSku: await suggestNextProductSku(sql, date) });
    if (!isProductSkuForDate(sku, date)) {
      return ok({ prefix, sku, valid: false, available: false, message: `货号必须为 ${prefix} 开头的 8 位数字，后四位范围为 0001–9999` });
    }
    const [existing] = await sql`SELECT id, archived FROM products WHERE lower(sku) = lower(${sku}) LIMIT 1`;
    return ok({
      prefix,
      sku,
      valid: true,
      available: !existing,
      message: existing ? "该商品货号已存在" : "该商品货号可以使用",
    });
  } catch (error) {
    return apiError(error);
  }
}
