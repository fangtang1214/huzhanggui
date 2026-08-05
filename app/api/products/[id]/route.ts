import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { productLinkSchema } from "@/lib/product-link";
import { syncProductImageQueue } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";
import { COMMISSION_INPUT_PATTERN, normalizeCommission } from "@/lib/commission";

const optionalText = z.string().trim().max(1000).optional().nullable();
const commissionSchema = z.string().trim().max(30).refine(
  (value) => value === "" || COMMISSION_INPUT_PATTERN.test(value),
  "佣金只能填写数字或数字加百分号",
).optional().nullable().transform(normalizeCommission);
const schema = z.object({
  name: z.string().trim().min(1, "请填写商品名称").max(200),
  departmentIds: z.array(z.string().uuid()).min(1, "至少选择一个选品直播间"),
  businessContactId: z.string().uuid().optional().nullable(),
  storeName: optionalText,
  price: z.coerce.number().min(0).max(99999999).optional().nullable(),
  productUrl: productLinkSchema,
  commission: commissionSchema,
  storeRating: z.coerce.number().min(0).max(5).optional().nullable(),
  supplyChain: optionalText,
  cooperationMechanism: optionalText,
  categoryId: z.string().uuid().optional().nullable(),
  tagIds: z.array(z.string().uuid()).default([]),
  imageUrls: z.array(imageUrlSchema).max(100).default([]),
  notes: optionalText,
});

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser("products:view");
    const { id } = await context.params;
    const sql = getDb();
    const rows = await sql`
      SELECT p.*, c.name AS category_name, u.name AS business_contact_name,
             (SELECT coalesce(json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name), '[]')
              FROM product_departments pd JOIN departments d ON d.id = pd.department_id WHERE pd.product_id = p.id) AS departments,
             (SELECT coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name), '[]')
              FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id) AS tags
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN users u ON u.id = p.business_contact_id
      WHERE p.id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return Response.json({ ok: false, message: "商品不存在" }, { status: 404 });
    const samples = await sql`
      SELECT s.id, s.code, s.arrived_at, s.status, s.note, s.archived,
             d.name AS department_name, l.name AS location_name, s.updated_at
      FROM samples s
      LEFT JOIN departments d ON d.id = s.current_department_id
      LEFT JOIN locations l ON l.id = s.current_location_id
      WHERE s.product_id = ${id} AND (s.archived = false OR ${Boolean(rows[0].archived)} = true)
      ORDER BY s.created_at DESC
    `;
    const linkHistory = await sql`
      SELECT history.id, history.url, history.replaced_by_url, history.source, history.source_entity_id,
             history.changed_at, actor.name AS changed_by_name
      FROM product_link_history history
      LEFT JOIN users actor ON actor.id = history.changed_by
      WHERE history.product_id = ${id}
      ORDER BY history.changed_at DESC, history.id DESC
    `;
    return ok({ product: rows[0], samples, linkHistory });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("products:edit");
    const { id } = await context.params;
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const [before] = await sql`SELECT * FROM products WHERE id = ${id} AND archived = false`;
    if (!before) return Response.json({ ok: false, message: "商品不存在" }, { status: 404 });
    await sql.begin(async (tx) => {
      const previousProductUrl = String(before.productUrl || "");
      const nextProductUrl = input.productUrl || "";
      if (previousProductUrl && previousProductUrl !== nextProductUrl) {
        await tx`
          INSERT INTO product_link_history(product_id, url, replaced_by_url, source, changed_by)
          VALUES(${id}, ${previousProductUrl}, ${nextProductUrl || null}, 'product_edit', ${user.id})
        `;
      }
      await tx`
        UPDATE products SET name = ${input.name},
          business_contact_id = ${input.businessContactId || null}, store_name = ${input.storeName || null},
          price = ${input.price ?? null}, product_url = ${input.productUrl || null}, commission = ${input.commission || null},
          store_rating = ${input.storeRating ?? null}, supply_chain = ${input.supplyChain || null},
          cooperation_mechanism = ${input.cooperationMechanism || null}, category_id = ${input.categoryId || null},
          image_urls = ${tx.json(input.imageUrls)}, notes = ${input.notes || null}, version = version + 1, updated_at = now()
        WHERE id = ${id}
      `;
      await tx`DELETE FROM product_departments WHERE product_id = ${id}`;
      for (const departmentId of input.departmentIds) {
        await tx`INSERT INTO product_departments(product_id, department_id) VALUES (${id}, ${departmentId})`;
      }
      await tx`DELETE FROM product_tags WHERE product_id = ${id}`;
      for (const tagId of input.tagIds) {
        await tx`INSERT INTO product_tags(product_id, tag_id) VALUES (${id}, ${tagId})`;
      }
    });
    await syncProductImageQueue(id, input.imageUrls);
    await writeAudit(user, "product.update", "product", id, `修改商品 ${before.sku}`, { before, after: input }, requestIp(request));
    return ok({ id });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser("products:archive");
    const { id } = await context.params;
    const sql = getDb();
    const [product] = await sql`SELECT sku, name FROM products WHERE id = ${id} AND archived = false`;
    if (!product) return Response.json({ ok: false, message: "商品不存在" }, { status: 404 });
    const [active] = await sql`SELECT count(*)::int AS count FROM samples WHERE product_id = ${id} AND archived = false AND status = 'active'`;
    if (active.count > 0) {
      return Response.json({ ok: false, message: "该商品仍有在库或在用样品，请先处理样品状态" }, { status: 409 });
    }
    await sql.begin(async (tx) => {
      await tx`UPDATE products SET archived = true, version = version + 1, updated_at = now() WHERE id = ${id}`;
      await tx`UPDATE samples SET archived = true, archived_with_product = true, updated_at = now() WHERE product_id = ${id} AND archived = false`;
    });
    await writeAudit(user, "product.archive", "product", id, `归档商品 ${product.sku} ${product.name}`, undefined, requestIp(request));
    return ok({ archived: true });
  } catch (error) {
    return apiError(error);
  }
}
