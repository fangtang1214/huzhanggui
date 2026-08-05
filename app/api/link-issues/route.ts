import { z } from "zod";
import { apiError, created, ok, readJson, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { LINK_ISSUE_STATUSES } from "@/lib/link-issues";

const createSchema = z.object({
  productId: z.string().uuid(),
  previousIssueId: z.string().uuid().optional().nullable(),
  note: z.string().trim().min(1, "请填写问题备注").max(2000, "问题备注不能超过 2000 字"),
});

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const sql = getDb();
    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const like = `%${search}%`;
    const statusValue = url.searchParams.get("status") || null;
    const status = statusValue && LINK_ISSUE_STATUSES.includes(statusValue as (typeof LINK_ISSUE_STATUSES)[number]) ? statusValue : null;
    if (statusValue && !status) return Response.json({ ok: false, message: "处理状态不正确" }, { status: 400 });
    const departmentValue = url.searchParams.get("departmentId") || null;
    const departmentId = departmentValue ? z.string().uuid().parse(departmentValue) : null;
    const focusValue = url.searchParams.get("focusId") || null;
    const focusId = focusValue ? z.string().uuid().parse(focusValue) : null;
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get("pageSize") || 20)));
    const offset = (page - 1) * pageSize;

    const rows = await sql`
      SELECT li.id, li.product_id, li.previous_issue_id, li.old_product_url, li.report_note, li.status,
             li.new_product_url, li.resolution_note, li.reported_by, li.reported_department_id,
             li.resolved_by, li.resolved_at, li.created_at, li.updated_at,
             p.sku, p.name AS product_name, p.store_name, p.supply_chain, p.image_urls,
             reporter.name AS reported_by_name, department.name AS reported_department_name,
             resolver.name AS resolved_by_name
      FROM link_issues li
      JOIN products p ON p.id = li.product_id
      JOIN departments department ON department.id = li.reported_department_id
      LEFT JOIN users reporter ON reporter.id = li.reported_by
      LEFT JOIN users resolver ON resolver.id = li.resolved_by
      WHERE (${search} = '' OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like} OR p.supply_chain ILIKE ${like})
        AND (${status}::text IS NULL OR li.status = ${status})
        AND (${departmentId}::uuid IS NULL OR li.reported_department_id = ${departmentId})
      ORDER BY CASE WHEN li.id = ${focusId} THEN 0 WHEN li.status = 'pending' THEN 1 ELSE 2 END, li.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}`;
    const [countRow] = await sql`
      SELECT count(*)::int AS total
      FROM link_issues li
      JOIN products p ON p.id = li.product_id
      WHERE (${search} = '' OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.store_name ILIKE ${like} OR p.supply_chain ILIKE ${like})
        AND (${status}::text IS NULL OR li.status = ${status})
        AND (${departmentId}::uuid IS NULL OR li.reported_department_id = ${departmentId})`;

    return ok({
      rows: rows.map((row) => ({ ...row, canCancel: row.status === "pending" && row.reportedBy === user.id })),
      total: countRow.total,
      page,
      pageSize,
      canProcess: user.departmentKind === "business",
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const input = createSchema.parse(await readJson(request));
    const sql = getDb();
    const ipAddress = requestIp(request);
    const result = await sql.begin(async (tx) => {
      const [product] = await tx`SELECT id, sku, name, product_url FROM products WHERE id = ${input.productId} AND archived = false FOR UPDATE`;
      if (!product) return { missing: true as const };
      if (input.previousIssueId) {
        const [previous] = await tx`
          SELECT id FROM link_issues
          WHERE id = ${input.previousIssueId} AND product_id = ${product.id}
            AND status IN ('replaced', 'no_change', 'unresolved')`;
        if (!previous) return { invalidPrevious: true as const };
      }
      const inserted = await tx`
        INSERT INTO link_issues(product_id, previous_issue_id, reported_by, reported_department_id, old_product_url, report_note)
        VALUES(${product.id}, ${input.previousIssueId || null}, ${user.id}, ${user.departmentId}, ${product.productUrl || null}, ${input.note})
        ON CONFLICT (product_id) WHERE status = 'pending' DO NOTHING
        RETURNING id`;
      if (!inserted.length) {
        const [existing] = await tx`SELECT id FROM link_issues WHERE product_id = ${product.id} AND status = 'pending' LIMIT 1`;
        return { id: String(existing.id), sku: String(product.sku), existing: true as const };
      }
      const id = String(inserted[0].id);
      await tx`
        INSERT INTO audit_logs(user_id, action, entity_type, entity_id, summary, changes, ip_address)
        VALUES(${user.id}, 'link_issue.create', 'link_issue', ${id}, ${`为 ${product.sku} 发起链接报障`},
               ${tx.json({ productId: String(product.id), sku: String(product.sku), previousIssueId: input.previousIssueId || null, oldProductUrl: product.productUrl || null, reportNote: input.note })}, ${ipAddress})`;
      return { id, sku: String(product.sku), existing: false as const };
    });
    if ("missing" in result) return Response.json({ ok: false, message: "商品不存在或已归档" }, { status: 404 });
    if ("invalidPrevious" in result) return Response.json({ ok: false, message: "最近一次问题记录不存在或尚未处理" }, { status: 409 });
    return result.existing ? ok(result) : created(result);
  } catch (error) {
    return apiError(error);
  }
}
