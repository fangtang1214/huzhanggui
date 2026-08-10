import assert from "node:assert/strict";
import test from "node:test";
import { canonicalImageResourceUrl } from "../lib/image-url.ts";

test("微信 CDN imageView2 派生地址与原始图片使用同一资源地址", () => {
  const original = "https://wst.wxapp.tc.qq.com/161/20304/snscosdownload/SH/reserved/69c3fe89000c4d8229dad941fb6c2d1e000000a000004f50";
  const derived = `${original}?imageView2/1/w/800/h/800/q/50`;
  assert.equal(canonicalImageResourceUrl(original), original);
  assert.equal(canonicalImageResourceUrl(derived), original);
});

test("普通签名查询参数不会被当作图片处理参数删除", () => {
  const signed = "https://example.com/image.jpg?token=abc123";
  assert.equal(canonicalImageResourceUrl(signed), signed);
});
