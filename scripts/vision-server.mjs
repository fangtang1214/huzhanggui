import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

const port = Number(process.env.VISION_PORT || 3100);
const maxBytes = 12 * 1024 * 1024;
const modelId = process.env.VISION_MODEL || "Xenova/clip-vit-base-patch32";
const modelDtype = process.env.VISION_DTYPE || "q8";
const modelVersion = `${modelId}:${modelDtype}`;
let extractorPromise;
let modelReady = false;
let warmupError = "";
let busy = false;
const interactiveQueue = [];
const backgroundQueue = [];

const elapsed = (started) => Math.round((performance.now() - started) * 10) / 10;

function isPrivate(address) {
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPrivate(value.slice(7));
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] >= 224;
}

async function validateUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("图片网址必须是公开的 HTTP 或 HTTPS 地址");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivate(item.address))) throw new Error("图片网址不能指向服务器内网");
  return url;
}

async function downloadImage(value, redirects = 0) {
  if (redirects > 4) throw new Error("图片网址跳转次数过多");
  const url = await validateUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "HuZhangGuiSampleImageMatcher/2.0", accept: "image/*" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("图片跳转地址无效");
      return downloadImage(new URL(location, url).toString(), redirects + 1);
    }
    if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) throw new Error("该网址返回的不是图片");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error("图片超过 12MB，无法识别");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("图片内容为空");
    const chunks = []; let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("图片超过 12MB，无法识别"); }
      chunks.push(chunk);
    }
    return new Blob(chunks, { type: contentType });
  } finally { clearTimeout(timer); }
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
      env.cacheDir = process.env.HF_HOME || "/models";
      env.allowRemoteModels = true;
      return pipeline("image-feature-extraction", modelId, { device: "cpu", dtype: modelDtype });
    }).catch((error) => {
      extractorPromise = undefined;
      throw error;
    });
  }
  return extractorPromise;
}

function normalizedVector(tensor) {
  const vector = Array.from(tensor.data, Number);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

async function warmModel() {
  const started = performance.now();
  try {
    const [{ RawImage }, extractor] = await Promise.all([import("@huggingface/transformers"), getExtractor()]);
    const pixels = new Uint8ClampedArray(32 * 32 * 3).fill(127);
    await extractor(new RawImage(pixels, 32, 32, 3));
    modelReady = true;
    warmupError = "";
    process.stdout.write(`Vision model ready: ${modelVersion} (${elapsed(started)}ms)\n`);
  } catch (error) {
    modelReady = false;
    warmupError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Vision model warmup failed: ${warmupError}\n`);
    setTimeout(() => void warmModel(), 30_000);
  }
}

async function embed(imageUrl) {
  const started = performance.now();
  const timings = {};
  try {
    const runtime = Promise.all([import("@huggingface/transformers"), getExtractor()]);
    const downloadStarted = performance.now();
    let blob;
    try { blob = await downloadImage(imageUrl); }
    finally { timings.downloadMs = elapsed(downloadStarted); }
    const [{ RawImage }, extractor] = await runtime;
    const decodeStarted = performance.now();
    let image;
    try { image = await RawImage.fromBlob(blob); }
    finally { timings.decodeMs = elapsed(decodeStarted); }
    const inferenceStarted = performance.now();
    let tensor;
    try { tensor = await extractor(image); }
    finally { timings.inferenceMs = elapsed(inferenceStarted); }
    return { embedding: normalizedVector(tensor), timings };
  } catch (error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    reason.timings = timings;
    throw reason;
  } finally {
    timings.totalMs = elapsed(started);
  }
}

function drainQueue() {
  if (busy) return;
  const job = interactiveQueue.shift() || backgroundQueue.shift();
  if (!job) return;
  busy = true;
  const queueMs = elapsed(job.enqueuedAt);
  Promise.resolve().then(() => embed(job.imageUrl)).then((result) => {
    result.timings.queueMs = queueMs;
    result.timings.totalMs = elapsed(job.enqueuedAt);
    job.resolve(result);
  }).catch((error) => {
    const reason = error instanceof Error ? error : new Error(String(error));
    reason.timings = { ...(reason.timings || {}), queueMs, totalMs: elapsed(job.enqueuedAt) };
    job.reject(reason);
  }).finally(() => {
    busy = false;
    queueMicrotask(drainQueue);
  });
}

function enqueue(imageUrl, priority) {
  return new Promise((resolve, reject) => {
    const queue = priority === "background" ? backgroundQueue : interactiveQueue;
    queue.push({ imageUrl, enqueuedAt: performance.now(), resolve, reject });
    drainQueue();
  });
}

function json(response, status, payload) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return json(response, modelReady ? 200 : 503, {
      ok: modelReady,
      ready: modelReady,
      model: modelVersion,
      error: warmupError || undefined,
      queue: { interactive: interactiveQueue.length, background: backgroundQueue.length, busy },
    });
  }
  if (request.method !== "POST" || request.url !== "/embed") return json(response, 404, { message: "Not found" });
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; if (raw.length > 20_000) request.destroy(); });
  request.on("end", () => {
    let imageUrl;
    try { imageUrl = JSON.parse(raw).imageUrl; if (typeof imageUrl !== "string") throw new Error(); }
    catch { return json(response, 400, { message: "图片网址无效" }); }
    const priority = request.headers["x-vision-priority"] === "background" ? "background" : "interactive";
    enqueue(imageUrl, priority).then(({ embedding, timings }) => json(response, 200, { embedding, model: modelVersion, dimensions: embedding.length, timings })).catch((error) => json(response, 422, { message: error instanceof Error && error.name === "AbortError" ? "图片读取超时，请检查图片网址" : error instanceof Error ? error.message : "图片识别失败", timings: error.timings || {} }));
  });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Vision service listening on ${port}\n`);
  void warmModel();
});
