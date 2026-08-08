import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { AuthError, hasPermission, requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { IMAGE_MODEL, MATCH_THRESHOLDS, syncProductImageQueue } from "@/lib/image-matching";
import { nextProductSampleCode, nextProductSku } from "@/lib/sku";
import { setCurrentProductApiId } from "@/lib/product-api-ids";

function dbValue(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function allowed(user: Awaited<ReturnType<typeof requireUser>>) {
  if (!hasPermission(user, "image_matching:manage") && !hasPermission(user, "products:correct_merge")) throw new AuthError("没有执行此操作的权限", 403);
}

export async function GET() {
  try {
    const user = await requireUser(); allowed(user); const sql = getDb();
    const [setting] = await sql`SELECT value FROM app_settings WHERE key='image_matching'`;
    const [progress] = await sql`SELECT count(*)::int AS total, count(*) FILTER(WHERE status='ready')::int AS ready,
      count(*) FILTER(WHERE status='pending' OR status='processing')::int AS pending, count(*) FILTER(WHERE status='failed')::int AS failed FROM product_image_features`;
    const runs = await sql`SELECT r.id,r.image_url,r.status,r.decision,r.error,r.threshold_mode,r.threshold,r.candidates,r.timings,r.created_at,r.decided_at,u.name AS user_name
      FROM image_match_runs r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 50`;
    const batches = await sql`SELECT b.id,b.product_id,b.sample_ids,b.status,b.merged_product_version,b.correction_note,b.created_at,b.corrected_at,
      p.sku,p.name,p.version,u.name AS user_name,cp.sku AS corrected_sku
      FROM product_intake_batches b JOIN products p ON p.id=b.product_id LEFT JOIN products cp ON cp.id=b.corrected_product_id
      LEFT JOIN users u ON u.id=b.user_id ORDER BY b.created_at DESC LIMIT 50`;
    return ok({ setting: setting?.value || { mode: "standard", model: IMAGE_MODEL }, thresholds: MATCH_THRESHOLDS, progress, runs, batches });
  } catch (error) { return apiError(error); }
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("settings"), mode: z.enum(["strict", "standard", "relaxed"]) }),
  z.object({ action: z.literal("retry_failed") }),
  z.object({ action: z.literal("reindex_all") }),
  z.object({ action: z.literal("correct_merge"), batchId: z.string().uuid(), note: z.string().trim().max(1000).optional().default("") }),
]);

export async function POST(request: Request) {
  try {
    const user = await requireUser(); const input = schema.parse(await readJson(request)); const sql = getDb();
    if (input.action === "settings") {
      if (!hasPermission(user, "image_matching:manage")) return Response.json({ ok: false, message: "没有管理图片识别的权限" }, { status: 403 });
      await sql`INSERT INTO app_settings(key,value) VALUES('image_matching',${sql.json({ mode: input.mode, model: IMAGE_MODEL })})
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`;
      await writeAudit(user, "image.settings", "app_setting", "image_matching", `图片匹配模式改为 ${input.mode}`, input, requestIp(request));
      return ok({ saved: true });
    }
    if (input.action === "retry_failed" || input.action === "reindex_all") {
      if (!hasPermission(user, "image_matching:manage")) return Response.json({ ok: false, message: "没有管理图片识别的权限" }, { status: 403 });
      if (input.action === "retry_failed") await sql`UPDATE product_image_features SET status='pending',error=NULL,attempts=0,updated_at=now() WHERE status='failed'`;
      else await sql.begin(async (tx) => {
        await tx`UPDATE product_image_features SET status='pending',embedding=NULL,embedding_vector=NULL,error=NULL,attempts=0,model=${IMAGE_MODEL},updated_at=now()`;
        await tx`DELETE FROM image_embedding_cache WHERE model=${IMAGE_MODEL}`;
      });
      await writeAudit(user, `image.${input.action}`, "image_index", null, input.action === "retry_failed" ? "重新尝试失败的历史图片" : "重新建立全部图片索引", undefined, requestIp(request));
      return ok({ queued: true });
    }
    if (!hasPermission(user, "products:correct_merge")) return Response.json({ ok: false, message: "没有纠正误判同款的权限" }, { status: 403 });
    const result = await sql.begin(async (tx) => {
      const [batch] = await tx`SELECT * FROM product_intake_batches WHERE id=${input.batchId} FOR UPDATE`;
      if (!batch || batch.status !== "active") throw new Error("该次同款入库已纠正或不存在");
      const [current] = await tx`SELECT * FROM products WHERE id=${batch.productId} FOR UPDATE`;
      if (!current) throw new Error("原商品不存在");
      const submitted = batch.submittedData as Record<string, unknown>; const previous = batch.previousProductData as { product?: Record<string, unknown>; departmentIds?: string[]; tagIds?: string[] };
      const sku = await nextProductSku(tx as never);
      const images = Array.isArray(submitted.imageUrls) ? submitted.imageUrls as string[] : [];
      const [newProduct] = await tx`INSERT INTO products(sku,name,business_contact_id,store_name,price,product_url,commission,store_rating,supply_chain,cooperation_mechanism,category_id,image_urls,notes,created_by)
        VALUES(${sku},${String(submitted.name || "纠正后的商品")},${dbValue(submitted.businessContactId)},${dbValue(submitted.storeName)},${dbValue(submitted.price)},${dbValue(submitted.productUrl)},${dbValue(submitted.commission)},${dbValue(submitted.storeRating)},${dbValue(submitted.supplyChain)},${dbValue(submitted.cooperationMechanism)},${dbValue(submitted.categoryId)},${tx.json(images)},${dbValue(submitted.notes)},${user.id}) RETURNING id,sku`;
      for (const departmentId of (submitted.departmentIds as string[] || [])) await tx`INSERT INTO product_departments(product_id,department_id) VALUES(${newProduct.id},${departmentId})`;
      for (const tagId of (submitted.tagIds as string[] || [])) await tx`INSERT INTO product_tags(product_id,tag_id) VALUES(${newProduct.id},${tagId})`;
      await setCurrentProductApiId(tx, String(newProduct.id), typeof submitted.apiProductId === "string" ? submitted.apiProductId : null);
      const sampleIds = (batch.sampleIds as string[] || []);
      if (sampleIds.length) {
        const movedSamples = await tx`SELECT id,code FROM samples WHERE id=ANY(${sampleIds}::uuid[]) AND product_id=${current.id}`;
        const byId = new Map(movedSamples.map((sample) => [String(sample.id), sample]));
        for (const sampleId of sampleIds) {
          const sample = byId.get(sampleId); if (!sample) continue;
          const code = await nextProductSampleCode(tx as never, String(newProduct.id), String(newProduct.sku));
          await tx`INSERT INTO sample_code_aliases(alias,sample_id) VALUES(${sample.code},${sample.id}) ON CONFLICT DO NOTHING`;
          await tx`UPDATE samples SET product_id=${newProduct.id},code=${code},updated_at=now() WHERE id=${sample.id}`;
        }
      }
      const canRestore = Number(current.version) === Number(batch.mergedProductVersion) && previous?.product;
      if (canRestore) {
        const p = previous.product as Record<string, unknown>;
        const previousProductUrl = String(current.productUrl || "");
        const restoredProductUrl = typeof p.productUrl === "string" ? p.productUrl : "";
        if (previousProductUrl && previousProductUrl !== restoredProductUrl) {
          await tx`
            INSERT INTO product_link_history(product_id, url, replaced_by_url, source, source_entity_id, changed_by)
            VALUES(${current.id}, ${previousProductUrl}, ${restoredProductUrl || null}, 'recognition_correction', ${batch.id}, ${user.id})
          `;
        }
        await tx`UPDATE products SET name=${dbValue(p.name)},business_contact_id=${dbValue(p.businessContactId)},store_name=${dbValue(p.storeName)},price=${dbValue(p.price)},product_url=${dbValue(p.productUrl)},commission=${dbValue(p.commission)},store_rating=${dbValue(p.storeRating)},supply_chain=${dbValue(p.supplyChain)},cooperation_mechanism=${dbValue(p.cooperationMechanism)},category_id=${dbValue(p.categoryId)},image_urls=${tx.json((p.imageUrls as string[]) || [])},notes=${dbValue(p.notes)},archived=${Boolean(p.archived)},version=version+1,updated_at=now() WHERE id=${current.id}`;
        await tx`DELETE FROM product_departments WHERE product_id=${current.id}`;
        for (const departmentId of previous.departmentIds || []) await tx`INSERT INTO product_departments(product_id,department_id) VALUES(${current.id},${departmentId})`;
        await tx`DELETE FROM product_tags WHERE product_id=${current.id}`;
        for (const tagId of previous.tagIds || []) await tx`INSERT INTO product_tags(product_id,tag_id) VALUES(${current.id},${tagId})`;
      }
      await tx`UPDATE product_intake_batches SET status='corrected',corrected_product_id=${newProduct.id},corrected_by=${user.id},correction_note=${input.note || null},corrected_at=now() WHERE id=${batch.id}`;
      return { id: String(newProduct.id), sku: String(newProduct.sku), oldProductId: String(current.id), restored: Boolean(canRestore), oldImages: (canRestore ? (previous.product?.imageUrls as string[]) : current.imageUrls as string[]) || [], newImages: images };
    });
    await Promise.all([syncProductImageQueue(result.id, result.newImages), syncProductImageQueue(result.oldProductId, result.oldImages)]);
    await writeAudit(user, "product.correct_merge", "product_intake_batch", input.batchId, `纠正误判同款，新建 ${result.sku}${result.restored ? "，原商品已恢复" : "，原商品因后续修改未自动覆盖"}`, { ...input, result }, requestIp(request));
    return ok(result);
  } catch (error) { return apiError(error); }
}
