import dns from "node:dns/promises";
import net from "node:net";
import sharp from "sharp";

export const WECOM_IMAGE_INPUT_MAX_BYTES = 12 * 1024 * 1024;
export const WECOM_IMAGE_OUTPUT_MAX_BYTES = 1024 * 1024;
const imageTimeoutMs = 20_000;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

function isPrivateAddress(address) {
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd")
      || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254
    || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] >= 224;
}

async function validatePublicImageUrl(value, lookupImpl) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new Error("图片网址格式不正确"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("图片网址必须是公开的 HTTP 或 HTTPS 地址");
  }
  const addresses = await lookupImpl(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error("图片网址不能指向服务器内网");
  return url;
}

async function responseBuffer(response) {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > WECOM_IMAGE_INPUT_MAX_BYTES) throw new Error("原图超过 12MB");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("图片内容为空");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WECOM_IMAGE_INPUT_MAX_BYTES) {
      await reader.cancel();
      throw new Error("原图超过 12MB");
    }
    chunks.push(Buffer.from(value));
  }
  if (!size) throw new Error("图片内容为空");
  return Buffer.concat(chunks, size);
}

async function downloadImage(value, fetchImpl, lookupImpl, redirects = 0) {
  if (redirects > 4) throw new Error("图片网址跳转次数过多");
  const url = await validatePublicImageUrl(value, lookupImpl);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "manual",
      headers: { "user-agent": "HuZhangGui-WeCom-Sync/1.0", accept: "image/*" },
      signal: AbortSignal.timeout(imageTimeoutMs),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "图片下载超时" : "图片无法下载");
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("图片跳转地址无效");
    return downloadImage(new URL(location, url).toString(), fetchImpl, lookupImpl, redirects + 1);
  }
  if (!response.ok) throw new Error(`图片读取失败（${response.status}）`);
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!allowedImageTypes.has(contentType)) throw new Error("网址返回的不是支持的图片格式");
  return responseBuffer(response);
}

function safeSku(value) {
  return String(value || "product").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80) || "product";
}

export async function imageUrlToWecomValue(imageUrl, sku, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const lookupImpl = options.lookupImpl || dns.lookup;
  const input = await downloadImage(imageUrl, fetchImpl, lookupImpl);
  let output;
  try {
    output = await sharp(input, { animated: false, limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: 900, height: 900, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new Error("图片格式无法转换");
  }
  if (!output.length || output.length > WECOM_IMAGE_OUTPUT_MAX_BYTES) throw new Error("压缩后的图片仍然过大");
  return { title: `${safeSku(sku)}.jpg`, image_base64: output.toString("base64") };
}
