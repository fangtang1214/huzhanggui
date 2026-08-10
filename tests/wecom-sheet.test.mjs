import assert from "node:assert/strict";
import test from "node:test";
import {
  csvCell,
  hashWecomSheetToken,
  productsToWecomCsv,
  verifyWecomSheetToken,
  wecomSheetUrl,
} from "../lib/wecom-sheet.ts";
import {
  WECOM_SMART_SHEET_FIELDS,
  addedRecordIds,
  decryptWecomWebhook,
  encryptWecomWebhook,
  parseWecomSmartSheetExample,
  productToWecomSmartSheetValues,
  validateWecomWebhookUrl,
  wecomSmartSheetPayloadHash,
} from "../scripts/wecom-smartsheet-core.mjs";

const smartSheetExample = {
  schema: {
    f04Gwj: { title: "货号", type: "text" },
    ftQMc5: { title: "商品名称", type: "text" },
    ftk5Tx: { title: "价格", type: "number" },
    ffFwIh: { title: "商品链接", type: "text" },
    fn8TJd: { title: "主图链接", type: "text" },
    fR1sug: { title: "更新时间", type: "date_time" },
    fQao3A: { title: "档案状态", type: "text" },
  },
  add_records: [{ values: {} }],
};

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

test("智能表格示例数据按标题提取固定字段编号", () => {
  const fields = parseWecomSmartSheetExample(JSON.stringify(smartSheetExample));
  assert.deepEqual(fields, {
    sku: "f04Gwj",
    name: "ftQMc5",
    price: "ftk5Tx",
    productUrl: "ffFwIh",
    imageUrl: "fn8TJd",
    updatedAt: "fR1sug",
    archiveStatus: "fQao3A",
  });
  assert.deepEqual(WECOM_SMART_SHEET_FIELDS.map((field) => field.title), ["货号", "商品名称", "价格", "商品链接", "主图链接", "更新时间", "档案状态"]);
  assert.throws(() => parseWecomSmartSheetExample({ schema: { ...smartSheetExample.schema, ftk5Tx: { title: "价格", type: "text" } } }), /价格.*数字/);
});

test("智能表格 Webhook 只接受企业微信官方地址", () => {
  assert.equal(
    validateWecomWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=secret"),
    "https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=secret",
  );
  assert.throws(() => validateWecomWebhookUrl("https://qyapi.weixin.qq.com.evil.example/cgi-bin/wedoc/smartsheet/webhook?key=secret"), /必须来自企业微信智能表格/);
  assert.throws(() => validateWecomWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook"), /缺少写入密钥/);
});

test("智能表格商品值包含主图、毫秒时间戳和归档状态", () => {
  const fields = parseWecomSmartSheetExample(smartSheetExample);
  const values = productToWecomSmartSheetValues(fields, {
    sku: "26080001",
    name: "夏季上衣",
    price: "59.90",
    productUrl: "https://example.com/product/1",
    imageUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
    updatedAt: new Date("2026-08-11T01:02:03.000Z"),
    archived: true,
  });
  assert.equal(values.f04Gwj, "26080001");
  assert.equal(values.ftk5Tx, 59.9);
  assert.equal(values.fn8TJd, "https://example.com/1.jpg");
  assert.equal(values.fR1sug, String(new Date("2026-08-11T01:02:03.000Z").getTime()));
  assert.equal(values.fQao3A, "已归档");
  assert.equal(wecomSmartSheetPayloadHash(values).length, 64);
});

test("智能表格新增响应必须逐条返回记录编号", () => {
  assert.deepEqual(addedRecordIds({ add_records: [{ record_id: "REC1" }, { record_id: "REC2" }] }, 2), ["REC1", "REC2"]);
  assert.throws(() => addedRecordIds({ add_records: [] }, 1), /自动同步已暂停/);
});

test("智能表格 Webhook 在数据库中加密保存", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "test-secret-for-smart-sheet";
  try {
    const source = "https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=private-key";
    const encrypted = encryptWecomWebhook(source);
    assert.doesNotMatch(encrypted, /private-key/);
    assert.equal(decryptWecomWebhook(encrypted), source);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});
