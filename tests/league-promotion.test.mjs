import test from "node:test";
import assert from "node:assert/strict";
import { selectLeaguePromotionCandidate } from "../lib/league-product.ts";

function candidate(overrides = {}) {
  return {
    promotionLink: "weixinstorehs/100",
    productId: "product-1",
    outProductId: "out-1",
    commissionRatio: 1000,
    normalCommissionRatio: 800,
    serviceRatio: 10000,
    commissionType: 0,
    planType: 0,
    accountId: "account-1",
    accountName: "机构一",
    accountIsPrimary: false,
    headSupplierItemLink: "weixinstorehs/100",
    error: null,
    ...overrides,
  };
}

test("主账号成功时优先使用主账号机构推广链接", () => {
  const selection = selectLeaguePromotionCandidate([
    candidate({ accountId: "secondary", promotionLink: "weixinstorehs/200", serviceRatio: 30000 }),
    candidate({ accountId: "primary", accountIsPrimary: true, promotionLink: "weixinstorehs/300", serviceRatio: 5000 }),
  ]);
  assert.equal(selection.selected?.accountId, "primary");
  assert.equal(selection.requiresChoice, false);
});

test("主账号未成功时选择实时服务费率最高的机构链接", () => {
  const selection = selectLeaguePromotionCandidate([
    candidate({ accountId: "low", promotionLink: "weixinstorehs/200", serviceRatio: 8000 }),
    candidate({ accountId: "high", promotionLink: "weixinstorehs/300", serviceRatio: 18000 }),
  ]);
  assert.equal(selection.selected?.accountId, "high");
  assert.equal(selection.requiresChoice, false);
});

test("多个非主账号实时服务费率相同时要求人工选择", () => {
  const selection = selectLeaguePromotionCandidate([
    candidate({ accountId: "a", promotionLink: "weixinstorehs/200", serviceRatio: 18000 }),
    candidate({ accountId: "b", promotionLink: "weixinstorehs/300", serviceRatio: 18000 }),
  ]);
  assert.equal(selection.selected, null);
  assert.equal(selection.requiresChoice, true);
  assert.equal(selection.candidates.length, 2);
});

test("只有一个机构链接时即使接口未返回服务费率也可选择", () => {
  const selection = selectLeaguePromotionCandidate([candidate({ serviceRatio: null })]);
  assert.equal(selection.selected?.promotionLink, "weixinstorehs/100");
  assert.equal(selection.requiresChoice, false);
});

test("没有机构推广候选时保持待确认", () => {
  const selection = selectLeaguePromotionCandidate([]);
  assert.equal(selection.selected, null);
  assert.equal(selection.requiresChoice, false);
});
