import assert from "node:assert/strict";
import test from "node:test";
import { groupImageMatchFailures } from "../lib/image-match-failures.ts";

test("图片识别失败原因按错误内容合并并保留预览序号", () => {
  const urls = ["https://example.com/1.jpg", "https://example.com/2.jpg", "https://example.com/3.jpg"];
  assert.deepEqual(groupImageMatchFailures(urls, [
    { imageUrl: urls[0], message: "GLM 无法读取图片" },
    { imageUrl: urls[1], message: "GLM 无法读取图片" },
    { imageUrl: urls[2], message: "本地特征服务连接失败" },
  ], 8), [
    { message: "GLM 无法读取图片", count: 2, imageIndexes: [1, 2] },
    { message: "本地特征服务连接失败", count: 1, imageIndexes: [3] },
  ]);
});

test("超过实时识别上限的图片显示未参与原因", () => {
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index + 1}.jpg`);
  const reasons = groupImageMatchFailures(urls, [], 8);
  assert.deepEqual(reasons, [{
    message: "超过单次实时识别上限（8 张），本次未参与识别",
    count: 2,
    imageIndexes: [9, 10],
  }]);
});
