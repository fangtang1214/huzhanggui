import postgres from "postgres";
import { createDecipheriv, createHash } from "node:crypto";

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const visionUrl = process.env.VISION_URL || "http://vision:3100";
const modelVersion = process.env.IMAGE_MODEL || "Xenova/clip-vit-base-patch32:q8";
const defaultGlmModel = "glm-4.6v-flash";
const glmModels = new Set([defaultGlmModel, "glm-4.6v-flashx", "glm-4.6v"]);
const glmEndpoint = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const hash = (value) => createHash("sha256").update(value.trim()).digest("hex");
const vectorLiteral = (values) => `[${values.map(Number).join(",")}]`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function syncUrls() {
  const missing = await sql`SELECT p.id AS product_id, trim(images.image_url) AS image_url
    FROM products p CROSS JOIN LATERAL jsonb_array_elements_text(p.image_urls) AS images(image_url)
    WHERE trim(images.image_url) <> '' AND NOT EXISTS (
      SELECT 1 FROM product_image_features f WHERE f.product_id=p.id AND f.image_url=trim(images.image_url)
    )`;
  for (const item of missing) await sql`INSERT INTO product_image_features(product_id,image_url,url_hash,model)
    VALUES(${item.product_id},${item.image_url},${hash(item.image_url)},${modelVersion}) ON CONFLICT(product_id,url_hash) DO NOTHING`;
  await sql`DELETE FROM product_image_features f WHERE NOT EXISTS (
    SELECT 1 FROM products p CROSS JOIN LATERAL jsonb_array_elements_text(p.image_urls) AS images(image_url)
    WHERE p.id=f.product_id AND trim(images.image_url)=f.image_url
  )`;
  await sql`DELETE FROM image_subject_cache c WHERE NOT EXISTS (
    SELECT 1 FROM product_image_features f WHERE f.url_hash=c.url_hash
  )`;
  const [setting] = await sql`SELECT value FROM app_settings WHERE key='glm_image_matching'`;
  if (["running", "paused"].includes(setting?.value?.indexingStatus)) {
    await sql`UPDATE product_image_features SET subject_status='pending',subject_updated_at=now() WHERE subject_status='waiting'`;
  }
}

function decryptApiKey(value) {
  const [version, iv, tag, encrypted] = String(value || "").split(":");
  if (version !== "v1" || !iv || !tag || !encrypted || !process.env.SESSION_SECRET) throw new Error("GLM API 密钥配置无效");
  const key = createHash("sha256").update(`huzhanggui:glm:${process.env.SESSION_SECRET}`).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function parseJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced || String(text)).trim();
  const start = source.indexOf("{"); const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("GLM 返回内容无法解析");
  return JSON.parse(source.slice(start, end + 1));
}

async function analyzeSubject(apiKey, imageUrl, glmModel) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(glmEndpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: glmModel, temperature: 0.05, messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: "找出图片中主要销售商品本体的最小外接框。忽略人物、手、背景、文字贴纸和非商品装饰。坐标按 0 到 1000 归一化。只返回 JSON：{\"box\":[xmin,ymin,xmax,ymax]}。" },
      ] }] }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `GLM 接口请求失败（${response.status}）`);
    const parsed = parseJson(payload?.choices?.[0]?.message?.content || "");
    if (!Array.isArray(parsed.box) || parsed.box.length !== 4) throw new Error("GLM 未识别出商品主体范围");
    const box = parsed.box.map((value) => Math.min(1000, Math.max(0, Number(value) || 0)));
    if (box[2] - box[0] < 10 || box[3] - box[1] < 10) throw new Error("GLM 返回的商品主体范围无效");
    return box;
  } finally { clearTimeout(timer); }
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
    const [cached] = await sql`UPDATE image_embedding_cache SET hits=hits+1,last_used_at=now()
      WHERE url_hash=${hash(item.image_url)} AND model=${modelVersion} RETURNING embedding::text AS embedding`;
    if (cached?.embedding) {
      await sql`UPDATE product_image_features SET status='ready',model=${modelVersion},embedding_vector=${cached.embedding}::vector(512),error=NULL,updated_at=now() WHERE id=${item.id}`;
      return true;
    }
    const response = await fetch(`${visionUrl}/embed`, { method: "POST", headers: { "content-type": "application/json", "x-vision-priority": "background" }, body: JSON.stringify({ imageUrl: item.image_url }) });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload.embedding)) throw new Error(payload.message || "识别失败");
    if (payload.model && payload.model !== modelVersion) throw new Error(`识别模型版本不一致：${payload.model}`);
    const embedding = vectorLiteral(payload.embedding);
    await sql.begin(async (tx) => {
      await tx`UPDATE product_image_features SET status = 'ready', model = ${modelVersion}, embedding = ${payload.embedding}, embedding_vector = ${embedding}::vector(512), error = NULL, updated_at = now() WHERE id = ${item.id}`;
      await tx`INSERT INTO image_embedding_cache(url_hash,model,image_url,embedding)
        VALUES(${hash(item.image_url)},${modelVersion},${item.image_url},${embedding}::vector(512))
        ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,embedding=excluded.embedding,last_used_at=now()`;
    });
  } catch (error) {
    await sql`UPDATE product_image_features SET status = 'failed', error = ${error instanceof Error ? error.message.slice(0, 1000) : "识别失败"}, updated_at = now() WHERE id = ${item.id}`;
  }
  return true;
}

async function processOneSubject() {
  const [settingRow] = await sql`SELECT value FROM app_settings WHERE key='glm_image_matching'`;
  const setting = settingRow?.value || {};
  if (setting.indexingStatus !== "running" || !setting.configured || !setting.apiKeyEncrypted) return false;
  const apiKey = decryptApiKey(setting.apiKeyEncrypted);
  const glmModel = glmModels.has(setting.model) ? setting.model : defaultGlmModel;
  await sql`UPDATE product_image_features SET subject_status='pending',subject_updated_at=now()
    WHERE subject_status='processing' AND subject_updated_at < now() - interval '10 minutes'`;
  await sql`UPDATE product_image_features f SET subject_status='ready',subject_box=c.subject_box,
      subject_embedding_vector=c.embedding,subject_model=${glmModel},subject_error=NULL,subject_updated_at=now()
    FROM image_subject_cache c
    WHERE f.url_hash=c.url_hash AND c.model=${glmModel} AND f.subject_status IN ('waiting','pending')`;
  const rows = await sql.begin(async (tx) => {
    const candidates = await tx`SELECT id,image_url,url_hash FROM product_image_features
      WHERE subject_status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!candidates.length) return [];
    await tx`UPDATE product_image_features SET subject_status='processing',subject_attempts=subject_attempts+1,subject_updated_at=now() WHERE id=${candidates[0].id}`;
    return candidates;
  });
  if (!rows.length) return false;
  const item = rows[0];
  try {
    const box = await analyzeSubject(apiKey, item.image_url, glmModel);
    const response = await fetch(`${visionUrl}/embed`, { method: "POST", headers: { "content-type": "application/json", "x-vision-priority": "background" }, body: JSON.stringify({ imageUrl: item.image_url, box }) });
    const payload = await response.json();
    if (!response.ok || !Array.isArray(payload.embedding)) throw new Error(payload.message || "商品主体特征生成失败");
    if (payload.model && payload.model !== modelVersion) throw new Error(`识别模型版本不一致：${payload.model}`);
    const embedding = vectorLiteral(payload.embedding);
    await sql.begin(async (tx) => {
      await tx`INSERT INTO image_subject_cache(url_hash,model,image_url,subject_box,embedding)
        VALUES(${item.url_hash},${glmModel},${item.image_url},${tx.json(box)},${embedding}::vector(512))
        ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,subject_box=excluded.subject_box,embedding=excluded.embedding,updated_at=now()`;
      await tx`UPDATE product_image_features SET subject_status='ready',subject_box=${tx.json(box)},subject_model=${glmModel},subject_embedding_vector=${embedding}::vector(512),subject_error=NULL,subject_updated_at=now()
        WHERE url_hash=${item.url_hash}`;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "GLM 商品主体识别失败";
    await sql`UPDATE product_image_features SET subject_status='failed',subject_error=${message},subject_updated_at=now() WHERE url_hash=${item.url_hash}`;
  }
  return true;
}

while (true) {
  try {
    await syncUrls();
    while (await processOne()) await delay(250);
    while (await processOneSubject()) await delay(250);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); }
  await delay(30_000);
}
