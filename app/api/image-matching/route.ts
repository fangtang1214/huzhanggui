import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { analyzeSubjectsWithFallback, GLM_MODEL, getGlmRuntime, SUBJECT_BATCH_SIZE, SUBJECT_STAGE_TIMEOUT_MS, type GlmModel, type LocatedSubject, type SubjectBox } from "@/lib/glm-vision";
import { embedImage, getMatchSettings, urlHash } from "@/lib/image-matching";
import { groupImageMatchFailures } from "@/lib/image-match-failures";
import { imageUrlSchema } from "@/lib/image-url";

const schema = z.object({
  imageUrls: z.array(imageUrlSchema).min(1).max(100),
  productName: z.string().trim().max(500).optional(),
  apiProductId: z.string().trim().max(100).optional().nullable(),
  excludeProductIds: z.array(z.string().uuid()).max(100).default([]),
});

const REALTIME_IMAGE_LIMIT = 8;
const REALTIME_TOTAL_TIMEOUT_MS = 10_000;
const REALTIME_WORK_TIMEOUT_MS = REALTIME_TOTAL_TIMEOUT_MS - 1_000;

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

async function exactImageMatches(imageUrls: string[], excluded: string[]): Promise<Array<Record<string, unknown>>> {
  const uniqueUrls = [...new Set(imageUrls.map((imageUrl) => imageUrl.trim()).filter(Boolean))];
  if (!uniqueUrls.length) return [];
  const sql = getDb();
  const rows = await sql`
    WITH incoming(image_url, image_order) AS (
      SELECT trim(value), ordinality::int
      FROM unnest(${uniqueUrls}::text[]) WITH ORDINALITY AS input(value, ordinality)
    )
    SELECT p.id AS product_id, incoming.image_url, incoming.image_order
    FROM incoming
    JOIN products p ON EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(p.image_urls) AS stored(image_url)
      WHERE trim(stored.image_url) = incoming.image_url
    )
    WHERE NOT(p.id=ANY(${excluded}::uuid[]))
    ORDER BY incoming.image_order, p.archived, p.updated_at DESC
  `;
  const matches = new Map<string, { imageUrl: string; imageOrder: number; matchedImageCount: number }>();
  for (const row of rows) {
    const productId = String(row.productId);
    const current = matches.get(productId);
    if (current) current.matchedImageCount += 1;
    else matches.set(productId, { imageUrl: String(row.imageUrl), imageOrder: Number(row.imageOrder), matchedImageCount: 1 });
  }
  const ranked = [...matches.entries()].sort((left, right) => left[1].imageOrder - right[1].imageOrder).slice(0, 5);
  const products = await productsByIds(ranked.map(([productId]) => productId));
  const byId = new Map(products.map((product) => [String(product.id), product]));
  return ranked.flatMap(([productId, match]) => {
    const product = byId.get(productId);
    return product ? [{
      ...product,
      similarity: 1,
      localSimilarity: 1,
      matchedImageCount: match.matchedImageCount,
      matchedImageUrl: match.imageUrl,
      newMatchedImageUrl: match.imageUrl,
      matchType: "exact_image",
    }] : [];
  });
}

async function cachedSubjects(imageUrls: string[], glmModel: GlmModel) {
  const sql = getDb();
  const hashes = imageUrls.map(urlHash);
  const [cacheRows, manualRows] = await Promise.all([
    sql`SELECT DISTINCT ON (url_hash) url_hash,subject_box,embedding::text AS embedding,box_source,model FROM image_subject_cache
      WHERE url_hash=ANY(${hashes}::text[]) AND model IN (${glmModel},${GLM_MODEL})
      ORDER BY url_hash,(model=${glmModel}) DESC`,
    sql`SELECT DISTINCT ON (url_hash) url_hash,subject_box FROM product_image_features
      WHERE url_hash=ANY(${hashes}::text[]) AND subject_box_source='manual' AND subject_box IS NOT NULL ORDER BY url_hash,updated_at DESC`,
  ]);
  const results = new Map<string, { box: SubjectBox; embedding: string | null; manual: boolean; model: GlmModel }>();
  for (const row of cacheRows) {
    if (row.embedding && Array.isArray(row.subjectBox)) results.set(String(row.urlHash), { box: row.subjectBox as SubjectBox, embedding: String(row.embedding), manual: row.boxSource === "manual", model: row.model as GlmModel });
  }
  for (const row of manualRows) {
    if (Array.isArray(row.subjectBox) && !results.has(String(row.urlHash))) results.set(String(row.urlHash), { box: row.subjectBox as SubjectBox, embedding: null, manual: true, model: glmModel });
  }
  return results;
}

async function saveSubject(imageUrl: string, box: SubjectBox, embedding: string, glmModel: GlmModel, manual = false) {
  const sql = getDb();
  await sql`INSERT INTO image_subject_cache(url_hash,model,image_url,subject_box,embedding,box_source)
    VALUES(${urlHash(imageUrl)},${glmModel},${imageUrl},${sql.json(box)},${embedding}::vector(512),${manual ? "manual" : "glm"})
    ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,subject_box=excluded.subject_box,
      embedding=excluded.embedding,box_source=excluded.box_source,updated_at=now()
    WHERE image_subject_cache.box_source<>'manual' OR excluded.box_source='manual'`;
}

async function embedLocatedSubject(imageUrl: string, located: Pick<LocatedSubject, "box" | "model" | "fallbackUsed">, model: string, signal: AbortSignal, manual = false) {
  const result = await embedImage(imageUrl, located.box, "interactive", signal);
  if (result.model !== model) throw new Error("图片识别模型正在升级，请稍后重试");
  const subject = vectorLiteral(result.embedding);
  await saveSubject(imageUrl, located.box, subject, located.model, manual);
  return { subject, imageUrl, box: located.box, subjectModel: located.model, fallbackUsed: located.fallbackUsed, cacheHit: false };
}

type SubjectVectorResult = Awaited<ReturnType<typeof embedLocatedSubject>>;
type SubjectVectorFailure = { imageUrl: string; message: string };

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length); let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) { const index = nextIndex++; results[index] = await mapper(items[index]); }
  }));
  return results;
}

function createLimiter(limit: number) {
  let active = 0; const queue: Array<() => void> = [];
  const next = () => { active -= 1; queue.shift()?.(); };
  return async <T>(task: () => Promise<T>) => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try { return await task(); } finally { next(); }
  };
}

function groupsOf<T>(items: T[], size: number) {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

async function collectSubjectVectors(imageUrls: string[], model: string, apiKey: string, glmModel: GlmModel, signal: AbortSignal, productName?: string) {
  const uniqueUrls = [...new Set(imageUrls)].slice(0, REALTIME_IMAGE_LIMIT);
  const primaryImageUrl = uniqueUrls[0];
  const skippedImageCount = Math.max(0, new Set(imageUrls).size - uniqueUrls.length);
  const cached = await cachedSubjects(uniqueUrls, glmModel);
  const vectors: SubjectVectorResult[] = []; const failures: SubjectVectorFailure[] = [];
  const uncached: string[] = []; const embeddingTasks: Array<Promise<void>> = [];
  const limitEmbedding = createLimiter(2);
  const addEmbedding = (imageUrl: string, located: Pick<LocatedSubject, "box" | "model" | "fallbackUsed">, manual = false) => {
    const task = limitEmbedding(async () => {
      if (signal.aborted) throw new DOMException("识别已超时", "AbortError");
      const vector = await embedLocatedSubject(imageUrl, located, model, signal, manual);
      vectors.push(vector);
    }).catch((error) => { failures.push({ imageUrl, message: error instanceof Error ? error.message : "本地主体特征提取失败" }); });
    embeddingTasks.push(task);
  };

  for (const imageUrl of uniqueUrls) {
    const item = cached.get(urlHash(imageUrl));
    if (item?.embedding) {
      vectors.push({ subject: item.embedding, imageUrl, box: item.box, subjectModel: item.model, fallbackUsed: item.model !== glmModel, cacheHit: true });
    } else if (item?.manual) {
      addEmbedding(imageUrl, { box: item.box, model: item.model, fallbackUsed: false }, true);
    } else uncached.push(imageUrl);
  }

  const primaryUncached = uncached.includes(primaryImageUrl) ? primaryImageUrl : null;
  const remainingUncached = primaryUncached ? uncached.filter((imageUrl) => imageUrl !== primaryUncached) : uncached;
  const recognitionGroups = [
    ...(primaryUncached ? [[primaryUncached]] : []),
    ...groupsOf(remainingUncached, SUBJECT_BATCH_SIZE),
  ];
  const glmSignal = AbortSignal.any([signal, AbortSignal.timeout(SUBJECT_STAGE_TIMEOUT_MS)]);
  await mapWithConcurrency(recognitionGroups, 2, async (group) => {
    if (glmSignal.aborted) {
      failures.push(...group.map((imageUrl) => ({ imageUrl, message: "商品主体定位超过 7 秒" })));
      return;
    }
    try {
      const located = await analyzeSubjectsWithFallback(apiKey, group.map((imageUrl) => ({ imageUrl, productName })), glmModel, glmSignal);
      const byUrl = new Map(located.map((item) => [item.imageUrl, item]));
      for (const imageUrl of group) {
        const item = byUrl.get(imageUrl);
        if (item) addEmbedding(imageUrl, item);
        else failures.push({ imageUrl, message: "GLM 未返回该图片的主体范围" });
      }
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError" ? "商品主体定位超过 7 秒" : error instanceof Error ? error.message : "GLM 商品主体定位失败";
      failures.push(...group.map((imageUrl) => ({ imageUrl, message })));
    }
  });
  await Promise.all(embeddingTasks);
  return {
    vectors,
    failures,
    skippedImageCount,
    requestedImageCount: new Set(imageUrls).size,
    primaryProcessed: vectors.some((vector) => vector.imageUrl === primaryImageUrl),
  };
}

async function findCandidates(vectors: SubjectVectorResult[], threshold: number, excluded: string[]) {
  const sql = getDb();
  const matches = new Map<string, Array<{ score: number; newImageUrl: string; newBox: SubjectBox; historyImageUrl: string; historyBox: SubjectBox | null }>>();
  const resultSets = await Promise.all(vectors.map(async (vector) => ({ vector, rows: await sql`SELECT product_id,image_url,subject_box,1-(subject_embedding_vector <=> ${vector.subject}::vector) AS similarity
      FROM product_image_features WHERE subject_status='ready' AND subject_embedding_vector IS NOT NULL
      AND NOT(product_id=ANY(${excluded}::uuid[])) ORDER BY subject_embedding_vector <=> ${vector.subject}::vector LIMIT 200` })));
  for (const { vector, rows } of resultSets) {
    const bestForImage = new Map<string, { score: number; historyImageUrl: string; historyBox: SubjectBox | null }>();
    for (const row of rows) {
      const id = String(row.productId); const score = Number(row.similarity);
      if (score < threshold || bestForImage.has(id)) continue;
      bestForImage.set(id, { score, historyImageUrl: String(row.imageUrl), historyBox: Array.isArray(row.subjectBox) ? row.subjectBox as SubjectBox : null });
    }
    for (const [id, match] of bestForImage) {
      const entries = matches.get(id) || [];
      entries.push({ ...match, newImageUrl: vector.imageUrl, newBox: vector.box }); matches.set(id, entries);
    }
  }
  const ranked = [...matches.entries()].map(([id, entries]) => {
    const sorted = entries.sort((a, b) => b.score - a.score); const best = sorted[0]; const second = sorted[1];
    const similarity = second ? best.score * 0.8 + second.score * 0.2 : best.score;
    return { id, similarity, matchedImageCount: sorted.length, ...best };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  const products = await productsByIds(ranked.map((item) => item.id));
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const output: Array<Record<string, unknown>> = [];
  for (const item of ranked) {
    const product = byId.get(item.id);
    if (product) output.push({ ...product, similarity: item.similarity, localSimilarity: item.similarity, matchedImageCount: item.matchedImageCount, matchedImageUrl: item.historyImageUrl, matchedSubjectBox: item.historyBox, newMatchedImageUrl: item.newImageUrl, newSubjectBox: item.newBox });
  }
  return output;
}

function minimalCandidates(candidates: Array<Record<string, unknown>>) {
  return candidates.map((candidate) => ({ id: candidate.id, sku: candidate.sku, name: candidate.name, similarity: candidate.similarity, matchedImageCount: candidate.matchedImageCount }));
}

async function createRun(userId: string, imageUrl: string, mode: string, threshold: number, status: "matched" | "no_match" | "failed", candidates: Array<Record<string, unknown>> = [], error?: string, timings: Record<string, unknown> = {}) {
  const sql = getDb();
  const [run] = await sql`INSERT INTO image_match_runs(user_id,image_url,image_url_hash,threshold_mode,threshold,status,candidates,error,timings)
    VALUES(${userId},${imageUrl},${urlHash(imageUrl)},${mode},${threshold},${status},${sql.json(minimalCandidates(candidates) as never)},${error || null},${sql.json(timings as never)}) RETURNING id`;
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
    const startedAt = performance.now();
    const user = await requireUser("products:create"); const input = schema.parse(await readJson(request)); const settings = await getMatchSettings();
    const primary = input.imageUrls[0]; const exact = await exactIdMatch(input.apiProductId);
    if (exact) {
      const timings = { totalMs: Math.round(performance.now() - startedAt), cacheHit: true, processedImageCount: 0, failedImageCount: 0 };
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "matched", [exact], undefined, timings);
      await writeAudit(user, "image.id_match", "image_match", runId, `商品 ID 已直接匹配货号 ${exact.sku}`, { apiProductId: input.apiProductId }, requestIp(request));
      return ok({ runId, status: "id_match", candidates: [{ ...exact, similarity: 1, localSimilarity: 1, matchType: "product_id" }], timings });
    }
    const exactImages = await exactImageMatches([primary], input.excludeProductIds);
    if (exactImages.length) {
      const exactImage = exactImages[0];
      const message = `主图链接完全一致，已直接判定与 ${String(exactImage.sku)} 为同款`;
      const timings = { totalMs: Math.round(performance.now() - startedAt), cacheHit: true, processedImageCount: 0, failedImageCount: 0, exactImageMatch: true };
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "matched", [exactImage], message, timings);
      await writeAudit(user, "image.exact_match", "image_match", runId, message, { productId: String(exactImage.id) }, requestIp(request));
      return ok({ runId, status: "exact_match", candidates: [exactImage], message, failureReasons: [], timings });
    }
    // Reserve the final second for local vector lookup, ranking, audit recording and the HTTP response.
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), REALTIME_WORK_TIMEOUT_MS);
    try {
      const { apiKey, model: glmModel } = await getGlmRuntime();
      const collected = await collectSubjectVectors(input.imageUrls, settings.model, apiKey, glmModel, timeout.signal, input.productName);
      const unprocessedCount = collected.failures.length + collected.skippedImageCount;
      const coverageMessage = unprocessedCount ? `已使用 ${collected.vectors.length} 张图片完成比对，另 ${unprocessedCount} 张因超时、失败或超过实时上限未参与` : undefined;
      const failureReasons = groupImageMatchFailures(input.imageUrls, collected.failures, REALTIME_IMAGE_LIMIT);
      const timingBase = { cacheHit: collected.vectors.length > 0 && collected.vectors.every((item) => item.cacheHit), processedImageCount: collected.vectors.length, failedImageCount: unprocessedCount, requestedImageCount: collected.requestedImageCount, fallbackCount: collected.vectors.filter((item) => item.fallbackUsed).length, primaryProcessed: collected.primaryProcessed };
      if (!collected.vectors.length) {
        const message = "所有参与识别的图片均处理失败，请查看下方具体原因";
        const timings = { ...timingBase, totalMs: Math.round(performance.now() - startedAt) };
        const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "failed", [], message, timings);
        await writeAudit(user, "image.match_failed", "image_match", runId, message, { failures: collected.failures.slice(0, 8) }, requestIp(request));
        return ok({ runId, status: "failed", candidates: [], message, failureReasons, timings });
      }
      const candidates = await findCandidates(collected.vectors, settings.threshold, input.excludeProductIds);
      const timings = { ...timingBase, totalMs: Math.round(performance.now() - startedAt) };
      if (candidates.length) {
        const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "matched", candidates, coverageMessage, timings);
        await writeAudit(user, "image.match", "image_match", runId, `本地主体特征发现 ${candidates.length} 个疑似同款`, { candidateCount: candidates.length, imageCount: collected.vectors.length, unprocessedCount, fallbackCount: timingBase.fallbackCount, primaryProcessed: collected.primaryProcessed }, requestIp(request));
        return ok({ runId, status: "matched", candidates, message: coverageMessage, failureReasons, timings });
      }
      if (!collected.primaryProcessed) {
        const message = "主图未能完成主体定位与本地比对，暂时无法可靠判断是否存在同款，请重试";
        const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "failed", [], message, timings);
        await writeAudit(user, "image.match_failed", "image_match", runId, message, { imageCount: collected.vectors.length, unprocessedCount, failures: collected.failures.slice(0, 8) }, requestIp(request));
        return ok({ runId, status: "failed", candidates: [], message, failureReasons, timings });
      }
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "no_match", [], coverageMessage, timings);
      await writeAudit(user, "image.match", "image_match", runId, "本地主体特征未发现疑似同款", { candidateCount: 0, imageCount: collected.vectors.length, unprocessedCount, fallbackCount: timingBase.fallbackCount, primaryProcessed: true }, requestIp(request));
      return ok({ runId, status: "no_match", candidates: [], message: coverageMessage, failureReasons, timings });
    } catch (reason) {
      const message = reason instanceof Error && reason.name === "AbortError" ? "图片识别超过 10 秒，请重试或确认后继续" : reason instanceof Error ? reason.message : "GLM 图片识别失败";
      const affectedImages = [...new Set(input.imageUrls)].slice(0, REALTIME_IMAGE_LIMIT).map((imageUrl) => ({ imageUrl, message }));
      const failureReasons = groupImageMatchFailures(input.imageUrls, affectedImages, REALTIME_IMAGE_LIMIT);
      const timings = { totalMs: Math.round(performance.now() - startedAt) };
      const runId = await createRun(user.id, primary, settings.mode, settings.threshold, "failed", [], message.slice(0, 1000), timings);
      await writeAudit(user, "image.match_failed", "image_match", runId, "GLM 图片识别失败", undefined, requestIp(request));
      return ok({ runId, status: "failed", candidates: [], message, failureReasons, timings });
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
