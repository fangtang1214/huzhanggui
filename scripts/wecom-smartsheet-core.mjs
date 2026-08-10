import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const WECOM_SMART_SHEET_SETTING_KEY = "wecom_smartsheet_sync";
export const WECOM_SMART_SHEET_INTERVAL_MINUTES = 30;
export const WECOM_SMART_SHEET_BATCH_SIZE = 100;
export const WECOM_SMART_SHEET_IMAGE_BATCH_SIZE = 5;

export const WECOM_SMART_SHEET_FIELDS = [
  { key: "sku", title: "货号", type: "text" },
  { key: "mainImage", title: "主图", type: "image" },
  { key: "name", title: "商品名称", type: "text" },
  { key: "price", title: "价格", type: "number" },
  { key: "productUrl", title: "商品链接", type: "text" },
  { key: "imageUrl", title: "主图链接", type: "text" },
  { key: "updatedAt", title: "更新时间", type: "date_time" },
  { key: "archiveStatus", title: "档案状态", type: "text" },
];

export class WecomSmartSheetError extends Error {
  constructor(message, code = "INVALID_CONFIG", errcode = null) {
    super(message);
    this.name = "WecomSmartSheetError";
    this.code = code;
    this.errcode = errcode;
  }
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("缺少 SESSION_SECRET 环境变量");
  return secret;
}

function encryptionKey() {
  return createHash("sha256").update(`huzhanggui:wecom-smartsheet:${sessionSecret()}`).digest();
}

export function encryptWecomWebhook(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptWecomWebhook(value) {
  const [version, iv, tag, encrypted] = String(value || "").split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new WecomSmartSheetError("Webhook 保存格式无效，请重新配置", "INVALID_SECRET");
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new WecomSmartSheetError("Webhook 无法解密，请重新配置", "INVALID_SECRET");
  }
}

export function validateWecomWebhookUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new WecomSmartSheetError("请粘贴完整的企业微信 Webhook 地址");
  }
  if (url.protocol !== "https:" || url.hostname !== "qyapi.weixin.qq.com" || url.pathname !== "/cgi-bin/wedoc/smartsheet/webhook") {
    throw new WecomSmartSheetError("Webhook 地址必须来自企业微信智能表格的“接收外部数据”页面");
  }
  if (!url.searchParams.get("key")) throw new WecomSmartSheetError("Webhook 地址缺少写入密钥，请重新复制完整地址");
  url.hash = "";
  return url.toString();
}

function parseExampleJson(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); }
    catch { throw new WecomSmartSheetError("示例数据不是有效的 JSON，请重新完整复制"); }
  }
  return value;
}

export function parseWecomSmartSheetExample(value) {
  const input = parseExampleJson(value);
  const schema = input && typeof input === "object" && !Array.isArray(input) ? input.schema : null;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new WecomSmartSheetError("示例数据中缺少 schema，请重新完整复制");
  }
  const fields = {};
  for (const expected of WECOM_SMART_SHEET_FIELDS) {
    const matches = Object.entries(schema).filter(([, definition]) => {
      if (typeof definition === "string") return definition === expected.title;
      return definition && typeof definition === "object" && definition.title === expected.title;
    });
    if (matches.length !== 1) throw new WecomSmartSheetError(`示例数据中需要且只能有一个“${expected.title}”字段`);
    const [fieldId, definition] = matches[0];
    if (!/^f[A-Za-z0-9_-]+$/.test(fieldId)) throw new WecomSmartSheetError(`“${expected.title}”的字段编号格式不正确`);
    if (typeof definition !== "object" || definition.type !== expected.type) {
      const typeLabel = expected.type === "number" ? "数字" : expected.type === "date_time" ? "日期" : expected.type === "image" ? "图片" : "文本";
      throw new WecomSmartSheetError(`“${expected.title}”字段类型应为“${typeLabel}”`);
    }
    fields[expected.key] = fieldId;
  }
  return fields;
}

export function primaryProductImageUrl(imageUrls) {
  if (!Array.isArray(imageUrls)) return "";
  const image = imageUrls.find((value) => typeof value === "string" && value.trim());
  return image ? image.trim() : "";
}

function timestampMilliseconds(value) {
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return String(Number.isFinite(milliseconds) ? milliseconds : Date.now());
}

export function productToWecomSmartSheetValues(fields, product) {
  const values = {
    [fields.sku]: product.sku === null || product.sku === undefined ? "" : String(product.sku),
    [fields.name]: product.name === null || product.name === undefined ? "" : String(product.name),
    [fields.productUrl]: product.productUrl === null || product.productUrl === undefined ? "" : String(product.productUrl),
    [fields.imageUrl]: primaryProductImageUrl(product.imageUrls),
    [fields.updatedAt]: timestampMilliseconds(product.updatedAt),
    [fields.archiveStatus]: product.archived ? "已归档" : "在用",
  };
  if (product.price !== null && product.price !== undefined && product.price !== "") {
    const price = Number(product.price);
    if (Number.isFinite(price)) values[fields.price] = price;
  }
  return values;
}

export function wecomSmartSheetPayloadHash(values) {
  const normalized = Object.keys(values).sort().map((key) => [key, values[key]]);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function describeWebhookError(errcode, errmsg) {
  const known = {
    40014: "Webhook 地址已失效，请在智能表格中重新复制地址",
    45033: "企业微信写入过于频繁，请稍后再试",
    2023001: "企业微信找不到对应字段，请重新复制示例数据",
    2023012: "企业微信记录已不存在，请重新配置后同步",
  };
  return known[errcode] || `企业微信返回错误（${errcode}）：${errmsg || "未知原因"}`;
}

export async function postWecomSmartSheet(webhookUrl, body, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new WecomSmartSheetError(error?.name === "TimeoutError" ? "连接企业微信超时，请稍后再试" : "无法连接企业微信，请检查服务器网络", "NETWORK_ERROR");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw new WecomSmartSheetError(`企业微信响应异常（HTTP ${response.status}）`, "INVALID_RESPONSE");
  }
  const errcode = Number(payload.errcode || 0);
  if (errcode !== 0) throw new WecomSmartSheetError(describeWebhookError(errcode, String(payload.errmsg || "")), "WECOM_ERROR", errcode);
  return payload;
}

export function addedRecordIds(payload, expectedCount) {
  const records = Array.isArray(payload?.add_records) ? payload.add_records : [];
  const ids = records.map((record) => String(record?.record_id || "").trim()).filter(Boolean);
  if (ids.length !== expectedCount) {
    throw new WecomSmartSheetError("企业微信已接收数据，但没有返回完整的记录编号；为避免重复写入，自动同步已暂停", "MISSING_RECORD_IDS");
  }
  return ids;
}
