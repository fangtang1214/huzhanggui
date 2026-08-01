import postgres from "postgres";
import { createHash } from "node:crypto";

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const visionUrl = process.env.VISION_URL || "http://vision:3100";
const hash = (value) => createHash("sha256").update(value.trim()).digest("hex");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function syncUrls() {
  const missing = await sql`SELECT p.id AS product_id, trim(images.image_url) AS image_url
    FROM products p CROSS JOIN LATERAL jsonb_array_elements_text(p.image_urls) AS images(image_url)
    WHERE trim(images.image_url) <> '' AND NOT EXISTS (
      SELECT 1 FROM product_image_features f WHERE f.product_id=p.id AND f.image_url=trim(images.image_url)
    )`;
  for (const item of missing) await sql`INSERT INTO product_image_features(product_id,image_url,url_hash)
    VALUES(${item.product_id},${item.image_url},${hash(item.image_url)}) ON CONFLICT(product_id,url_hash) DO NOTHING`;
  await sql`DELETE FROM product_image_features f WHERE NOT EXISTS (
    SELECT 1 FROM products p CROSS JOIN LATERAL jsonb_array_elements_text(p.image_urls) AS images(image_url)
    WHERE p.id=f.product_id AND trim(images.image_url)=f.image_url
  )`;
}

async function processOne() {
  await sql`UPDATE product_image_features SET status = 'pending' WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'`;
  const rows = await sql.begin(async (tx) => {
    const candidates = await tx`SELECT id, image_url FROM product_image_features
      WHERE status = 'pending' OR (status = 'failed' AND attempts < 3 AND updated_at < now() - interval '30 minutes')
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!candidates.length) return [];
    await tx`UPDATE product_image_features SET status = 'processing', attempts = attempts + 1, updated_at = now() WHERE id = ${candidates[0].id}`;
    return candidates;
  });
  if (!rows.length) return false;
  const item = rows[0];
  try {
    const response = await fetch(`${visionUrl}/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ imageUrl: item.image_url }) });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload.embedding)) throw new Error(payload.message || "识别失败");
    await sql`UPDATE product_image_features SET status = 'ready', embedding = ${payload.embedding}, error = NULL, updated_at = now() WHERE id = ${item.id}`;
  } catch (error) {
    await sql`UPDATE product_image_features SET status = 'failed', error = ${error instanceof Error ? error.message.slice(0, 1000) : "识别失败"}, updated_at = now() WHERE id = ${item.id}`;
  }
  return true;
}

while (true) {
  try {
    await syncUrls();
    while (await processOne()) await delay(250);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); }
  await delay(30_000);
}
