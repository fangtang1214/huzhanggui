import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";

const port = Number(process.env.VISION_PORT || 3100);
const maxBytes = 12 * 1024 * 1024;
let extractorPromise;
let workQueue = Promise.resolve();

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
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "user-agent": "SiyuanSampleImageMatcher/1.0", accept: "image/*" } });
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
  if (!extractorPromise) extractorPromise = import("@huggingface/transformers").then(async ({ env, pipeline }) => {
    env.cacheDir = process.env.HF_HOME || "/models";
    env.allowRemoteModels = true;
    return pipeline("image-feature-extraction", "Xenova/clip-vit-base-patch32");
  });
  return extractorPromise;
}

async function embed(imageUrl) {
  const [{ RawImage }, extractor, blob] = await Promise.all([import("@huggingface/transformers"), getExtractor(), downloadImage(imageUrl)]);
  const image = await RawImage.fromBlob(blob);
  const tensor = await extractor(image);
  const vector = Array.from(tensor.data, Number);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: true });
  if (request.method !== "POST" || request.url !== "/embed") return json(response, 404, { message: "Not found" });
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; if (raw.length > 20_000) request.destroy(); });
  request.on("end", () => {
    let imageUrl;
    try { imageUrl = JSON.parse(raw).imageUrl; if (typeof imageUrl !== "string") throw new Error(); }
    catch { return json(response, 400, { message: "图片网址无效" }); }
    const task = workQueue.then(() => embed(imageUrl));
    workQueue = task.catch(() => undefined);
    task.then((embedding) => json(response, 200, { embedding, model: "Xenova/clip-vit-base-patch32", dimensions: embedding.length })).catch((error) => json(response, 422, { message: error instanceof Error ? error.message : "图片识别失败" }));
  });
}).listen(port, "0.0.0.0", () => process.stdout.write(`Vision service listening on ${port}\n`));
