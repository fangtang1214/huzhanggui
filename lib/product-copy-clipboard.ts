import { formatCommission } from "./commission";
import type { ProductCopyConfig, ProductCopyFieldKey } from "./product-copy";

export type CopyableProduct = {
  id: string;
  sku: string;
  name: string;
  imageUrls?: string[];
  selectedDepartments?: string;
  businessContactName?: string;
  storeName?: string;
  price?: string;
  commission?: string;
  storeRating?: string;
  productUrl?: string;
  supplyChain?: string;
  cooperationMechanism?: string;
  categoryName?: string;
  tags?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
};

type DateFormatter = (value?: string | Date | null, includeTime?: boolean) => string;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character);
}

function blobAsDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("商品主图读取失败"));
    reader.readAsDataURL(blob);
  });
}

function fieldText(product: CopyableProduct, key: ProductCopyFieldKey, formatDate: DateFormatter) {
  const values: Record<ProductCopyFieldKey, string> = {
    image: "",
    sku: product.sku,
    name: product.name,
    departments: product.selectedDepartments || "",
    businessContact: product.businessContactName || "",
    storeName: product.storeName || "",
    price: product.price || "",
    commission: product.commission ? formatCommission(product.commission) : "",
    storeRating: product.storeRating || "",
    productUrl: product.productUrl || "",
    supplyChain: product.supplyChain || "",
    cooperationMechanism: product.cooperationMechanism || "",
    category: product.categoryName || "",
    tags: product.tags || "",
    notes: product.notes || "",
    createdAt: formatDate(product.createdAt, true),
    updatedAt: formatDate(product.updatedAt || product.createdAt, true),
  };
  return values[key];
}

export async function copyProductToClipboard(product: CopyableProduct, config: ProductCopyConfig, formatDate: DateFormatter) {
  const fields = config.order.filter((key) => config.enabled.includes(key));
  let imageDataUrl = "";
  if (fields.includes("image")) {
    const response = await fetch(`/api/products/${product.id}/copy-image`);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.message || "商品主图复制失败");
    }
    imageDataUrl = await blobAsDataUrl(await response.blob());
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("当前浏览器不支持带图片复制，请升级浏览器后重试");
  }
  const cells = fields.map((key) => key === "image"
    ? `<td style="padding:4px"><img src="${imageDataUrl}" alt="商品主图" width="120" height="120" style="display:block;object-fit:cover" /></td>`
    : `<td>${escapeHtml(fieldText(product, key, formatDate))}</td>`).join("");
  const html = `<table><tbody><tr>${cells}</tr></tbody></table>`;
  const plainText = fields.map((key) => key === "image" ? "" : fieldText(product, key, formatDate)).join("\t");
  await navigator.clipboard.write([new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([plainText], { type: "text/plain" }),
  })]);
  return fields.length;
}
