type CooperationFields = {
  storeName: string | null;
  price: number | null;
  productUrl: string | null;
  commission: string | null;
  storeRating: number | null;
  supplyChain: string | null;
  cooperationMechanism: string | null;
};

type WindowRegistrationSource = {
  shopName?: unknown;
  sellingPriceFen?: unknown;
  promotionLink?: unknown;
  serviceRatio?: unknown;
  shopScore?: unknown;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatWindowServiceRatio(value: unknown): string | null {
  const ratio = number(value);
  if (ratio === null || ratio < 0) return null;
  return `${parseFloat((ratio / 10000).toFixed(2))}%`;
}

export function mergeWindowRegistrationCooperation(
  source: WindowRegistrationSource | null | undefined,
  fallback: CooperationFields,
): CooperationFields {
  if (!source) return fallback;
  const sellingPriceFen = number(source.sellingPriceFen);
  const shopScore = number(source.shopScore);
  return {
    storeName: text(source.shopName) ?? fallback.storeName,
    price: sellingPriceFen === null ? fallback.price : sellingPriceFen / 100,
    productUrl: text(source.promotionLink) ?? fallback.productUrl,
    commission: formatWindowServiceRatio(source.serviceRatio) ?? fallback.commission,
    storeRating: shopScore === null ? fallback.storeRating : shopScore / 100,
    supplyChain: fallback.supplyChain,
    cooperationMechanism: fallback.cooperationMechanism,
  };
}
