import assert from "node:assert/strict";
import test from "node:test";
import { GLM_MODELS, _test, normalizeGlmModel, reviewCandidates, subjectPrompt } from "../lib/glm-vision.ts";
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

test("GLM 复核会使用全部新图片且每个历史候选最多三张图", async () => {
  const firstAcceptanceImage = "https://wst.wxapp.tc.qq.com/161/20304/snscosdownload/SH/reserved/69d8bd29000586e61afc6c53d0692d1e000000a000004f50?imageView2/1/w/800/h/800/q/50";
  const secondAcceptanceImage = "https://wst.wxapp.tc.qq.com/161/20304/snscosdownload/SH/reserved/69ce5716000994eb19e459f973ad1715000000a000004f50?imageView2/1/w/800/h/800/q/50";
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n[{\"candidateId\":\"candidate-1\",\"result\":\"same\",\"score\":96,\"evidence\":[\"Logo 与拉链结构一致\"],\"differences\":[\"背景不同\"]}]\n```" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const reviews = await reviewCandidates("test-key", [firstAcceptanceImage, secondAcceptanceImage], [{ id: "candidate-1", sku: "HZG-1", name: "腰包", imageUrls: ["https://old.example/1.jpg", "https://old.example/2.jpg", "https://old.example/3.jpg", "https://old.example/4.jpg"] }], "glm-4.6v-flashx");
    const serialized = JSON.stringify(requestBody);
    assert.equal(requestBody.model, "glm-4.6v-flashx");
    assert.ok(serialized.includes(firstAcceptanceImage));
    assert.ok(serialized.includes(secondAcceptanceImage));
    assert.match(serialized, /old\.example\\?\/3\.jpg/);
    assert.doesNotMatch(serialized, /old\.example\\?\/4\.jpg/);
    assert.deepEqual(reviews[0], { candidateId: "candidate-1", result: "same", score: 96, evidence: ["Logo 与拉链结构一致"], differences: ["背景不同"] });
  } finally { globalThis.fetch = originalFetch; }
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
});
