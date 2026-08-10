import { getDb } from "@/lib/db";
import { apiError } from "@/lib/api";
import { productsToWecomCsv, verifyWecomSheetToken, WECOM_SHEET_SETTING_KEY } from "@/lib/wecom-sheet";

export const dynamic = "force-dynamic";

function csvResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'inline; filename="huzhanggui-products.csv"',
      "Cache-Control": "private, no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  try {
    const sql = getDb();
    const [setting] = await sql`
      SELECT value
      FROM app_settings
      WHERE key = ${WECOM_SHEET_SETTING_KEY}
      LIMIT 1
    `;
    const expectedHash = String(setting?.value?.tokenHash || "");
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!verifyWecomSheetToken(token, expectedHash)) {
      return csvResponse("同步密钥无效或已停用\r\n", 401);
    }

    const rows = await sql`
      SELECT sku, name, price::text AS price, product_url, image_urls, updated_at
      FROM products
      WHERE archived = false
      ORDER BY lower(sku) ASC
    `;
    return csvResponse(productsToWecomCsv(rows.map((row) => ({
      sku: row.sku,
      name: row.name,
      price: row.price,
      productUrl: row.productUrl,
      imageUrls: row.imageUrls,
      updatedAt: row.updatedAt,
    }))));
  } catch (error) {
    return apiError(error);
  }
}
