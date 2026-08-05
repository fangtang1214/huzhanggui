export const PRODUCT_COPY_FIELDS = [
  { key: "image", label: "商品主图" },
  { key: "sku", label: "商品货号" },
  { key: "name", label: "商品名称" },
  { key: "departments", label: "选品直播间" },
  { key: "businessContact", label: "商务联系人" },
  { key: "storeName", label: "店铺名称" },
  { key: "price", label: "价格" },
  { key: "commission", label: "佣金" },
  { key: "storeRating", label: "店铺评分" },
  { key: "productUrl", label: "商品链接" },
  { key: "supplyChain", label: "供应链 / 对接群" },
  { key: "cooperationMechanism", label: "合作机制" },
  { key: "category", label: "分类" },
  { key: "tags", label: "标签" },
  { key: "notes", label: "备注" },
  { key: "createdAt", label: "登记时间" },
  { key: "updatedAt", label: "最近更新时间" },
] as const;

export type ProductCopyFieldKey = (typeof PRODUCT_COPY_FIELDS)[number]["key"];
export type ProductCopyConfig = { order: ProductCopyFieldKey[]; enabled: ProductCopyFieldKey[] };

export const PRODUCT_COPY_FIELD_KEYS = PRODUCT_COPY_FIELDS.map((field) => field.key) as ProductCopyFieldKey[];

export const DEFAULT_PRODUCT_COPY_CONFIG: ProductCopyConfig = {
  order: [...PRODUCT_COPY_FIELD_KEYS],
  enabled: ["image", "price", "productUrl"],
};

export function isProductCopyFieldKey(value: unknown): value is ProductCopyFieldKey {
  return typeof value === "string" && PRODUCT_COPY_FIELD_KEYS.includes(value as ProductCopyFieldKey);
}

export function normalizeProductCopyConfig(value: unknown): ProductCopyConfig {
  const input = value && typeof value === "object" ? value as { order?: unknown; enabled?: unknown } : {};
  const inputOrder = Array.isArray(input.order) ? input.order.filter(isProductCopyFieldKey) : [];
  const order = [...new Set([...inputOrder, ...PRODUCT_COPY_FIELD_KEYS])];
  const enabledInput = Array.isArray(input.enabled) ? input.enabled.filter(isProductCopyFieldKey) : DEFAULT_PRODUCT_COPY_CONFIG.enabled;
  const enabled = [...new Set(enabledInput)];
  return { order, enabled };
}
