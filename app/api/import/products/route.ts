import { z } from "zod";
import { apiError, created, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { productLinkSchema } from "@/lib/product-link";
import { nextProductSampleCode, nextProductSku } from "@/lib/sku";
import { syncProductImageQueue } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";
import { COMMISSION_INPUT_PATTERN, normalizeCommission } from "@/lib/commission";
import { parseXlsxRows } from "@/lib/xlsx";

const FIELD_MAP: Record<string, string> = {
  "商品名称*": "name", "选品部门*": "departments", "价格*": "price",
  "商品链接*": "productUrl", "佣金*": "commission", "分类*": "category",
  "供应链/机构*": "supplyChain", "图片链接*": "imageUrls", "到样数量*": "quantity",
  "存放部门*": "dept", "存放位置*": "location", "店铺名*": "storeName",
  "店铺评分": "storeRating", "合作机制": "cooperationMechanism", "备注": "notes",
};
const COL_KEYS = Object.keys(FIELD_MAP);

type ParsedRow = Record<string, string>;
type ImportError = { row: number; message: string };

function parsePrice(value: string) {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 99999999 ? parsed : null;
}

function parseCommission(value: string) {
  const trimmed = value.trim().replace(/％/g, "%");
  if (COMMISSION_INPUT_PATTERN.test(trimmed)) return normalizeCommission(trimmed);
  return null;
}

function parseQuantity(value: string) {
  const parsed = parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : null;
}

function parseRating(value: string) {
  if (!value.trim()) return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function mapHeaders(headers: string[]) {
  const mapping: Record<string, number> = {};
  const errors: string[] = [];
  for (let i = 0; i < headers.length; i += 1) {
    const key = FIELD_MAP[headers[i].trim()];
    if (key) mapping[key] = i;
  }
  for (const col of COL_KEYS) {
    const key = FIELD_MAP[col];
    if (!(key in mapping)) errors.push(`缺少列「${col}」`);
  }
  return { mapping, errors };
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create");
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) return Response.json({ ok: false, message: "请上传 Excel 文件" }, { status: 400 });

    const buffer = new Uint8Array(await file.arrayBuffer());
    let rows: string[][];
    try { rows = parseXlsxRows(buffer); } catch {
      return Response.json({ ok: false, message: "无法解析上传的文件，请确保是 .xlsx 格式" }, { status: 400 });
    }
    if (rows.length < 2) return Response.json({ ok: false, message: "文件中没有数据行" }, { status: 400 });

    const headers = rows[0];
    const { mapping, errors: headerErrors } = mapHeaders(headers);
    if (headerErrors.length > 0) return Response.json({ ok: false, message: headerErrors.join("；") }, { status: 400 });

    const sql = getDb();
    const [departments, categories, locations] = await Promise.all([
      sql`SELECT id, name FROM departments WHERE active = true`,
      sql`SELECT id, name FROM categories WHERE active = true`,
      sql`SELECT id, name, department_id FROM locations WHERE active = true`,
    ]);
    const deptMap = new Map(departments.map((d) => [String(d.name).toLowerCase(), String(d.id)]));
    const catMap = new Map(categories.map((c) => [String(c.name).toLowerCase(), String(c.id)]));
    const locMap = new Map(locations.map((l) => [String(l.deptId || l.department_id) + ":" + String(l.name).toLowerCase(), String(l.id)]));
    const bizDeptId = departments.find((d) => String(d.kind) === "business")?.id as string | undefined;

    const parsedRows: Array<{ row: number; data: ParsedRow }> = [];
    const failures: ImportError[] = [];

    for (let i = 1; i < rows.length; i += 1) {
      const rowNum = i + 1;
      const cells = rows[i];
      if (cells.every((c) => !c)) continue;
      const row: ParsedRow = {};
      for (const [key, idx] of Object.entries(mapping)) {
        if (idx < cells.length) row[key] = (cells[idx] || "").trim();
      }
      if (!row.name) { failures.push({ row: rowNum, message: "商品名称为空" }); continue; }
      if (!row.departments) { failures.push({ row: rowNum, message: "选品部门为空" }); continue; }
      const price = parsePrice(row.price || "");
      if (!price) { failures.push({ row: rowNum, message: "价格格式不正确" }); continue; }
      if (!row.productUrl) { failures.push({ row: rowNum, message: "商品链接为空" }); continue; }
      const parsedUrl = productLinkSchema.safeParse(row.productUrl);
      if (!parsedUrl.success) { failures.push({ row: rowNum, message: "商品链接格式不正确" }); continue; }
      const commission = parseCommission(row.commission || "");
      if (!commission) { failures.push({ row: rowNum, message: "佣金格式不正确" }); continue; }
      if (!row.category) { failures.push({ row: rowNum, message: "分类为空" }); continue; }
      const catId = catMap.get(row.category.toLowerCase());
      if (!catId) { failures.push({ row: rowNum, message: `分类「${row.category}」不存在` }); continue; }
      if (!row.supplyChain) { failures.push({ row: rowNum, message: "供应链/机构为空" }); continue; }
      const quantity = parseQuantity(row.quantity || "");
      if (!quantity) { failures.push({ row: rowNum, message: "到样数量格式不正确（1-500）" }); continue; }
      if (!row.dept) { failures.push({ row: rowNum, message: "存放部门为空" }); continue; }
      const deptId = deptMap.get(row.dept.toLowerCase());
      if (!deptId) { failures.push({ row: rowNum, message: `存放部门「${row.dept}」不存在` }); continue; }
      if (!row.location) { failures.push({ row: rowNum, message: "存放位置为空" }); continue; }
      const locId = locMap.get(deptId + ":" + row.location.toLowerCase());
      if (!locId) { failures.push({ row: rowNum, message: `存放位置「${row.location}」在所选部门中不存在` }); continue; }
      if (!row.storeName) { failures.push({ row: rowNum, message: "店铺名为空" }); continue; }
      if (!row.imageUrls) { failures.push({ row: rowNum, message: "图片链接为空" }); continue; }
      const imageUrls = row.imageUrls.split(/[,，\s]+/).filter(Boolean);
      if (imageUrls.length === 0) { failures.push({ row: rowNum, message: "图片链接为空" }); continue; }
      if (imageUrls.length > 100) { failures.push({ row: rowNum, message: "图片链接最多 100 张" }); continue; }
      for (const url of imageUrls) {
        const parsed = imageUrlSchema.safeParse(url);
        if (!parsed.success) { failures.push({ row: rowNum, message: `图片链接格式不正确：${url.substring(0, 40)}` }); break; }
      }
      if (failures.length && failures[failures.length - 1].row === rowNum && failures[failures.length - 1].message.includes("图片链接")) continue;
      const rating = parseRating(row.storeRating || "");
      if (rating === null && row.storeRating?.trim()) { failures.push({ row: rowNum, message: "店铺评分格式不正确（0-5）" }); continue; }
      const deptCandidates = row.departments.split(/[,，、\s]+/).filter(Boolean);
      const deptIds: string[] = [];
      const unknownDepts: string[] = [];
      for (const dn of deptCandidates) {
        const did = deptMap.get(dn.toLowerCase());
        if (did) deptIds.push(did); else unknownDepts.push(dn);
      }
      if (unknownDepts.length > 0) { failures.push({ row: rowNum, message: `选品部门不存在：${unknownDepts.join("、")}` }); continue; }
      if (deptIds.length === 0) { failures.push({ row: rowNum, message: "至少选择一个选品部门" }); continue; }

      parsedRows.push({ row: rowNum, data: { ...row, deptIds: deptIds.join(","), imageUrls: imageUrls.join(","), price: String(price), commission, category: catId, dept: deptId, location: locId, quantity: String(quantity), storeRating: rating !== null ? String(rating) : "" } });
    }

    if (failures.length > 0 && parsedRows.length === 0) {
      return Response.json({ ok: false, message: `全部 ${failures.length} 行校验失败`, failures }, { status: 400 });
    }

    const imported: string[] = [];
    await sql.begin(async (tx) => {
      for (const { row: rowNum, data } of parsedRows) {
        try {
          const sku = await nextProductSku(tx);
          const imgUrls = data.imageUrls ? data.imageUrls.split(",").map((u) => u.trim()).filter(Boolean) : [];
          const [product] = await tx`
            INSERT INTO products(sku, name, store_name, price, product_url, commission, store_rating, supply_chain, cooperation_mechanism, category_id, image_urls, notes, created_by)
            VALUES (${sku}, ${data.name}, ${data.storeName}, ${Number(data.price)}, ${data.productUrl}, ${data.commission},
              ${data.storeRating ? Number(data.storeRating) : null}, ${data.supplyChain}, ${data.cooperationMechanism || null},
              ${data.category}, ${tx.json(imgUrls)}, ${data.notes || null}, ${user.id})
            RETURNING id
          `;
          for (const did of data.deptIds.split(",")) {
            if (did) await tx`INSERT INTO product_departments(product_id, department_id) VALUES (${product.id}, ${did})`;
          }
          for (let qi = 0; qi < (Number(data.quantity) || 1); qi += 1) {
            const code = await nextProductSampleCode(tx, String(product.id), sku);
            const [sample] = await tx`INSERT INTO samples(code, product_id, arrived_at, status, current_department_id, current_location_id, created_by)
              VALUES (${code}, ${product.id}, now(), 'active', ${data.dept}, ${data.location}, ${user.id}) RETURNING id`;
            await tx`INSERT INTO sample_movements(sample_id, to_status, to_department_id, to_location_id, operator_id, remark)
              VALUES (${sample.id}, 'active', ${data.dept}, ${data.location}, ${user.id}, '批量导入到样')`;
          }
          imported.push(`${sku} ${data.name}`);
        } catch (err) {
          failures.push({ row: rowNum, message: err instanceof Error ? err.message : "导入失败" });
        }
      }
    });

    await writeAudit(user, "product.import", "product", null, `批量导入 ${imported.length} 件商品`, { count: imported.length, failures: failures.length }, requestIp(request));
    return created({ imported: imported.length, total: imported.length + failures.length, failures });
  } catch (error) {
    return apiError(error);
  }
}
