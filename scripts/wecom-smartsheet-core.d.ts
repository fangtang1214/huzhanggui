export const WECOM_SMART_SHEET_SETTING_KEY: string;
export const WECOM_SMART_SHEET_INTERVAL_MINUTES: number;
export const WECOM_SMART_SHEET_BATCH_SIZE: number;
export const WECOM_SMART_SHEET_IMAGE_BATCH_SIZE: number;
export const WECOM_SMART_SHEET_FIELDS: Array<{ key: string; title: string; type: string }>;

export class WecomSmartSheetError extends Error {
  code: string;
  errcode: number | null;
  constructor(message: string, code?: string, errcode?: number | null);
}

export type WecomSmartSheetFields = Record<"sku" | "mainImage" | "name" | "price" | "productUrl" | "imageUrl" | "updatedAt" | "archiveStatus", string>;

export function encryptWecomWebhook(value: string): string;
export function decryptWecomWebhook(value: string): string;
export function validateWecomWebhookUrl(value: unknown): string;
export function parseWecomSmartSheetExample(value: unknown): WecomSmartSheetFields;
export function primaryProductImageUrl(imageUrls: unknown): string;
export function productToWecomSmartSheetValues(fields: WecomSmartSheetFields, product: {
  sku: unknown;
  name: unknown;
  price: unknown;
  productUrl: unknown;
  imageUrls: unknown;
  updatedAt: unknown;
  archived: unknown;
}): Record<string, string | number>;
export function wecomSmartSheetPayloadHash(values: Record<string, string | number>): string;
export function postWecomSmartSheet(webhookUrl: string, body: unknown, fetchImpl?: typeof fetch): Promise<Record<string, unknown>>;
export function addedRecordIds(payload: Record<string, unknown>, expectedCount: number): string[];
