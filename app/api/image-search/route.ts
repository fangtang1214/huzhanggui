import { z } from "zod";
import { apiError, ok, readJson } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { embedImage, getMatchSettings, RecognitionTimings, urlHash } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";

const schema = z.object({
  imageUrl: imageUrlSchema,
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

export async function POST(request: Request) {
  const totalStarted = performance.now();
  try {
    await requireUser("products:view");
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const settings = await getMatchSettings();
    let embedding: string | null = null;
    const timings: RecognitionTimings = {};
    const cacheStarted = performance.now();
    embedding = await cachedEmbedding(input.imageUrl, settings.model);
    timings.cacheHit = Boolean(embedding);
    timings.cacheMs = elapsed(cacheStarted);
    if (!embedding) {
      const result = await embedImage(input.imageUrl);
      embedding = vectorLiteral(result.embedding);
      Object.assign(timings, result.timings, { cacheHit: false });
      await sql`
        INSERT INTO image_embedding_cache(url_hash,model,image_url,embedding)
        VALUES(${urlHash(input.imageUrl)},${settings.model},${input.imageUrl},${embedding}::vector(512))
        ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,embedding=excluded.embedding,last_used_at=now()
      `;
    }
    const lookupStarted = performance.now();
    const nearest = await sql`
      SELECT f.product_id, 1 - (f.embedding_vector <=> ${embedding}::vector) AS similarity
      FROM product_image_features f
      JOIN products p ON p.id = f.product_id AND p.archived = false
      WHERE f.status='ready' AND f.model=${settings.model} AND f.embedding_vector IS NOT NULL
      ORDER BY f.embedding_vector <=> ${embedding}::vector
      LIMIT 50
    `;
    const best = new Map<string, number>();
    for (const feature of nearest) {
      const productId = String(feature.productId); const score = Number(feature.similarity);
      if (score >= settings.threshold && score > (best.get(productId) ?? -1)) best.set(productId, score);
    }
    const ranked = [...best.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20);
    const ids = ranked.map(([id]) => id);
    const products = ids.length ? await sql`
      SELECT p.id, p.sku, p.name, p.image_urls, p.price, p.store_name, p.product_url,
             count(DISTINCT s.id)::int AS sample_count
      FROM products p
      LEFT JOIN samples s ON s.product_id = p.id AND s.archived = false
      WHERE p.id = ANY(${ids}::uuid[])
      GROUP BY p.id
    ` : [];
    const byId = new Map(products.map((p) => [String(p.id), p]));
    const candidates = ranked.flatMap(([id, similarity]) => {
      const p = byId.get(id);
      return p ? [{ id: p.id, sku: p.sku, name: p.name, imageUrls: p.imageUrls, price: p.price, storeName: p.storeName, productUrl: p.productUrl, sampleCount: p.sampleCount, similarity: Math.round(similarity * 10000) / 100 }] : [];
    });
    timings.lookupMs = elapsed(lookupStarted);
    timings.totalMs = elapsed(totalStarted);
    return ok({ candidates, mode: settings.mode, timings });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return Response.json({ ok: false, message: "图片识别超时，请重试" }, { status: 500 });
    }
    return apiError(error);
  }
}
