import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { productLinkSchema } from "@/lib/product-link";
import { nextProductSampleCode, nextProductSku } from "@/lib/sku";
import { productSearchConditions } from "@/lib/search";
import { syncProductImageQueue, urlHash } from "@/lib/image-matching";
import { imageUrlSchema } from "@/lib/image-url";
import { COMMISSION_INPUT_PATTERN, normalizeCommission } from "@/lib/commission";

const optionalText = z.string().trim().max(1000).optional().nullable();
const commissionSchema = z.string().trim().max(30).refine(
  (value) => value === "" || COMMISSION_INPUT_PATTERN.test(value),
  "佣金只能填写数字或数字加百分号",
).optional().nullable().transform(normalizeCommission);
const productSchema = z.object({
  name: z.string().trim().min(1, "请填写商品名称").max(200),
  departmentIds: z.array(z.string().uuid()).min(1, "至少选择一个选品直播间"),
  businessContactId: z.string().uuid().optional().nullable(), storeName: optionalText,
  price: z.coerce.number().min(0).max(99999999).optional().nullable(), productUrl: productLinkSchema,
  commission: commissionSchema, storeRating: z.coerce.number().min(0).max(5).optional().nullable(),
  supplyChain: optionalText, cooperationMechanism: optionalText,
  categoryId: z.string().uuid().optional().nullable(), tagIds: z.array(z.string().uuid()).default([]),
  imageUrls: z.array(imageUrlSchema).min(1, "请先填写至少一张商品图片").max(100), notes: optionalText,
  quantity: z.coerce.number().int().min(1, "到样数量至少为 1").max(500), arrivedAt: z.string().date("请选择到样日期"),
  initialDepartmentId: z.string().uuid(), initialLocationId: z.string().uuid().optional().nullable(),
  matchRunId: z.string().uuid(), matchDecision: z.enum(["matched", "new", "failed_continue"]),
  matchedProductId: z.string().uuid().optional().nullable(),
}).superRefine((input, context) => {
  if (input.matchDecision === "matched" && !input.matchedProductId) context.addIssue({ code: "custom", path: ["matchedProductId"], message: "请选择确认的同款商品" });
});

function nullable(value: string | null | undefined): string | null { return value === "" || value === undefined ? null : value; }

export async function GET(request: Request) {
  try {
    await requireUser("products:view"); const sql = getDb(); const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const searchFrag = productSearchConditions(sql, search);
    const archived = url.searchParams.get("view") === "archived";
    const departmentId = url.searchParams.get("departmentId") || null; const categoryId = url.searchParams.get("categoryId") || null;
    const selectedPrices = Array.from(new Set(url.searchParams.getAll("price").filter((value) => /^\d+(?:\.\d{1,2})?$/.test(value)))).slice(0, 10000);
    const priceOrder = url.searchParams.get("priceOrder");
    const page = Math.max(1, Number(url.searchParams.get("page") || 1)); const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 20))); const offset = (page - 1) * pageSize;
    const priceFilter = selectedPrices.length ? sql`AND p.price = ANY(${selectedPrices}::numeric[])` : sql``;
    const orderBy = priceOrder === "asc" ? sql`p.price ASC NULLS LAST, p.created_at DESC` : priceOrder === "desc" ? sql`p.price DESC NULLS LAST, p.created_at DESC` : sql`p.created_at DESC`;
    const rows = await sql`
      SELECT p.id, p.sku, p.name, p.store_name, p.price, p.product_url, p.commission, p.store_rating, p.supply_chain, p.archived,
             p.cooperation_mechanism, p.notes, p.image_urls, p.created_at, p.updated_at,
             c.name AS category_name, u.name AS business_contact_name, count(DISTINCT s.id)::int AS sample_count,
             count(DISTINCT s.id) FILTER (WHERE s.status = 'active')::int AS active_count,
             string_agg(DISTINCT d.name, '、') AS selected_departments, string_agg(DISTINCT t.name, '、') AS tags,
             (SELECT li.id FROM link_issues li WHERE li.product_id = p.id AND li.status = 'pending' LIMIT 1) AS pending_issue_id,
             (SELECT li.id FROM link_issues li WHERE li.product_id = p.id AND li.status IN ('replaced', 'no_change', 'unresolved')
              ORDER BY li.resolved_at DESC NULLS LAST, li.created_at DESC LIMIT 1) AS latest_resolved_issue_id,
             (SELECT li.resolved_at FROM link_issues li WHERE li.product_id = p.id AND li.status IN ('replaced', 'no_change', 'unresolved')
              ORDER BY li.resolved_at DESC NULLS LAST, li.created_at DESC LIMIT 1) AS latest_resolved_at
      FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN users u ON u.id = p.business_contact_id
      LEFT JOIN samples s ON s.product_id = p.id AND (p.archived = true OR s.archived = false) LEFT JOIN product_departments pd ON pd.product_id = p.id
      LEFT JOIN departments d ON d.id = pd.department_id LEFT JOIN product_tags pt ON pt.product_id = p.id LEFT JOIN tags t ON t.id = pt.tag_id
      WHERE p.archived = ${archived} AND ${searchFrag}
        AND (${departmentId}::uuid IS NULL OR pd.department_id = ${departmentId}) AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId})
        ${priceFilter}
      GROUP BY p.id, c.name, u.name ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${offset}`;
    const [countRow] = await sql`SELECT count(DISTINCT p.id)::int AS total FROM products p LEFT JOIN product_departments pd ON pd.product_id = p.id
      WHERE p.archived = ${archived} AND ${searchFrag}
      AND (${departmentId}::uuid IS NULL OR pd.department_id = ${departmentId}) AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId})
      ${priceFilter}`;
    const priceOptions = await sql`
      SELECT p.price::text AS price, count(DISTINCT p.id)::int AS count
      FROM products p
      LEFT JOIN product_departments pd ON pd.product_id = p.id
      WHERE p.archived = ${archived} AND p.price IS NOT NULL
        AND ${searchFrag}
        AND (${departmentId}::uuid IS NULL OR pd.department_id = ${departmentId}) AND (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId})
      GROUP BY p.price ORDER BY p.price ASC`;
    return ok({ rows, total: countRow.total, page, pageSize, priceOptions });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("products:create"); const input = productSchema.parse(await readJson(request)); const sql = getDb();
    const [location] = input.initialLocationId ? await sql`SELECT id FROM locations WHERE id = ${input.initialLocationId} AND department_id = ${input.initialDepartmentId} AND active = true` : [null];
    if (input.initialLocationId && !location) return Response.json({ ok: false, message: "初始存放位置不属于所选部门" }, { status: 400 });
    const [run] = await sql`SELECT * FROM image_match_runs WHERE id = ${input.matchRunId} AND user_id = ${user.id}`;
    if (!run || (input.matchDecision !== "matched" && !input.imageUrls.some((imageUrl) => urlHash(imageUrl) === run.imageUrlHash))) return Response.json({ ok: false, message: "图片识别结果已失效，请重新识别" }, { status: 409 });
    if (input.matchDecision === "failed_continue" && run.status !== "failed") return Response.json({ ok: false, message: "识别状态与登记方式不一致" }, { status: 409 });
    if (input.matchDecision === "matched" && !run.candidates?.some((candidate: { id?: string }) => String(candidate.id) === input.matchedProductId)) return Response.json({ ok: false, message: "确认的同款商品不在识别结果中" }, { status: 409 });

    const result = await sql.begin(async (tx) => {
      let product; let previousProductData: unknown = null; let mergedProductVersion: number | null = null;
      if (input.matchDecision === "matched") {
        const matchedProductId = input.matchedProductId as string;
        const rows = await tx`SELECT * FROM products WHERE id = ${matchedProductId} FOR UPDATE`; product = rows[0];
        if (!product) throw new Error("确认的同款商品已不存在");
        const wasArchived = Boolean(product.archived);
        const previousDepartments = await tx`SELECT department_id FROM product_departments WHERE product_id = ${product.id}`;
        const previousTags = await tx`SELECT tag_id FROM product_tags WHERE product_id = ${product.id}`;
        previousProductData = { product, departmentIds: previousDepartments.map((row) => row.departmentId), tagIds: previousTags.map((row) => row.tagId) };
        const previousProductUrl = String(product.productUrl || "");
        const nextProductUrl = input.productUrl || "";
        if (previousProductUrl && previousProductUrl !== nextProductUrl) {
          await tx`
            INSERT INTO product_link_history(product_id, url, replaced_by_url, source, changed_by)
            VALUES(${product.id}, ${previousProductUrl}, ${nextProductUrl || null}, 'intake_merge', ${user.id})
          `;
        }
        const mergedImages = Array.from(new Set([...(Array.isArray(product.imageUrls) ? product.imageUrls : []), ...input.imageUrls]));
        const updated = await tx`UPDATE products SET name=${input.name}, business_contact_id=${input.businessContactId || null}, store_name=${nullable(input.storeName)},
          price=${input.price ?? null}, product_url=${nullable(input.productUrl)}, commission=${nullable(input.commission)}, store_rating=${input.storeRating ?? null},
          supply_chain=${nullable(input.supplyChain)}, cooperation_mechanism=${nullable(input.cooperationMechanism)}, category_id=${input.categoryId || null},
          image_urls=${tx.json(mergedImages)}, notes=${nullable(input.notes)}, archived=false, version=version+1, updated_at=now() WHERE id=${product.id} RETURNING *`;
        product = updated[0]; mergedProductVersion = Number(product.version);
        if (wasArchived) await tx`UPDATE samples SET archived=false, archived_with_product=false, updated_at=now() WHERE product_id=${product.id} AND archived_with_product=true`;
      } else {
        const sku = await nextProductSku(tx);
        const inserted = await tx`INSERT INTO products(sku,name,business_contact_id,store_name,price,product_url,commission,store_rating,supply_chain,cooperation_mechanism,category_id,image_urls,notes,created_by)
          VALUES(${sku},${input.name},${input.businessContactId || null},${nullable(input.storeName)},${input.price ?? null},${nullable(input.productUrl)},${nullable(input.commission)},${input.storeRating ?? null},${nullable(input.supplyChain)},${nullable(input.cooperationMechanism)},${input.categoryId || null},${tx.json(input.imageUrls)},${nullable(input.notes)},${user.id}) RETURNING *`;
        product = inserted[0];
      }
      await tx`DELETE FROM product_departments WHERE product_id = ${product.id}`;
      for (const departmentId of input.departmentIds) await tx`INSERT INTO product_departments(product_id,department_id) VALUES(${product.id},${departmentId})`;
      await tx`DELETE FROM product_tags WHERE product_id = ${product.id}`;
      for (const tagId of input.tagIds) await tx`INSERT INTO product_tags(product_id,tag_id) VALUES(${product.id},${tagId})`;
      const codes: string[] = []; const sampleIds: string[] = [];
      for (let index = 0; index < input.quantity; index += 1) {
        const code = await nextProductSampleCode(tx, String(product.id), String(product.sku));
        const [sample] = await tx`INSERT INTO samples(code,product_id,arrived_at,status,current_department_id,current_location_id,created_by)
          VALUES(${code},${product.id},${input.arrivedAt},'active',${input.initialDepartmentId},${input.initialLocationId || null},${user.id}) RETURNING id`;
        await tx`INSERT INTO sample_movements(sample_id,to_status,to_department_id,to_location_id,operator_id,remark)
          VALUES(${sample.id},'active',${input.initialDepartmentId},${input.initialLocationId || null},${user.id},${input.matchDecision === "matched" ? "同款再次到样登记" : "样品到货登记"})`;
        codes.push(code); sampleIds.push(String(sample.id));
      }
      if (input.matchDecision === "matched") await tx`INSERT INTO product_intake_batches(product_id,match_run_id,user_id,sample_ids,submitted_data,previous_product_data,merged_product_version)
        VALUES(${product.id},${input.matchRunId},${user.id},${tx.json(sampleIds)},${tx.json(input)},${tx.json(previousProductData as never)},${mergedProductVersion})`;
      await tx`UPDATE image_match_runs SET selected_product_id=${input.matchedProductId || null}, decision=${input.matchDecision}, decided_at=now() WHERE id=${input.matchRunId}`;
      await syncProductImageQueue(String(product.id), product.imageUrls as string[], tx);
      return { id: String(product.id), sku: String(product.sku), name: String(product.name), codes, imageUrls: product.imageUrls as string[], matched: input.matchDecision === "matched" };
    });
    await writeAudit(user, result.matched ? "product.match_merge" : "product.create", "product", result.id, result.matched ? `确认同款 ${result.sku}，追加 ${input.quantity} 件样品` : `登记新商品 ${result.sku}，到样 ${input.quantity} 件`, input, requestIp(request));
    return created(result);
  } catch (error) { return apiError(error); }
}
