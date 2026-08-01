import { createHash } from "node:crypto";
import { getDb } from "./db";
export { cosineSimilarity } from "./cosine";

export const IMAGE_MODEL = "Xenova/clip-vit-base-patch32";
export const MATCH_THRESHOLDS = { strict: 0.9, standard: 0.82, relaxed: 0.74 } as const;
export type MatchMode = keyof typeof MATCH_THRESHOLDS;

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

export async function embedImage(imageUrl: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${process.env.VISION_URL || "http://127.0.0.1:3100"}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageUrl }),
      signal: controller.signal,
    });
    const payload = await response.json() as { embedding?: number[]; message?: string };
    if (!response.ok || !Array.isArray(payload.embedding)) throw new Error(payload.message || "图片识别服务暂时不可用");
    return payload.embedding;
  } finally {
    clearTimeout(timeout);
  }
}

export async function syncProductImageQueue(productId: string, imageUrls: string[]) {
  const sql = getDb();
  const unique = Array.from(new Set(imageUrls.map((url) => url.trim()).filter(Boolean)));
  await sql.begin(async (tx) => {
    for (const imageUrl of unique) {
      await tx`
        INSERT INTO product_image_features(product_id, image_url, url_hash, model)
        VALUES (${productId}, ${imageUrl}, ${urlHash(imageUrl)}, ${IMAGE_MODEL})
        ON CONFLICT(product_id, url_hash) DO UPDATE SET image_url = excluded.image_url
      `;
    }
    if (unique.length) {
      await tx`DELETE FROM product_image_features WHERE product_id = ${productId} AND NOT (image_url = ANY(${unique}))`;
    } else {
      await tx`DELETE FROM product_image_features WHERE product_id = ${productId}`;
    }
  });
}
