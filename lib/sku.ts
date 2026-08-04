type SqlTransaction = {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
};

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
  if (value > 9999) throw new SkuGenerationError("本年度商品数量已达到 9999 件");
  const year = date.slice(0, 4);
  if (!/^\d{4}$/.test(year)) throw new SkuGenerationError("商品货号年份异常");
  return `HZG-${year}-${String(value).padStart(4, "0")}`;
}

export function formatSampleCode(productSku: string, sequence: number) {
  if (!/^HZG-\d{4}-\d{4,}$/.test(productSku)) throw new SkuGenerationError("商品货号格式异常");
  const value = validSequence(sequence, "实物编号");
  return `${productSku}-${String(value).padStart(3, "0")}`;
}

export async function nextProductSku(tx: SqlTransaction, date = beijingDate()) {
  const sequenceDate = `${date.slice(0, 4)}-01-01`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await tx.unsafe(
      `INSERT INTO product_sku_sequences (sku_date, last_value)
       VALUES ($1, 1)
       ON CONFLICT (sku_date) DO UPDATE
       SET last_value = product_sku_sequences.last_value + 1
       RETURNING last_value AS sequence`,
      [sequenceDate],
    );
    const sku = formatProductSku(date, validSequence(rows[0]?.sequence, "商品货号"));
    const existing = await tx.unsafe("SELECT 1 FROM products WHERE lower(sku)=lower($1) LIMIT 1", [sku]);
    if (!existing.length) return sku;
  }
  throw new SkuGenerationError("本年度商品货号序列存在冲突");
}

export async function nextProductSampleCode(tx: SqlTransaction, productId: string, productSku: string) {
  const rows = await tx.unsafe(
    `INSERT INTO product_sample_sequences (product_id, last_value)
     VALUES ($1, 1)
     ON CONFLICT (product_id) DO UPDATE
     SET last_value = product_sample_sequences.last_value + 1,
         updated_at = now()
     RETURNING last_value AS sequence`,
    [productId],
  );
  return formatSampleCode(productSku, validSequence(rows[0]?.sequence, "实物编号"));
}
