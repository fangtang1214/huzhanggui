type SqlTransaction = {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
};

export function beijingDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function formatProductSku(date: string, sequence: number) {
  return `SP-${date.replaceAll("-", "")}-${String(sequence).padStart(3, "0")}`;
}

export async function nextProductSku(tx: SqlTransaction, date = beijingDate()) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const rows = await tx.unsafe(
      `INSERT INTO product_sku_sequences (sku_date, last_value)
       VALUES ($1, 1)
       ON CONFLICT (sku_date) DO UPDATE
       SET last_value = product_sku_sequences.last_value + 1
       RETURNING last_value`,
      [date],
    );
    const sku = formatProductSku(date, Number(rows[0].last_value));
    const existing = await tx.unsafe("SELECT 1 FROM products WHERE lower(sku)=lower($1) LIMIT 1", [sku]);
    if (!existing.length) return sku;
  }
  throw new Error("当天自动货号已用尽");
}
