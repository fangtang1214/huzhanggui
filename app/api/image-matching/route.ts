import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { analyzeSubject, getGlmRuntime, reviewCandidates, type GlmModel, type SubjectBox } from "@/lib/glm-vision";
import { embedImage, getMatchSettings, urlHash } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";

const schema = z.object({
  imageUrls: z.array(imageUrlSchema).min(1).max(100),
  apiProductId: z.string().trim().max(100).optional().nullable(),
  excludeProductIds: z.array(z.string().uuid()).max(100).default([]),
});

const vectorLiteral = (values: number[]) => `[${values.map(Number).join(",")}]`;

async function productsByIds(ids: string[]): Promise<Array<Record<string, unknown>>> {
  if (!ids.length) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT p.*,
      (SELECT coalesce(json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name), '[]')
       FROM product_departments pd JOIN departments d ON d.id=pd.department_id WHERE pd.product_id=p.id) AS departments,
      (SELECT coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name), '[]')
       FROM product_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.product_id=p.id) AS tags
    FROM products p WHERE p.id=ANY(${ids}::uuid[])
  `;
  return rows as unknown as Array<Record<string, unknown>>;
}

async function exactIdMatch(apiProductId?: string | null) {
  if (!apiProductId) return null;
  const sql = getDb();
  const rows = await sql`
    SELECT p.id FROM product_api_ids pai JOIN products p ON p.id=pai.product_id
    WHERE pai.is_current=true AND pai.value=${apiProductId}
    ORDER BY p.archived ASC, pai.created_at DESC LIMIT 1
  `;
  if (!rows.length) return null;
  return (await productsByIds([String(rows[0].id)]))[0] || null;
}

async function cachedFullEmbedding(imageUrl: string, model: string) {
  const sql = getDb(); const hash = urlHash(imageUrl);
  const [cached] = await sql`UPDATE image_embedding_cache SET hits=hits+1,last_used_at=now()
    WHERE url_hash=${hash} AND model=${model} RETURNING embedding::text AS embedding`;
  if (cached?.embedding) return String(cached.embedding);
  const [feature] = await sql`SELECT embedding_vector::text AS embedding FROM product_image_features
    WHERE url_hash=${hash} AND model=${model} AND status='ready' AND embedding_vector IS NOT NULL LIMIT 1`;
  return feature?.embedding ? String(feature.embedding) : null;
}

async function saveFullEmbedding(imageUrl: string, model: string, embedding: string) {
  const sql = getDb();
  await sql`INSERT INTO image_embedding_cache(url_hash,model,image_url,embedding)
    VALUES(${urlHash(imageUrl)},${model},${imageUrl},${embedding}::vector(512))
    ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,embedding=excluded.embedding,last_used_at=now()`;
}

async function cachedSubject(imageUrl: string, glmModel: GlmModel) {
  const sql = getDb();
  const [row] = await sql`SELECT subject_box,embedding::text AS embedding,box_source FROM image_subject_cache
    WHERE url_hash=${urlHash(imageUrl)} AND model=${glmModel}`;
  if (row?.embedding && Array.isArray(row.subjectBox)) return { box: row.subjectBox as SubjectBox, embedding: String(row.embedding), manual: row.boxSource === "manual" };
  const [manual] = await sql`SELECT subject_box FROM product_image_features
    WHERE url_hash=${urlHash(imageUrl)} AND subject_box_source='manual' AND subject_box IS NOT NULL LIMIT 1`;
  return Array.isArray(manual?.subjectBox) ? { box: manual.subjectBox as SubjectBox, embedding: null, manual: true } : null;
}

async function saveSubject(imageUrl: string, box: SubjectBox, embedding: string, glmModel: GlmModel, manual = false) {
  const sql = getDb();
  await sql`INSERT INTO image_subject_cache(url_hash,model,image_url,subject_box,embedding,box_source)
    VALUES(${urlHash(imageUrl)},${glmModel},${imageUrl},${sql.json(box)},${embedding}::vector(512),${manual ? "manual" : "glm"})
    ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,subject_box=excluded.subject_box,
      embedding=excluded.embedding,box_source=excluded.box_source,updated_at=now()
    WHERE image_subject_cache.box_source<>'manual' OR excluded.box_source='manual'`;
}

async function imageVectors(imageUrl: string, model: string, apiKey: string, glmModel: GlmModel, signal: AbortSignal) {
  let full = await cachedFullEmbedding(imageUrl, model);
  const subjectCached = await cachedSubject(imageUrl, glmModel);
  let subject = subjectCached?.embedding || null;
  if (!full) {
    const result = await embedImage(imageUrl, undefined, "interactive", signal);
    if (result.model !== model) throw new Error("图片识别模型正在升级，请稍后重试");
    full = vectorLiteral(result.embedding); await saveFullEmbedding(imageUrl, model, full);
  }
  if (!subject) {
    const box = subjectCached?.manual ? subjectCached.box : await analyzeSubject(apiKey, imageUrl, glmModel, signal);
    const result = await embedImage(imageUrl, box, "interactive", signal);
    if (result.model !== model) throw new Error("图片识别模型正在升级，请稍后重试");
    subject = vectorLiteral(result.embedding); await saveSubject(imageUrl, box, subject, glmModel, Boolean(subjectCached?.manual));
  }
  return { full, subject };
}

async function findCandidates(vectors: Array<{ full: string; subject: string | null }>, model: string, threshold: number, excluded: string[]) {
  const sql = getDb(); const best = new Map<string, number>();
  const record = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const id = String(row.productId); const score = Number(row.similarity);
      if (score >= threshold && score > (best.get(id) ?? -1)) best.set(id, score);
    }
  };
  for (const vector of vectors) {
    if (vector.subject) record(await sql`SELECT product_id,1-(subject_embedding_vector <=> ${vector.subject}::vector) AS similarity
      FROM product_image_features WHERE subject_status='ready' AND subject_embedding_vector IS NOT NULL
      AND NOT(product_id=ANY(${excluded}::uuid[])) ORDER BY subject_embedding_vector <=> ${vector.subject}::vector LIMIT 100`);
    record(await sql`SELECT product_id,1-(embedding_vector <=> ${vector.full}::vector) AS similarity
      FROM product_image_features WHERE status='ready' AND model=${model} AND embedding_vector IS NOT NULL
      AND NOT(product_id=ANY(${excluded}::uuid[])) ORDER BY embedding_vector <=> ${vector.full}::vector LIMIT 100`);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const products = await productsByIds(ranked.map(([id]) => id));
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const output: Array<Record<string, unknown> & { localSimilarity: number }> = [];
  for (const [id, localSimilarity] of ranked) {
    const product = byId.get(id);
    if (product) output.push({ ...product, localSimilarity });
  }
  return output;
}

function minimalCandidates(candidates: Array<Record<string, unknown>>) {
  return candidates.map((candidate) => ({ id: candidate.id, sku: candidate.sku, name: candidate.name }));
}

async function createRun(userId: string, imageUrl: string, mode: string, threshold: number, status: "matched" | "no_match" | "failed", candidates: Array<Record<string, unknown>> = [], error?: string) {
  const sql = getDb();
  const [run] = await sql`INSERT INTO image_match_runs(user_id,image_url,image_url_hash,threshold_mode,threshold,status,candidates,error,timings)
    VALUES(${userId},${imageUrl},${urlHash(imageUrl)},${mode},${threshold},${status},${sql.json(minimalCandidates(candidates) as never)},${error || null},'{}'::jsonb) RETURNING id`;
  if (status === "no_match") await sql`UPDATE image_match_runs SET decision='new',decided_at=now() WHERE id=${run.id}`;
  return String(run.id);
}

export async function GET(request: Request) {
  try {
    await requireUser("products:create"); const sql = getDb(); const search = new URL(request.url).searchParams.get("search")?.trim() || "";
    if (!search) return ok({ rows: [] });
    const pattern = `%${search}%`;
    const rows = await sql`SELECT id FROM products WHERE sku ILIKE ${pattern} OR name ILIKE ${pattern}
      ORDER BY archived ASC,updated_at DESC LIMIT 12`;
    return ok({ rows: await productsByIds(rows.map((row) => String(row.id))) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create"); const input = schema.parse(await readJson(request)); const settings = await getMatchSettings();
    const primary = input.imageUrls[0]; const exact = await exactIdMatch(input.apiProductId);
    if (exact) {
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "matched", [exact]);
      await writeAudit(user, "image.id_match", "image_match", runId, `商品 ID 已直接匹配货号 ${exact.sku}`, { apiProductId: input.apiProductId }, requestIp(request));
      return ok({ runId, status: "id_match", candidates: [{ ...exact, similarity: 1, localSimilarity: 1, glmScore: 100, result: "same", evidence: ["达人橱窗商品 ID 与历史登记完全一致"], differences: [] }] });
    }
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), 90_000);
    try {
      const { apiKey, model: glmModel } = await getGlmRuntime();
      const vectors = await Promise.all(input.imageUrls.map((url) => imageVectors(url, settings.model, apiKey, glmModel, timeout.signal)));
      const local = await findCandidates(vectors, settings.model, settings.threshold, input.excludeProductIds);
      if (!local.length) {
        const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "no_match");
        await writeAudit(user, "image.match", "image_match", runId, "图片识别未发现疑似同款", { candidateCount: 0 }, requestIp(request));
        return ok({ runId, status: "no_match", candidates: [] });
      }
      const reviewInputs = local.map((candidate) => ({ id: String(candidate.id), sku: String(candidate.sku), name: String(candidate.name), imageUrls: Array.isArray(candidate.imageUrls) ? candidate.imageUrls.map(String) : [] }));
      const reviewGroups: typeof reviewInputs[] = [];
      for (let index = 0; index < reviewInputs.length; index += 5) reviewGroups.push(reviewInputs.slice(index, index + 5));
      const reviews = (await Promise.all(reviewGroups.map((group) => reviewCandidates(apiKey, input.imageUrls, group, glmModel, timeout.signal)))).flat();
      const reviewById = new Map(reviews.map((review) => [review.candidateId, review]));
      const candidates = local.flatMap((candidate) => {
        const review = reviewById.get(String(candidate.id));
        if (!review || review.result === "different") return [];
        const similarity = Number(candidate.localSimilarity) * 0.45 + review.score / 100 * 0.55;
        return [{ ...candidate, similarity, glmScore: review.score, result: review.result, evidence: review.evidence, differences: review.differences }];
      }).sort((a, b) => b.similarity - a.similarity).slice(0, 5);
      const status = candidates.length ? "matched" : "no_match";
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, status, candidates);
      await writeAudit(user, "image.match", "image_match", runId, candidates.length ? `图片识别发现 ${candidates.length} 个疑似同款` : "GLM 复核后未发现疑似同款", { candidateCount: candidates.length }, requestIp(request));
      return ok({ runId, status, candidates });
    } catch (reason) {
      const message = reason instanceof Error && reason.name === "AbortError" ? "GLM 图片识别超过 90 秒，请重试或确认后继续" : reason instanceof Error ? reason.message : "GLM 图片识别失败";
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "failed", [], message.slice(0, 1000));
      await writeAudit(user, "image.match_failed", "image_match", runId, "GLM 图片识别失败", undefined, requestIp(request));
      return ok({ runId, status: "failed", candidates: [], message });
    } finally { clearTimeout(timer); }
  } catch (error) { return apiError(error); }
}

const decisionSchema = z.object({ runId: z.string().uuid(), decision: z.enum(["matched", "new", "failed_continue"]), selectedProductId: z.string().uuid().optional().nullable(), manual: z.boolean().optional().default(false) });

export async function PATCH(request: Request) {
  try {
    const user = await requireUser("products:create"); const input = decisionSchema.parse(await readJson(request)); const sql = getDb();
    const [run] = await sql`SELECT status,candidates FROM image_match_runs WHERE id=${input.runId} AND user_id=${user.id}`;
    if (!run) return Response.json({ ok: false, message: "识别记录不存在" }, { status: 404 });
    if (input.decision === "failed_continue" && run.status !== "failed") return Response.json({ ok: false, message: "该识别记录并未失败" }, { status: 409 });
    let candidates = Array.isArray(run.candidates) ? run.candidates as Array<{ id?: string }> : [];
    if (input.decision === "matched" && input.manual && input.selectedProductId && !candidates.some((candidate) => String(candidate.id) === input.selectedProductId)) {
      const products = await productsByIds([input.selectedProductId]);
      if (!products.length) return Response.json({ ok: false, message: "所选商品不存在" }, { status: 404 });
      candidates = [...candidates, { id: String(products[0].id) }];
    }
    if (input.decision === "matched" && !candidates.some((candidate) => String(candidate.id) === input.selectedProductId)) return Response.json({ ok: false, message: "所选商品不在候选中" }, { status: 409 });
    await sql`UPDATE image_match_runs SET decision=${input.decision},selected_product_id=${input.selectedProductId || null},candidates=${sql.json(candidates as never)},decided_at=now() WHERE id=${input.runId}`;
    return ok({ saved: true });
  } catch (error) { return apiError(error); }
}
