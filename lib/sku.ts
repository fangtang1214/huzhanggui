import type { Sql, TransactionSql } from "postgres";

type Queryable = Sql<Record<string, unknown>> | TransactionSql<Record<string, unknown>>;

export class SkuGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkuGenerationError";
  }
}

export function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function validSequence(value: unknown, label: string) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new SkuGenerationError(`${label}序列异常`);
  return sequence;
}

export function formatProductSku(date: string, sequence: number) {
  const value = validSequence(sequence, "商品货号");
  if (value > 9999) throw new SkuGenerationError("本月商品数量已达到 9999 件");
  const year = date.slice(2, 4);
  const month = date.slice(5, 7);
  if (!/^\d{2}$/.test(year) || !/^\d{2}$/.test(month)) throw new SkuGenerationError("商品货号日期异常");
  return `${year}${month}${String(value).padStart(4, "0")}`;
}

export function formatSampleCode(productSku: string, sequence: number) {
  const isLegacy = /^HZG-\d{4}-\d{4,}$/.test(productSku);
  const isNew = /^\d{8}$/.test(productSku);
  if (!isLegacy && !isNew) throw new SkuGenerationError("商品货号格式异常");
  const value = validSequence(sequence, "实物编号");
  return `${productSku}-${String(value).padStart(3, "0")}`;
}

export async function nextProductSku(tx: Queryable, date = beijingDate()) {
  const sequenceDate = `${date.slice(0, 4)}-${date.slice(5, 7)}-01`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await tx`
      INSERT INTO product_sku_sequences (sku_date, last_value)
      VALUES (${sequenceDate}, 1)
      ON CONFLICT (sku_date) DO UPDATE
      SET last_value = product_sku_sequences.last_value + 1
      RETURNING last_value AS sequence
    `;
    const sku = formatProductSku(date, validSequence(rows[0]?.sequence, "商品货号"));
    const existing = await tx`SELECT 1 FROM products WHERE lower(sku)=lower(${sku}) LIMIT 1`;
    if (!existing.length) return sku;
  }
  throw new SkuGenerationError("本月商品货号序列存在冲突");
}

export async function nextProductSampleCode(tx: Queryable, productId: string, productSku: string) {
  const rows = await tx`
    INSERT INTO product_sample_sequences (product_id, last_value)
    VALUES (${productId}, 1)
    ON CONFLICT (product_id) DO UPDATE
    SET last_value = product_sample_sequences.last_value + 1,
        updated_at = now()
    RETURNING last_value AS sequence
  `;
  return formatSampleCode(productSku, validSequence(rows[0]?.sequence, "实物编号"));
}
