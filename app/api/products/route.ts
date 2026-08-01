import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { productLinkSchema } from "@/lib/product-link";

const optionalText = z.string().trim().max(1000).optional().nullable();
const productSchema = z.object({
  sku: z.string().trim().min(1, "请填写货号").max(100),
  name: z.string().trim().min(1, "请填写商品名称").max(200),
  departmentIds: z.array(z.string().uuid()).min(1, "至少选择一个选品直播间"),
  businessContactId: z.string().uuid().optional().nullable(),
  storeName: optionalText,
  price: z.coerce.number().min(0).max(99999999).optional().nullable(),
  productUrl: productLinkSchema,
  commission: optionalText,
  storeRating: z.coerce.number().min(0).max(5).optional().nullable(),
  supplyChain: optionalText,
  cooperationMechanism: optionalText,
  categoryId: z.string().uuid().optional().nullable(),
  tagIds: z.array(z.string().uuid()).default([]),
  imageUrls: z.array(z.string().trim().url("图片网址格式不正确")).max(12).default([]),
  notes: optionalText,
  quantity: z.coerce.number().int().min(1, "到样数量至少为 1").max(500),
  arrivedAt: z.string().date("请选择到样日期"),
  initialDepartmentId: z.string().uuid(),
  initialLocationId: z.string().uuid().optional().nullable(),
});

function sampleCode(date: string, seq: string | number | bigint) {
  return `SY-${date.replaceAll("-", "")}-${String(seq).padStart(6, "0")}`;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser("products:view");
    const sql = getDb();
    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const like = `%${search}%`;
    const departmentId = url.searchParams.get("departmentId") || null;
    const categoryId = url.searchParams.get("categoryId") || null;
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 20)));
    const offset = (page - 1) * pageSize;
    const scopedDepartment = user.dataScope === "department" ? user.departmentId : null;

    const rows = await sql`
      SELECT p.id, p.sku, p.name, p.store_name, p.price, p.product_url, p.commission,
             p.store_rating, p.supply_chain, p.image_urls, p.created_at, p.updated_at,
             c.name AS category_name, u.name AS business_contact_name,
             count(DISTINCT s.id)::int AS sample_count,
             count(DISTINCT s.id) FILTER (WHERE s.status = 'active')::int AS active_count,
             string_agg(DISTINCT d.name, '、') AS selected_departments,
             string_agg(DISTINCT t.name, '、') AS tags
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN users u ON u.id = p.business_contact_id
      LEFT JOIN samples s ON s.product_id = p.id AND s.archived = false
      LEFT JOIN product_departments pd ON pd.product_id = p.id
      LEFT JOIN departments d ON d.id = pd.department_id
      LEFT JOIN product_tags pt ON pt.product_id = p.id
      LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.archived = false
        AND (${search} = '' OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like})
        AND (${departmentId}::uuid IS NULL OR pd.department_id = ${departmentId})
        AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId})
        AND (${scopedDepartment}::uuid IS NULL OR pd.department_id = ${scopedDepartment}
          OR EXISTS (SELECT 1 FROM samples sx WHERE sx.product_id = p.id AND sx.current_department_id = ${scopedDepartment}))
      GROUP BY p.id, c.name, u.name
      ORDER BY p.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [countRow] = await sql`
      SELECT count(DISTINCT p.id)::int AS total
      FROM products p
      LEFT JOIN product_departments pd ON pd.product_id = p.id
      WHERE p.archived = false
        AND (${search} = '' OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like})
        AND (${departmentId}::uuid IS NULL OR pd.department_id = ${departmentId})
        AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId})
        AND (${scopedDepartment}::uuid IS NULL OR pd.department_id = ${scopedDepartment}
          OR EXISTS (SELECT 1 FROM samples sx WHERE sx.product_id = p.id AND sx.current_department_id = ${scopedDepartment}))
    `;
    return ok({ rows, total: countRow.total, page, pageSize });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create");
    const input = productSchema.parse(await readJson(request));
    const sql = getDb();
    const [location] = input.initialLocationId
      ? await sql`SELECT id FROM locations WHERE id = ${input.initialLocationId} AND department_id = ${input.initialDepartmentId} AND active = true`
      : [null];
    if (input.initialLocationId && !location) {
      return Response.json({ ok: false, message: "初始存放位置不属于所选部门" }, { status: 400 });
    }

    const result = await sql.begin(async (tx) => {
      const [product] = await tx`
        INSERT INTO products (
          sku, name, business_contact_id, store_name, price, product_url, commission,
          store_rating, supply_chain, cooperation_mechanism, category_id, image_urls,
          notes, created_by
        ) VALUES (
          ${input.sku}, ${input.name}, ${input.businessContactId || null}, ${input.storeName || null},
          ${input.price ?? null}, ${input.productUrl || null}, ${input.commission || null},
          ${input.storeRating ?? null}, ${input.supplyChain || null}, ${input.cooperationMechanism || null},
          ${input.categoryId || null}, ${tx.json(input.imageUrls)}, ${input.notes || null}, ${user.id}
        ) RETURNING id, sku, name
      `;
      for (const departmentId of input.departmentIds) {
        await tx`INSERT INTO product_departments (product_id, department_id) VALUES (${product.id}, ${departmentId})`;
      }
      for (const tagId of input.tagIds) {
        await tx`INSERT INTO product_tags (product_id, tag_id) VALUES (${product.id}, ${tagId})`;
      }
      const codes: string[] = [];
      for (let i = 0; i < input.quantity; i += 1) {
        const [sequence] = await tx`SELECT nextval('sample_code_seq') AS seq`;
        const code = sampleCode(input.arrivedAt, sequence.seq);
        const [sample] = await tx`
          INSERT INTO samples (
            code, product_id, arrived_at, status, current_department_id, current_location_id, created_by
          ) VALUES (${code}, ${product.id}, ${input.arrivedAt}, 'active', ${input.initialDepartmentId},
                    ${input.initialLocationId || null}, ${user.id}) RETURNING id
        `;
        await tx`
          INSERT INTO sample_movements (sample_id, to_status, to_department_id, to_location_id, operator_id, remark)
          VALUES (${sample.id}, 'active', ${input.initialDepartmentId}, ${input.initialLocationId || null},
                  ${user.id}, '样品到货登记')
        `;
        codes.push(code);
      }
      return { id: String(product.id), sku: String(product.sku), name: String(product.name), codes };
    });
    await writeAudit(user, "product.create", "product", result.id, `登记商品 ${result.sku}，到样 ${input.quantity} 件`, input, requestIp(request));
    return created(result);
  } catch (error) {
    return apiError(error);
  }
}
