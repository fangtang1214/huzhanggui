import test from "node:test";
import assert from "node:assert/strict";
import { formatWindowServiceRatio, mergeWindowRegistrationCooperation } from "../lib/window-registration.ts";

const oldProduct = {
  storeName: "旧店铺",
  price: 99,
  productUrl: "weixinstorehs/10001229026301",
  commission: "0.5%",
  storeRating: 4,
  supplyChain: "旧机构",
  cooperationMechanism: "原有合作备注",
};

test("机构服务费率转换为商品档案百分比", () => {
  assert.equal(formatWindowServiceRatio(18000), "1.8%");
  assert.equal(formatWindowServiceRatio(0), "0%");
  assert.equal(formatWindowServiceRatio(null), null);
});

test("确认同款时以本次橱窗的店铺和机构合作数据覆盖旧档案", () => {
  const merged = mergeWindowRegistrationCooperation({
    shopName: "最新店铺",
    sellingPriceFen: 1990,
    promotionLink: "weixinstorehs/28684289399598",
    serviceRatio: 25000,
    shopScore: 481,
    promotionAccountName: "斯源新团",
  }, oldProduct);

  assert.deepEqual(merged, {
    storeName: "最新店铺",
    price: 19.9,
    productUrl: "weixinstorehs/28684289399598",
    commission: "2.5%",
    storeRating: 4.81,
    supplyChain: "旧机构",
    cooperationMechanism: "原有合作备注",
  });
});

test("橱窗接口未返回的合作字段保留本次登记表单内容", () => {
  assert.deepEqual(mergeWindowRegistrationCooperation({}, oldProduct), oldProduct);
});

test("联盟机构账号名称不会自动写入供应链字段", () => {
  const merged = mergeWindowRegistrationCooperation({ promotionAccountName: "斯源新团" }, {
    ...oldProduct,
    supplyChain: null,
  });
  assert.equal(merged.supplyChain, null);
});
