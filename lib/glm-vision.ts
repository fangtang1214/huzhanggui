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
export const SUBJECT_HEDGE_DELAY_MS = 3_000;
export const SUBJECT_STAGE_TIMEOUT_MS = 7_000;
export const SUBJECT_BATCH_SIZE = 4;

export type SubjectBox = [number, number, number, number];
export type SubjectBatchItem = { imageUrl: string; productName?: string };
export type LocatedSubject = { imageUrl: string; box: SubjectBox; model: GlmModel; fallbackUsed: boolean };

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

export function subjectBatchPrompt(items: SubjectBatchItem[]) {
  return `下面共有 ${items.length} 张商品图片，图片索引按随后标注的 0 到 ${items.length - 1} 对应。请分别找出每张图片中主要销售商品本体的最小外接框。图片可能同时出现主商品、赠品、配件或大小两个相似商品：优先选择商品名称相符的主商品；名称无法区分时，选择画面中面积最大、最突出且展示最完整的商品，不要选择旁边较小的赠品或配件。如果名称明确写有套装、组合或子母包，则框住整套销售商品。忽略人物、手、背景、文字贴纸和非商品装饰。坐标按 0 到 1000 归一化。只返回 JSON 数组，例如：[{"index":0,"box":[xmin,ymin,xmax,ymax]}]。每张图片最多返回一个结果；无法判断的图片可以省略，禁止把不同图片的坐标混在一起。`;
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
    body: JSON.stringify({ model, temperature: 0.05, max_tokens: 1024, thinking: { type: "disabled" }, messages: [{ role: "user", content }] }),
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

function normalizedSubjectBox(value: unknown): SubjectBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const box: SubjectBox = [clamp(value[0], 0, 1000), clamp(value[1], 0, 1000), clamp(value[2], 0, 1000), clamp(value[3], 0, 1000)];
  return box[2] - box[0] >= 10 && box[3] - box[1] >= 10 ? expandSubjectBox(box) : null;
}

export async function analyzeSubject(apiKey: string, imageUrl: string, model: GlmModel = GLM_MODEL, signal?: AbortSignal, productName?: string): Promise<SubjectBox> {
  const text = await callGlm(apiKey, model, [
    { type: "image_url", image_url: { url: imageUrl } },
    { type: "text", text: subjectPrompt(productName) },
  ], signal);
  const parsed = JSON.parse(jsonText(text)) as { box?: unknown[] };
  const box = normalizedSubjectBox(parsed.box);
  if (!box) throw new Error("GLM 未识别出有效的商品主体范围");
  return box;
}

async function analyzeSubjectBatch(apiKey: string, items: SubjectBatchItem[], model: GlmModel, signal?: AbortSignal) {
  if (!items.length || items.length > SUBJECT_BATCH_SIZE) throw new Error(`每批主体定位需要 1 到 ${SUBJECT_BATCH_SIZE} 张图片`);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: subjectBatchPrompt(items) }];
  items.forEach((item, index) => {
    content.push({ type: "text", text: `图片索引 ${index}；商品名称：${item.productName || "未提供"}` });
    content.push({ type: "image_url", image_url: { url: item.imageUrl } });
  });
  const text = await callGlm(apiKey, model, content, signal);
  const parsed = JSON.parse(jsonText(text)) as unknown;
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown[] }).items) ? (parsed as { items: unknown[] }).items : [];
  const results = new Map<number, SubjectBox>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const index = Number((row as { index?: unknown }).index);
    const box = normalizedSubjectBox((row as { box?: unknown }).box);
    if (Number.isInteger(index) && index >= 0 && index < items.length && box && !results.has(index)) results.set(index, box);
  }
  if (!results.size) throw new Error("GLM 未识别出任何有效的商品主体范围");
  return items.flatMap((item, index) => {
    const box = results.get(index);
    return box ? [{ imageUrl: item.imageUrl, box }] : [];
  });
}

function canUseFlashFallback(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  return !(error instanceof GlmApiError && (error.status === 401 || error.status === 403));
}

type SubjectAttemptResult<T> = { value: T; model: GlmModel; fallbackUsed: boolean };

async function hedgedSubjectAttempt<T>(preferredModel: GlmModel, run: (model: GlmModel, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<SubjectAttemptResult<T>> {
  const deadline = AbortSignal.timeout(SUBJECT_STAGE_TIMEOUT_MS);
  const winner = new AbortController();
  const requestSignal = AbortSignal.any([deadline, winner.signal, ...(signal ? [signal] : [])]);
  if (preferredModel === GLM_MODEL) {
    try { return { value: await run(GLM_MODEL, requestSignal), model: GLM_MODEL, fallbackUsed: false }; }
    finally { winner.abort(); }
  }

  return new Promise<SubjectAttemptResult<T>>((resolve, reject) => {
    let settled = false; let primaryFinished = false; let fallbackFinished = false; let fallbackStarted = false;
    let primaryError: unknown; let fallbackError: unknown;
    const finish = (result: SubjectAttemptResult<T>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result); winner.abort();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error); winner.abort();
    };
    const combinedError = () => {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : "当前模型定位失败";
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : "免费模型定位失败";
      return new Error(`当前模型定位失败：${primaryMessage}；GLM-4.6V-Flash 兜底失败：${fallbackMessage}`, { cause: fallbackError });
    };
    const maybeFinishFailure = () => {
      if (primaryFinished && fallbackFinished) fail(combinedError());
    };
    const startFallback = () => {
      if (settled || fallbackStarted || requestSignal.aborted) return;
      fallbackStarted = true;
      void run(GLM_MODEL, requestSignal).then((value) => finish({ value, model: GLM_MODEL, fallbackUsed: true })).catch((error) => {
        fallbackError = error; fallbackFinished = true; maybeFinishFailure();
      });
    };

    requestSignal.addEventListener("abort", () => {
      if (!settled) fail(new DOMException("商品主体定位超过 7 秒", "AbortError"));
    }, { once: true });
    const timer = setTimeout(startFallback, SUBJECT_HEDGE_DELAY_MS);
    void run(preferredModel, requestSignal).then((value) => finish({ value, model: preferredModel, fallbackUsed: false })).catch((error) => {
      primaryError = error; primaryFinished = true;
      if (!canUseFlashFallback(error, signal)) { fail(error); return; }
      startFallback(); maybeFinishFailure();
    });
  });
}

export async function analyzeSubjectWithFallback(apiKey: string, imageUrl: string, preferredModel: GlmModel, signal?: AbortSignal, productName?: string) {
  const result = await hedgedSubjectAttempt(preferredModel, (model, requestSignal) => analyzeSubject(apiKey, imageUrl, model, requestSignal, productName), signal);
  return { box: result.value, model: result.model, fallbackUsed: result.fallbackUsed };
}

export async function analyzeSubjectsWithFallback(apiKey: string, items: SubjectBatchItem[], preferredModel: GlmModel, signal?: AbortSignal): Promise<LocatedSubject[]> {
  const result = await hedgedSubjectAttempt(preferredModel, (model, requestSignal) => analyzeSubjectBatch(apiKey, items, model, requestSignal), signal);
  return result.value.map((item) => ({ ...item, model: result.model, fallbackUsed: result.fallbackUsed }));
}

export const _test = { jsonText, normalizedSubjectBox };
