import assert from "node:assert/strict";
import test from "node:test";
import { GLM_MODELS, SUBJECT_BATCH_SIZE, SUBJECT_HEDGE_DELAY_MS, SUBJECT_STAGE_TIMEOUT_MS, _test, analyzeSubjectWithFallback, analyzeSubjectsWithFallback, expandSubjectBox, normalizeGlmModel, subjectBatchPrompt, subjectPrompt } from "../lib/glm-vision.ts";
import { decryptSecret, encryptSecret } from "../lib/secret-box.ts";

test("GLM API 密钥使用服务器密钥加密保存", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-session-secret-for-glm";
  try {
    const encrypted = encryptSecret("glm-private-api-key");
    assert.notEqual(encrypted, "glm-private-api-key");
    assert.ok(!encrypted.includes("glm-private-api-key"));
    assert.equal(decryptSecret(encrypted), "glm-private-api-key");
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous;
  }
});

test("GLM 图片识别支持免费、轻量收费和高性能收费三种模型", () => {
  assert.deepEqual(Object.keys(GLM_MODELS), ["glm-4.6v-flash", "glm-4.6v-flashx", "glm-4.6v"]);
  assert.equal(GLM_MODELS["glm-4.6v-flash"].billing, "free");
  assert.equal(GLM_MODELS["glm-4.6v-flashx"].billing, "paid");
  assert.equal(GLM_MODELS["glm-4.6v"].billing, "paid");
  assert.equal(normalizeGlmModel("glm-4.6v-flashx"), "glm-4.6v-flashx");
  assert.equal(normalizeGlmModel("invalid"), "glm-4.6v-flash");
});

test("当前主体定位模型失败后使用免费 Flash 兜底", async () => {
  const originalFetch = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body)); models.push(body.model);
    if (models.length === 1) return new Response(JSON.stringify({ error: { message: "请求过多" } }), { status: 429, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"box\":[100,200,900,800]}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await analyzeSubjectWithFallback("test-key", "https://example.com/product.jpg", "glm-4.6v-flashx");
    assert.deepEqual(models, ["glm-4.6v-flashx", "glm-4.6v-flash"]);
    assert.equal(result.model, "glm-4.6v-flash"); assert.equal(result.fallbackUsed, true);
    assert.deepEqual(result.box, [52, 164, 948, 836]);
  } finally { globalThis.fetch = originalFetch; }
});

test("鉴权错误不会重复调用免费模型", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "API Key 无效" } }), { status: 401, headers: { "content-type": "application/json" } }); };
  try { await assert.rejects(() => analyzeSubjectWithFallback("bad-key", "https://example.com/product.jpg", "glm-4.6v"), /API Key 无效/); assert.equal(calls, 1); }
  finally { globalThis.fetch = originalFetch; }
});

test("GLM JSON 解析兼容代码块返回", () => {
  assert.equal(_test.jsonText("说明\n```json\n{\"box\":[1,2,900,950]}\n```"), "{\"box\":[1,2,900,950]}");
});

test("GLM 主体定位会结合商品名称并优先主商品而非小配件", () => {
  const prompt = subjectPrompt("大号子母包套装");
  assert.match(prompt, /商品名称：大号子母包套装/);
  assert.match(prompt, /面积最大、最突出且展示最完整/);
  assert.match(prompt, /不要选择旁边较小的赠品或配件/);
  assert.match(prompt, /套装、组合或子母包/);
  assert.deepEqual(expandSubjectBox([0, 100, 1000, 900]), [0, 52, 1000, 948]);
});

test("实时主体定位按四张一批并使用 3 秒后援、7 秒截止", () => {
  assert.equal(SUBJECT_BATCH_SIZE, 4);
  assert.equal(SUBJECT_HEDGE_DELAY_MS, 3_000);
  assert.equal(SUBJECT_STAGE_TIMEOUT_MS, 7_000);
  assert.match(subjectBatchPrompt([{ imageUrl: "a" }, { imageUrl: "b" }]), /共有 2 张商品图片/);
  assert.match(subjectBatchPrompt([{ imageUrl: "a" }, { imageUrl: "b" }]), /JSON 数组/);
});

test("GLM 批量主体定位允许部分图片成功", async () => {
  const originalFetch = globalThis.fetch; let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '[{"index":0,"box":[100,200,900,800]},{"index":1,"box":[10,10,10,20]}]' } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await analyzeSubjectsWithFallback("test-key", [{ imageUrl: "https://example.com/a.jpg" }, { imageUrl: "https://example.com/b.jpg" }], "glm-4.6v-flash");
    assert.equal(requestBody.model, "glm-4.6v-flash");
    assert.deepEqual(requestBody.thinking, { type: "disabled" });
    assert.equal(requestBody.max_tokens, 1024);
    assert.equal(requestBody.messages[0].content.filter((item) => item.type === "image_url").length, 2);
    assert.deepEqual(result, [{ imageUrl: "https://example.com/a.jpg", box: [52, 164, 948, 836], model: "glm-4.6v-flash", fallbackUsed: false }]);
  } finally { globalThis.fetch = originalFetch; }
});
