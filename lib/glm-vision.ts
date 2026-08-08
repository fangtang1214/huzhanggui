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

export type SubjectBox = [number, number, number, number];
export type GlmReview = {
  candidateId: string;
  result: "same" | "uncertain" | "different";
  score: number;
  evidence: string[];
  differences: string[];
};

type GlmSettings = { apiKeyEncrypted?: string; configured?: boolean; indexingStatus?: "idle" | "running" | "paused" };

export function normalizeGlmModel(value: unknown): GlmModel {
  return typeof value === "string" && value in GLM_MODELS ? value as GlmModel : GLM_MODEL;
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
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `GLM 接口请求失败（${response.status}）`);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw new Error("GLM 未返回识别结果");
  return text;
}

export async function testGlmConnection(apiKey: string, model: GlmModel = GLM_MODEL, signal?: AbortSignal) {
  const text = await callGlm(apiKey, model, [{ type: "text", text: "仅回复 OK，用于检查模型连接。" }], signal);
  return Boolean(text.trim());
}

export async function analyzeSubject(apiKey: string, imageUrl: string, model: GlmModel = GLM_MODEL, signal?: AbortSignal): Promise<SubjectBox> {
  const text = await callGlm(apiKey, model, [
    { type: "image_url", image_url: { url: imageUrl } },
    { type: "text", text: "找出图片中主要销售商品本体的最小外接框。忽略人物、手、背景、文字贴纸和非商品装饰。坐标按 0 到 1000 归一化。只返回 JSON：{\"box\":[xmin,ymin,xmax,ymax]}。" },
  ], signal);
  const parsed = JSON.parse(jsonText(text)) as { box?: unknown[] };
  if (!Array.isArray(parsed.box) || parsed.box.length !== 4) throw new Error("GLM 未识别出商品主体范围");
  const box: SubjectBox = [clamp(parsed.box[0], 0, 1000), clamp(parsed.box[1], 0, 1000), clamp(parsed.box[2], 0, 1000), clamp(parsed.box[3], 0, 1000)];
  if (box[2] - box[0] < 10 || box[3] - box[1] < 10) throw new Error("GLM 返回的商品主体范围无效");
  return box;
}

export async function reviewCandidates(apiKey: string, newImageUrls: string[], candidates: Array<{ id: string; name: string; sku: string; imageUrls: string[] }>, model: GlmModel = GLM_MODEL, signal?: AbortSignal): Promise<GlmReview[]> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: "以下先给出本次新商品图片。所有图片可能背景、光线、拍摄角度不同。" }];
  for (const url of newImageUrls) content.push({ type: "image_url", image_url: { url } });
  content.push({ type: "text", text: "下面逐个给出历史候选。请只判断销售商品本体是否同款；背景、模特、手、摆放、光线和广告文字不同不能作为不同款依据。颜色、结构、材质、Logo/文字、拉链、口袋、肩带和五金等商品特征应重点比较。" });
  for (const candidate of candidates) {
    content.push({ type: "text", text: `候选 ID=${candidate.id}，货号=${candidate.sku}，名称=${candidate.name}` });
    for (const url of candidate.imageUrls.slice(0, 3)) content.push({ type: "image_url", image_url: { url } });
  }
  content.push({ type: "text", text: "返回严格 JSON 数组，每个候选一项：[{\"candidateId\":\"...\",\"result\":\"same|uncertain|different\",\"score\":0到100,\"evidence\":[\"相同依据\"],\"differences\":[\"可见差异\"]}]。same 仅用于明显同款，uncertain 用于可能同款但证据不足，different 用于明显不同。不要输出 JSON 以外文字。" });
  const text = await callGlm(apiKey, model, content, signal);
  const parsed = JSON.parse(jsonText(text)) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) throw new Error("GLM 候选复核结果格式无效");
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  return parsed.flatMap((item): GlmReview[] => {
    const candidateId = String(item.candidateId || "");
    const result = item.result === "same" || item.result === "uncertain" || item.result === "different" ? item.result : null;
    if (!allowed.has(candidateId) || !result) return [];
    return [{ candidateId, result, score: clamp(item.score, 0, 100), evidence: Array.isArray(item.evidence) ? item.evidence.map(String).slice(0, 4) : [], differences: Array.isArray(item.differences) ? item.differences.map(String).slice(0, 4) : [] }];
  });
}

export const _test = { jsonText };
