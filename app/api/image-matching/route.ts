import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { cosineSimilarity, embedImage, getMatchSettings, urlHash } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";

const schema = z.object({
  imageUrl: imageUrlSchema,
  excludeProductIds: z.array(z.string().uuid()).max(50).default([]),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create");
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const settings = await getMatchSettings();
    try {
      const embedding = await embedImage(input.imageUrl);
      const features = await sql`
        SELECT f.product_id, f.embedding
        FROM product_image_features f
        WHERE f.status = 'ready' AND f.model = ${settings.model} AND f.embedding IS NOT NULL
      `;
      const best = new Map<string, number>();
      for (const feature of features) {
        const productId = String(feature.productId);
        if (input.excludeProductIds.includes(productId)) continue;
        const score = cosineSimilarity(embedding, (feature.embedding || []).map(Number));
        if (score >= settings.threshold && score > (best.get(productId) ?? -1)) best.set(productId, score);
      }
      const ranked = [...best.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
      const ids = ranked.map(([id]) => id);
      const products = ids.length ? await sql`
        SELECT p.*,
          (SELECT coalesce(json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name), '[]')
           FROM product_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.product_id = p.id) AS departments,
          (SELECT coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name), '[]')
           FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id) AS tags
        FROM products p WHERE p.id = ANY(${ids}::uuid[])
      ` : [];
      const byId = new Map(products.map((product) => [String(product.id), product]));
      const candidates = ranked.map(([id, similarity]) => ({ ...byId.get(id), similarity }));
      const status = candidates.length ? "matched" : "no_match";
      const [run] = await sql`
        INSERT INTO image_match_runs(user_id, image_url, image_url_hash, threshold_mode, threshold, status, candidates)
        VALUES (${user.id}, ${input.imageUrl}, ${urlHash(input.imageUrl)}, ${settings.mode}, ${settings.threshold}, ${status}, ${sql.json(candidates as never)})
        RETURNING id
      `;
      if (status === "no_match") await sql`UPDATE image_match_runs SET decision='new',decided_at=now() WHERE id=${run.id}`;
      await writeAudit(user, "image.match", "image_match", String(run.id), candidates.length ? `图片识别发现 ${candidates.length} 个疑似同款` : "图片识别未发现疑似同款", { imageUrl: input.imageUrl, mode: settings.mode, threshold: settings.threshold, candidates: ranked }, requestIp(request));
      return ok({ runId: run.id, status, candidates, mode: settings.mode, threshold: settings.threshold });
    } catch (reason) {
      const message = reason instanceof Error && reason.name === "AbortError" ? "图片识别超时，请重试" : reason instanceof Error ? reason.message : "图片识别失败";
      const [run] = await sql`
        INSERT INTO image_match_runs(user_id, image_url, image_url_hash, threshold_mode, threshold, status, error)
        VALUES (${user.id}, ${input.imageUrl}, ${urlHash(input.imageUrl)}, ${settings.mode}, ${settings.threshold}, 'failed', ${message.slice(0, 1000)}) RETURNING id
      `;
      await writeAudit(user, "image.match_failed", "image_match", String(run.id), "图片识别失败", { imageUrl: input.imageUrl, error: message }, requestIp(request));
      return ok({ runId: run.id, status: "failed", candidates: [], message });
    }
  } catch (error) {
    return apiError(error);
  }
}

const decisionSchema = z.object({ runId: z.string().uuid(), decision: z.enum(["matched", "new", "failed_continue"]), selectedProductId: z.string().uuid().optional().nullable() });

export async function PATCH(request: Request) {
  try {
    const user = await requireUser("products:create"); const input = decisionSchema.parse(await readJson(request)); const sql = getDb();
    const [run] = await sql`SELECT status,candidates FROM image_match_runs WHERE id=${input.runId} AND user_id=${user.id}`;
    if (!run) return Response.json({ ok: false, message: "识别记录不存在" }, { status: 404 });
    if (input.decision === "failed_continue" && run.status !== "failed") return Response.json({ ok: false, message: "该识别记录并未失败" }, { status: 409 });
    if (input.decision === "matched" && !run.candidates?.some((candidate: { id?: string }) => String(candidate.id) === input.selectedProductId)) return Response.json({ ok: false, message: "所选商品不在候选中" }, { status: 409 });
    await sql`UPDATE image_match_runs SET decision=${input.decision},selected_product_id=${input.selectedProductId || null},decided_at=now() WHERE id=${input.runId}`;
    await writeAudit(user, "image.match_decision", "image_match", input.runId, input.decision === "matched" ? "人工确认疑似商品为同款" : input.decision === "new" ? "人工确认候选均非同款" : "图片识别失败后选择继续创建新款", input, requestIp(request));
    return ok({ saved: true });
  } catch (error) { return apiError(error); }
}
