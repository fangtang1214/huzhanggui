import { createHash } from "node:crypto";
import { getDb } from "./db";
export { cosineSimilarity } from "./cosine";

export const IMAGE_MODEL = process.env.IMAGE_MODEL || "Xenova/clip-vit-base-patch32:q8";
export const MATCH_THRESHOLDS = { strict: 0.9, standard: 0.82, relaxed: 0.74 } as const;
export type MatchMode = keyof typeof MATCH_THRESHOLDS;

export type RecognitionTimings = {
  cacheHit?: boolean;
  cacheMs?: number;
  queueMs?: number;
  downloadMs?: number;
  decodeMs?: number;
  inferenceMs?: number;
  lookupMs?: number;
  totalMs?: number;
};

type VisionPayload = {
  embedding?: number[];
  message?: string;
  model?: string;
  timings?: RecognitionTimings;
};

export function urlHash(value: string) {
  return createHash("sha256").update(value.trim()).digest("hex");
}

export async function getMatchSettings() {
  const sql = getDb();
  const [row] = await sql`SELECT value FROM app_settings WHERE key = 'image_matching'`;
  const value = (row?.value || {}) as { mode?: MatchMode; model?: string };
  const mode = value.mode && value.mode in MATCH_THRESHOLDS ? value.mode : "standard";
  return { mode, threshold: MATCH_THRESHOLDS[mode], model: IMAGE_MODEL };
}

export async function embedImage(imageUrl: string, box?: [number, number, number, number], priority: "interactive" | "background" = "interactive", externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${process.env.VISION_URL || "http://127.0.0.1:3100"}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vision-priority": priority },
      body: JSON.stringify({ imageUrl, box }),
      signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
    });
    const payload = await response.json() as VisionPayload;
    if (!response.ok || !Array.isArray(payload.embedding)) {
      const error = new Error(payload.message || "图片识别服务暂时不可用") as Error & { timings?: RecognitionTimings };
      error.timings = payload.timings;
      throw error;
    }
    return { embedding: payload.embedding, timings: payload.timings || {}, model: payload.model || IMAGE_MODEL };
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedImageBase64(imageBase64: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${process.env.VISION_URL || "http://127.0.0.1:3100"}/embed-base64`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
      signal: controller.signal,
    });
    const payload = await response.json() as VisionPayload;
    if (!response.ok || !Array.isArray(payload.embedding)) {
      const error = new Error(payload.message || "图片识别服务暂时不可用") as Error & { timings?: RecognitionTimings };
      error.timings = payload.timings;
      throw error;
    }
    return { embedding: payload.embedding, timings: payload.timings || {}, model: payload.model || IMAGE_MODEL };
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncProductImageQueue(productId: string, imageUrls: string[], existingTx?: unknown) {
  const unique = Array.from(new Set(imageUrls.map((url) => url.trim()).filter(Boolean)));
  const run = (existingTx as { unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> }) || getDb();
  for (const imageUrl of unique) {
    await run.unsafe(
      `INSERT INTO product_image_features(product_id, image_url, url_hash, model)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(product_id, url_hash) DO UPDATE SET
         image_url = excluded.image_url,
         status = CASE WHEN product_image_features.model = excluded.model THEN product_image_features.status ELSE 'pending' END,
         embedding = CASE WHEN product_image_features.model = excluded.model THEN product_image_features.embedding ELSE NULL END,
         embedding_vector = CASE WHEN product_image_features.model = excluded.model THEN product_image_features.embedding_vector ELSE NULL END,
         error = CASE WHEN product_image_features.model = excluded.model THEN product_image_features.error ELSE NULL END,
         attempts = CASE WHEN product_image_features.model = excluded.model THEN product_image_features.attempts ELSE 0 END,
         model = excluded.model,
         updated_at = now()`,
      [productId, imageUrl, urlHash(imageUrl), IMAGE_MODEL],
    );
  }
  if (unique.length) {
    await run.unsafe(`DELETE FROM product_image_features WHERE product_id = $1 AND NOT (image_url = ANY($2::text[]))`, [productId, unique]);
  } else {
    await run.unsafe(`DELETE FROM product_image_features WHERE product_id = $1`, [productId]);
  }
  await run.unsafe(
    `WITH glm_setting AS (
       SELECT COALESCE(
         (SELECT NULLIF(value->>'model', '') FROM app_settings WHERE key = 'glm_image_matching'),
         'glm-4.6v-flash'
       ) AS model
     ), cached_subjects AS (
       SELECT DISTINCT ON (feature.id)
         feature.id, cache.subject_box, cache.embedding, cache.model, cache.box_source
       FROM product_image_features feature
       CROSS JOIN glm_setting setting
       JOIN image_subject_cache cache
         ON cache.url_hash = feature.url_hash
        AND cache.model IN (setting.model, 'glm-4.6v-flash')
       WHERE feature.product_id = $1
         AND feature.subject_status IN ('waiting', 'pending')
       ORDER BY feature.id, (cache.model = setting.model) DESC, cache.updated_at DESC
     )
     UPDATE product_image_features feature
     SET subject_status = 'ready',
         subject_box = cached.subject_box,
         subject_embedding_vector = cached.embedding,
         subject_model = cached.model,
         subject_error = NULL,
         subject_box_source = cached.box_source,
         subject_updated_at = now()
     FROM cached_subjects cached
     WHERE feature.id = cached.id`,
    [productId],
  );
}
