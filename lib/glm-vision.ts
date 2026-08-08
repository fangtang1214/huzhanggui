import { getDb } from "./db";
import { decryptSecret } from "./secret-box";

export const GLM_MODELS = {
  "glm-4.6v-flash": { label: "GLM-4.6V-Flash", billing: "free" as const, description: "免费，适合日常批量识别" },
  "glm-4.6v-flashx": { label: "GLM-4.6V-FlashX", billing: "paid" as const, description: "收费，轻量高速版" },
  "glm-4.6v": { label: "GLM-4.6V", billing: "paid" as const, description: "收费，高性能版" },
} as const;
export type GlmModel = keyof typeof GLM_MODELS;
export const GLM_MODEL: GlmModel = "glm-4.6v-flash";
const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const SUBJECT_ATTEMPT_TIMEOUT_MS = 45_000;

export type SubjectBox = [number, number, number, number];

class GlmApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "GlmApiError"; }
}

type GlmSettings = { apiKeyEncrypted?: string; configured?: boolean; indexingStatus?: "idle" | "running" | "paused" };

export function normalizeGlmModel(value: unknown): GlmModel {
  return typeof value === "string" && value in GLM_MODELS ? value as GlmModel : GLM_MODEL;
}

export function subjectPrompt(productName?: string) {
  return `商品名称：${productName || "未提供"}。找出图片中主要销售商品本体的最小外接框。图片可能同时出现主商品、赠品、配件或大小两个相似商品：优先选择与商品名称相符的主商品；名称无法区分时，选择画面中面积最大、最突出且展示最完整的商品，不要选择旁边较小的赠品或配件。如果名称明确写有套装、组合或子母包，则框住整套销售商品。忽略人物、手、背景、文字贴纸和非商品装饰。坐标按 0 到 1000 归一化。只返回 JSON：{\"box\":[xmin,ymin,xmax,ymax]}。`;
}

function jsonText(value: string) {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced || value).trim();
  const arrayStart = source.indexOf("[");
  const objectStart = source.indexOf("{");
  const start = arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  const end = source.startsWith("[", start) ? source.lastIndexOf("]") : source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("GLM 返回内容无法解析");
  return source.slice(start, end + 1);
}

function clamp(value: unknown, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

export async function getGlmSettings() {
  const sql = getDb();
  const [row] = await sql`SELECT value FROM app_settings WHERE key='glm_image_matching'`;
  const value = (row?.value || {}) as GlmSettings & { model?: string };
  return { configured: Boolean(value.configured && value.apiKeyEncrypted), indexingStatus: value.indexingStatus || "idle", model: normalizeGlmModel(value.model) };
}

export async function getGlmApiKey() {
  const sql = getDb();
  const [row] = await sql`SELECT value FROM app_settings WHERE key='glm_image_matching'`;
  const value = (row?.value || {}) as GlmSettings;
  if (!value.configured || !value.apiKeyEncrypted) throw new Error("尚未配置 GLM-4.6V-Flash API 密钥");
  return decryptSecret(value.apiKeyEncrypted);
}

export async function getGlmRuntime() {
  const [apiKey, settings] = await Promise.all([getGlmApiKey(), getGlmSettings()]);
  return { apiKey, model: settings.model };
}

async function callGlm(apiKey: string, model: GlmModel, content: Array<Record<string, unknown>>, signal?: AbortSignal) {
  const response = await fetch(GLM_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.05, messages: [{ role: "user", content }] }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string };
  if (!response.ok) throw new GlmApiError(payload.error?.message || payload.message || `GLM 接口请求失败（${response.status}）`, response.status);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error("GLM 未返回识别结果");
  return text;
}

export async function testGlmConnection(apiKey: string, model: GlmModel = GLM_MODEL, signal?: AbortSignal) {
  const text = await callGlm(apiKey, model, [{ type: "text", text: "仅回复 OK，用于检查模型连接。" }], signal);
  return Boolean(text.trim());
}

export function expandSubjectBox(box: SubjectBox, ratio = 0.06): SubjectBox {
  const paddingX = (box[2] - box[0]) * ratio; const paddingY = (box[3] - box[1]) * ratio;
  return [clamp(box[0] - paddingX, 0, 1000), clamp(box[1] - paddingY, 0, 1000), clamp(box[2] + paddingX, 0, 1000), clamp(box[3] + paddingY, 0, 1000)];
}

export async function analyzeSubject(apiKey: string, imageUrl: string, model: GlmModel = GLM_MODEL, signal?: AbortSignal, productName?: string): Promise<SubjectBox> {
  const text = await callGlm(apiKey, model, [
    { type: "image_url", image_url: { url: imageUrl } },
    { type: "text", text: subjectPrompt(productName) },
  ], signal);
  const parsed = JSON.parse(jsonText(text)) as { box?: unknown[] };
  if (!Array.isArray(parsed.box) || parsed.box.length !== 4) throw new Error("GLM 未识别出商品主体范围");
  const box: SubjectBox = [clamp(parsed.box[0], 0, 1000), clamp(parsed.box[1], 0, 1000), clamp(parsed.box[2], 0, 1000), clamp(parsed.box[3], 0, 1000)];
  if (box[2] - box[0] < 10 || box[3] - box[1] < 10) throw new Error("GLM 返回的商品主体范围无效");
  return expandSubjectBox(box);
}

function subjectAttemptSignal(signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(SUBJECT_ATTEMPT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function canUseFlashFallback(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  return !(error instanceof GlmApiError && (error.status === 401 || error.status === 403));
}

export async function analyzeSubjectWithFallback(apiKey: string, imageUrl: string, preferredModel: GlmModel, signal?: AbortSignal, productName?: string) {
  try {
    return { box: await analyzeSubject(apiKey, imageUrl, preferredModel, subjectAttemptSignal(signal), productName), model: preferredModel, fallbackUsed: false };
  } catch (primaryError) {
    if (!canUseFlashFallback(primaryError, signal)) throw primaryError;
    try {
      return { box: await analyzeSubject(apiKey, imageUrl, GLM_MODEL, subjectAttemptSignal(signal), productName), model: GLM_MODEL, fallbackUsed: true };
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : "当前模型定位失败";
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "免费模型定位失败";
      throw new Error(`当前模型定位失败：${primaryMessage}；GLM-4.6V-Flash 兜底失败：${fallbackMessage}`, { cause: fallbackError });
    }
  }
}

export const _test = { jsonText };
