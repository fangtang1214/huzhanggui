import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { embedImage, getMatchSettings, RecognitionTimings, urlHash } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";

const schema = z.object({
  imageUrl: imageUrlSchema,
  excludeProductIds: z.array(z.string().uuid()).max(50).default([]),
});

const elapsed = (started: number) => Math.round((performance.now() - started) * 10) / 10;
const vectorLiteral = (values: number[]) => `[${values.map(Number).join(",")}]`;

async function cachedEmbedding(imageUrl: string, model: string) {
  const sql = getDb(); const hash = urlHash(imageUrl);
  const [cached] = await sql`
    UPDATE image_embedding_cache SET hits=hits+1,last_used_at=now()
    WHERE url_hash=${hash} AND model=${model}
    RETURNING embedding::text AS embedding
  `;
  if (cached?.embedding) return String(cached.embedding);
  const [feature] = await sql`
    SELECT embedding_vector::text AS embedding FROM product_image_features
    WHERE url_hash=${hash} AND model=${model} AND status='ready' AND embedding_vector IS NOT NULL
    LIMIT 1
  `;
  if (!feature?.embedding) return null;
  const embedding = String(feature.embedding);
  await sql`
    INSERT INTO image_embedding_cache(url_hash,model,image_url,embedding,hits)
    VALUES(${hash},${model},${imageUrl},${embedding}::vector(512),1)
    ON CONFLICT(url_hash,model) DO UPDATE SET hits=image_embedding_cache.hits+1,last_used_at=now()
  `;
  return embedding;
}

async function saveEmbedding(imageUrl: string, model: string, embedding: string) {
  const sql = getDb();
  await sql`
    INSERT INTO image_embedding_cache(url_hash,model,image_url,embedding)
    VALUES(${urlHash(imageUrl)},${model},${imageUrl},${embedding}::vector(512))
    ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,embedding=excluded.embedding,last_used_at=now()
  `;
}

async function findCandidates(embedding: string, model: string, threshold: number, excludeProductIds: string[]) {
  const sql = getDb();
  const nearest = await sql`
    SELECT f.product_id, 1 - (f.embedding_vector <=> ${embedding}::vector) AS similarity
    FROM product_image_features f
    WHERE f.status='ready' AND f.model=${model} AND f.embedding_vector IS NOT NULL
      AND NOT (f.product_id = ANY(${excludeProductIds}::uuid[]))
    ORDER BY f.embedding_vector <=> ${embedding}::vector
    LIMIT 100
  `;
  const best = new Map<string, number>();
  for (const feature of nearest) {
    const productId = String(feature.productId); const score = Number(feature.similarity);
    if (score >= threshold && score > (best.get(productId) ?? -1)) best.set(productId, score);
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
  return {
    ranked,
    candidates: ranked.flatMap(([id, similarity]) => {
      const product = byId.get(id);
      return product ? [{ ...product, similarity }] : [];
    }),
  };
}

export async function POST(request: Request) {
  const totalStarted = performance.now();
  try {
    const user = await requireUser("products:create");
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const settings = await getMatchSettings();
    try {
      const cacheStarted = performance.now();
      let embedding = await cachedEmbedding(input.imageUrl, settings.model);
      const timings: RecognitionTimings = { cacheHit: Boolean(embedding), cacheMs: elapsed(cacheStarted) };
      if (!embedding) {
        const result = await embedImage(input.imageUrl);
        if (result.model !== settings.model) throw new Error("图片识别模型正在升级，请稍后重试");
        embedding = vectorLiteral(result.embedding);
        Object.assign(timings, result.timings, { cacheHit: false });
        await saveEmbedding(input.imageUrl, settings.model, embedding);
      }
      const lookupStarted = performance.now();
      const { candidates, ranked } = await findCandidates(embedding, settings.model, settings.threshold, input.excludeProductIds);
      timings.lookupMs = elapsed(lookupStarted);
      timings.totalMs = elapsed(totalStarted);
      const status = candidates.length ? "matched" : "no_match";
      const [run] = await sql`
        INSERT INTO image_match_runs(user_id, image_url, image_url_hash, threshold_mode, threshold, status, candidates, timings)
        VALUES (${user.id}, ${input.imageUrl}, ${urlHash(input.imageUrl)}, ${settings.mode}, ${settings.threshold}, ${status}, ${sql.json(candidates as never)}, ${sql.json(timings as never)})
        RETURNING id
      `;
      if (status === "no_match") await sql`UPDATE image_match_runs SET decision='new',decided_at=now() WHERE id=${run.id}`;
      await writeAudit(user, "image.match", "image_match", String(run.id), candidates.length ? `图片识别发现 ${candidates.length} 个疑似同款` : "图片识别未发现疑似同款", { imageUrl: input.imageUrl, mode: settings.mode, threshold: settings.threshold, candidates: ranked, timings }, requestIp(request));
      return ok({ runId: run.id, status, candidates, mode: settings.mode, threshold: settings.threshold, timings });
    } catch (reason) {
      const message = reason instanceof Error && reason.name === "AbortError" ? "图片识别超时，请重试" : reason instanceof Error ? reason.message : "图片识别失败";
      const timings: RecognitionTimings = { ...((reason as Error & { timings?: RecognitionTimings })?.timings || {}), totalMs: elapsed(totalStarted) };
      const [run] = await sql`
        INSERT INTO image_match_runs(user_id, image_url, image_url_hash, threshold_mode, threshold, status, error, timings)
        VALUES (${user.id}, ${input.imageUrl}, ${urlHash(input.imageUrl)}, ${settings.mode}, ${settings.threshold}, 'failed', ${message.slice(0, 1000)}, ${sql.json(timings as never)}) RETURNING id
      `;
      await writeAudit(user, "image.match_failed", "image_match", String(run.id), "图片识别失败", { imageUrl: input.imageUrl, error: message, timings }, requestIp(request));
      return ok({ runId: run.id, status: "failed", candidates: [], message, timings });
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
