import assert from "node:assert/strict";
import test from "node:test";
import {
  csvCell,
  hashWecomSheetToken,
  productsToWecomCsv,
  verifyWecomSheetToken,
  wecomSheetUrl,
} from "../lib/wecom-sheet.ts";

test("企业微信商品库 CSV 使用 UTF-8 并输出固定字段", () => {
  const csv = productsToWecomCsv([{
    sku: "26080001",
    name: "夏季上衣",
    price: "59.90",
    productUrl: "https://example.com/product/1",
    imageUrls: ["https://example.com/image-1.jpg", "https://example.com/image-2.jpg"],
    updatedAt: new Date("2026-08-11T01:02:03.000Z"),
  }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /^\uFEFF"货号","商品名称","价格","商品链接","主图链接","更新时间"\r\n/);
  assert.match(csv, /"26080001","夏季上衣","59\.90","https:\/\/example\.com\/product\/1","https:\/\/example\.com\/image-1\.jpg","2026-08-11T01:02:03\.000Z"/);
  assert.doesNotMatch(csv, /image-2/);
});

test("CSV 正确处理引号、换行和公式注入字符", () => {
  assert.equal(csvCell('名称"一\r\n名称二'), '"名称""一\n名称二"');
  assert.equal(csvCell("=HYPERLINK(\"bad\")"), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell("-12.50", false), '"-12.50"');
});

test("表格同步密钥只用哈希校验且错误密钥不能通过", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-secret-for-wecom-sheet";
  try {
    const hash = hashWecomSheetToken("correct-token");
    assert.equal(hash.length, 64);
    assert.equal(verifyWecomSheetToken("correct-token", hash), true);
    assert.equal(verifyWecomSheetToken("wrong-token", hash), false);
    assert.equal(verifyWecomSheetToken("correct-token", "bad-hash"), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});

test("商品库网址规范拼接并编码同步密钥", () => {
  assert.equal(
    wecomSheetUrl("https://a.ouniki.site/", "a+b/c"),
    "https://a.ouniki.site/api/integrations/wecom/products.csv?token=a%2Bb%2Fc",
  );
});
