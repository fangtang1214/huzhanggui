import { z } from "zod";

export function canonicalImageResourceUrl(value: string) {
  const trimmed = value.trim();
  const queryIndex = trimmed.indexOf("?");
  if (queryIndex < 0) return trimmed;
  const query = trimmed.slice(queryIndex + 1);
  return /^imageView2\//i.test(query) ? trimmed.slice(0, queryIndex) : trimmed;
}

export const imageUrlSchema = z.string().trim().url("图片网址格式不正确").refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "图片网址必须以 http:// 或 https:// 开头");
