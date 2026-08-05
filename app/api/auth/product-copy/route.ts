import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { isProductCopyFieldKey, normalizeProductCopyConfig } from "@/lib/product-copy";

const schema = z.object({
  order: z.array(z.string()).max(50).refine((values) => values.every(isProductCopyFieldKey), "复制字段顺序无效"),
  enabled: z.array(z.string()).max(50).refine((values) => values.every(isProductCopyFieldKey), "复制字段配置无效"),
});

export async function GET() {
  try {
    const user = await requireUser();
    return ok(normalizeProductCopyConfig(user.productCopyConfig));
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const config = normalizeProductCopyConfig(schema.parse(await readJson(request)));
    if (config.enabled.length === 0) {
      return Response.json({ ok: false, message: "请至少选择一个需要复制的字段" }, { status: 400 });
    }
    const sql = getDb();
    await sql`UPDATE users SET product_copy_config = ${sql.json(config)}, updated_at = now() WHERE id = ${user.id}`;
    await writeAudit(user, "user.product_copy_config", "user", user.id, "修改商品一键复制配置", config, requestIp(request));
    return ok(config);
  } catch (error) {
    return apiError(error);
  }
}
