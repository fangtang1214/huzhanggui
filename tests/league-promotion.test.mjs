import test from "node:test";
import assert from "node:assert/strict";
import { effectiveWindowProductId, needsInstitutionPromotionRefresh, normalizeLeaguePromotionLink, parseLeagueProductDetail, parseLeagueProductQuality, preferredLeaguePromotionCandidates, selectLeaguePromotionCandidate } from "../lib/league-product.ts";

function candidate(overrides = {}) {
  return {
    promotionLink: "weixinstorehs/100",
    commissionRatio: 1000,
    normalCommissionRatio: 800,
    serviceRatio: 10000,
    commissionType: 0,
    planType: 0,
    accountId: "account-1",
    accountName: "机构一",
    accountIsPrimary: false,
    headSupplierItemLink: "weixinstorehs/100",
    linkType: "merchant_assigned",
    error: null,
    ...overrides,
  };
}

test("仅识别两种原始联盟推广链接并规范前缀", () => {
  assert.equal(normalizeLeaguePromotionLink(" weixinstorehs/28684289399598 "), "weixinstorehs/28684289399598");
  assert.equal(normalizeLeaguePromotionLink("WEIXINSTORESUBHS/6000000016843667"), "weixinstoresubhs/6000000016843667");
  assert.equal(normalizeLeaguePromotionLink("https://example.com/product"), null);
  assert.equal(normalizeLeaguePromotionLink("v1=promotion-token"), null);
  assert.equal(normalizeLeaguePromotionLink("28684289399598"), null);
});

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

test("机构分配达人佣金链接优先于主账号的商家指定链接", () => {
  const selection = selectLeaguePromotionCandidate([
    candidate({ accountId: "primary", accountIsPrimary: true, promotionLink: "weixinstorehs/300", serviceRatio: 30000 }),
    candidate({ accountId: "secondary", promotionLink: "weixinstoresubhs/6000000016843667", headSupplierItemLink: "weixinstoresubhs/6000000016843667", linkType: "institution_assigned", serviceRatio: 5000 }),
  ]);
  assert.equal(selection.selected?.accountId, "secondary");
  assert.equal(selection.selected?.promotionLink, "weixinstoresubhs/6000000016843667");
  assert.equal(selection.requiresChoice, false);
});

test("只有旧商家指定链接缓存时需要重新扫描机构分配目录", () => {
  assert.equal(needsInstitutionPromotionRefresh([
    candidate({ promotionLink: "weixinstorehs/28759597470513", linkType: "merchant_assigned" }),
  ]), true);
  assert.equal(needsInstitutionPromotionRefresh([
    candidate({ promotionLink: "weixinstoresubhs/6000000016843667", linkType: "institution_assigned" }),
  ]), false);
});

test("多个机构分配链接先选主账号再比较服务费率", () => {
  const selection = selectLeaguePromotionCandidate([
    candidate({ accountId: "secondary", promotionLink: "weixinstoresubhs/200", linkType: "institution_assigned", serviceRatio: 30000 }),
    candidate({ accountId: "primary", accountIsPrimary: true, promotionLink: "weixinstoresubhs/300", linkType: "institution_assigned", serviceRatio: 5000 }),
  ]);
  assert.equal(selection.selected?.accountId, "primary");
  assert.equal(selection.requiresChoice, false);
});

test("没有主账号的机构分配链接选择服务费率最高者", () => {
  const selection = selectLeaguePromotionCandidate([
    candidate({ accountId: "low", promotionLink: "weixinstoresubhs/200", linkType: "institution_assigned", serviceRatio: 8000 }),
    candidate({ accountId: "high", promotionLink: "weixinstoresubhs/300", linkType: "institution_assigned", serviceRatio: 18000 }),
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

test("按官方商品详情层级解析店铺评分与好评率", () => {
  assert.deepEqual(parseLeagueProductQuality({
    product: {
      product_info: { good_evaluation_ratio: 92900 },
      shop: { name: "测试小店", score: 472, icon: "https://example.com/shop.png" },
    },
  }), {
    shopName: "测试小店",
    shopScore: 472,
    shopIcon: "https://example.com/shop.png",
    goodEvaluationRatio: 92900,
  });
});

test("带货商品优先使用货源小店商品 ID，自营商品回退橱窗 ID", () => {
  assert.equal(effectiveWindowProductId("14000813361261", "10001176563660"), "10001176563660");
  assert.equal(effectiveWindowProductId("10001213105308", null), "10001213105308");
});

test("联盟商品详情保留快捷登记需要的名称、图片、价格和店铺资料", () => {
  assert.deepEqual(parseLeagueProductDetail({
    product: {
      product_info: {
        title: "测试商品",
        head_imgs: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        selling_price: 2990,
        shop_appid: "shop-appid",
        good_evaluation_ratio: 95100,
      },
      shop: { name: "测试小店", score: 486, icon: "https://example.com/shop.jpg" },
    },
  }), {
    title: "测试商品",
    imageUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
    sellingPriceFen: 2990,
    shopAppid: "shop-appid",
    shopName: "测试小店",
    shopScore: 486,
    shopIcon: "https://example.com/shop.jpg",
    goodEvaluationRatio: 95100,
  });
});

test("联盟商品详情从多规格中读取最低实际售价", () => {
  assert.equal(parseLeagueProductDetail({
    product: {
      title: "多规格商品",
      head_imgs: ["https://example.com/sku.jpg"],
      skus: [
        { sale_price: 3990, market_price: 4990 },
        { sale_price: 2990, market_price: 4590 },
      ],
    },
  }).sellingPriceFen, 2990);
});

test("联盟商品详情兼容价格信息对象", () => {
  assert.equal(parseLeagueProductDetail({
    product: {
      product_info: {
        title: "价格区间商品",
        price_info: { min_sale_price: "2590" },
      },
    },
  }).sellingPriceFen, 2590);
});

test("快捷登记只要求人工选择最高优先级且同费率的机构", () => {
  const preferred = preferredLeaguePromotionCandidates([
    candidate({ accountId: "low", serviceRatio: 8000 }),
    candidate({ accountId: "high-a", promotionLink: "weixinstorehs/a", serviceRatio: 18000 }),
    candidate({ accountId: "high-b", promotionLink: "weixinstorehs/b", serviceRatio: 18000 }),
  ]);
  assert.deepEqual(preferred.map((item) => item.accountId), ["high-a", "high-b"]);
});
