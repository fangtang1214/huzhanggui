import { z } from "zod";

const HTTP_LINK = /^https?:\/\/[^\s]+$/i;
const PLATFORM_LINK = /^[a-z][a-z0-9_-]{1,40}\/[^\s<>"']+$/i;
const PROMOTION_TOKEN_LINK = /^v\d+=[A-Za-z0-9_-]+$/;

export function isWebProductLink(value: string) {
  return HTTP_LINK.test(value.trim());
}

export function isSupportedProductLink(value: string) {
  const link = value.trim();
  return link === "" || HTTP_LINK.test(link) || PLATFORM_LINK.test(link) || PROMOTION_TOKEN_LINK.test(link);
}

export const productLinkSchema = z.string().trim().max(2000, "商品链接过长").refine(
  isSupportedProductLink,
  "商品链接可填写完整网址或视频号格式，例如 weixinstorehs/28512353738164 或 v1= 开头的推广参数",
).optional().nullable();
