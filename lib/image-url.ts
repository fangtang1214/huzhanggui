import { z } from "zod";

export const imageUrlSchema = z.string().trim().url("图片网址格式不正确").refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}, "图片网址必须以 http:// 或 https:// 开头");
