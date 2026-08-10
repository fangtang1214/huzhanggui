import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const WECOM_SHEET_SETTING_KEY = "wecom_sheet_sync";
export const WECOM_SHEET_CSV_PATH = "/api/integrations/wecom/products.csv";

export type WecomSheetProduct = {
  sku: unknown;
  name: unknown;
  price: unknown;
  productUrl: unknown;
  imageUrls: unknown;
  updatedAt: unknown;
};

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("缺少 SESSION_SECRET 环境变量");
  return secret;
}

export function createWecomSheetToken() {
  return randomBytes(32).toString("base64url");
}

export function hashWecomSheetToken(token: string) {
  return createHash("sha256")
    .update(`huzhanggui:wecom-sheet:${sessionSecret()}:${token}`)
    .digest("hex");
}

export function verifyWecomSheetToken(token: string, expectedHash: string) {
  if (!token || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false;
  const actual = Buffer.from(hashWecomSheetToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function spreadsheetSafe(value: string) {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function csvCell(value: unknown, protectFormula = true) {
  const normalized = (protectFormula ? spreadsheetSafe(text(value)) : text(value)).replace(/\r\n?/g, "\n");
  return `"${normalized.replace(/"/g, '""')}"`;
}

function primaryImage(value: unknown) {
  if (!Array.isArray(value)) return "";
  return text(value.find((item) => typeof item === "string" && item.trim()) || "");
}

export function productsToWecomCsv(rows: WecomSheetProduct[]) {
  const header = ["货号", "商品名称", "价格", "商品链接", "主图链接", "更新时间"].map((value) => csvCell(value)).join(",");
  const body = rows.map((row) => [
    csvCell(row.sku),
    csvCell(row.name),
    csvCell(row.price, false),
    csvCell(row.productUrl),
    csvCell(primaryImage(row.imageUrls)),
    csvCell(row.updatedAt),
  ].join(","));
  return `\uFEFF${[header, ...body].join("\r\n")}\r\n`;
}

export function wecomSheetUrl(origin: string, token: string) {
  const base = origin.replace(/\/+$/, "");
  return `${base}${WECOM_SHEET_CSV_PATH}?token=${encodeURIComponent(token)}`;
}
