import { z } from "zod";
import { apiError, ok, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { processProductLinkCorrection } from "@/lib/product-link-correction";
import { writeAudit } from "@/lib/audit";

const schema = z.object({ action: z.enum(["start", "retry"]), runId: z.string().uuid().optional() });

export async function GET(request: Request) {
  try {
    await requireSuperAdmin();
    const sql = getDb();
    const requestedRunId = new URL(request.url).searchParams.get("runId");
    const runs = await sql`
      SELECT r.id, r.status, r.total_count, r.processed_count, r.success_count, r.failed_count,
             r.retry_of, r.started_at, r.completed_at, r.error, r.created_at, u.name AS requested_by_name
      FROM product_link_correction_runs r
      LEFT JOIN users u ON u.id = r.requested_by
      ORDER BY r.created_at DESC LIMIT 20
    `;
    const runId = requestedRunId || runs[0]?.id || null;
    const items = runId ? await sql`
      SELECT i.id, i.product_id, i.old_product_url, i.new_product_url, i.api_product_id, i.status, i.error,
             p.sku, p.name AS product_name
      FROM product_link_correction_items i JOIN products p ON p.id = i.product_id
      WHERE i.run_id = ${runId}
      ORDER BY CASE WHEN i.status = 'failed' THEN 0 ELSE 1 END, i.updated_at DESC
      LIMIT 200
    ` : [];
    return ok({ runs, items, selectedRunId: runId });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin();
    const input = schema.parse(await readJson(request));
    const sql = getDb();
    const activeAccounts = await sql`SELECT id FROM league_accounts WHERE active = true LIMIT 1`;
    if (!activeAccounts.length) return Response.json({ ok: false, message: "请先配置至少一个已启用的联盟机构账号" }, { status: 409 });
    const [running] = await sql`SELECT id FROM product_link_correction_runs WHERE status IN ('pending', 'running') LIMIT 1`;
    if (running) return Response.json({ ok: false, message: "已有历史校正任务正在执行" }, { status: 409 });

    const run = await sql.begin(async (tx) => {
      let retryOf: string | null = null;
      let items;
      if (input.action === "retry") {
        if (!input.runId) throw new Error("缺少要重试的任务");
        retryOf = input.runId;
        items = await tx`
          SELECT i.product_id, p.product_url
          FROM product_link_correction_items i JOIN products p ON p.id = i.product_id
          WHERE i.run_id = ${input.runId} AND i.status = 'failed' AND p.archived = false
        `;
      } else {
        items = await tx`SELECT id AS product_id, product_url FROM products WHERE archived = false ORDER BY created_at, id`;
      }
      const [created] = await tx`
        INSERT INTO product_link_correction_runs(total_count, retry_of, requested_by)
        VALUES (${items.length}, ${retryOf}, ${user.id})
        RETURNING id, total_count, status
      `;
      if (items.length) {
        const productIds = items.map((item) => item.productId);
        const urls = items.map((item) => item.productUrl || null);
        await tx`
          INSERT INTO product_link_correction_items(run_id, product_id, old_product_url)
          SELECT ${created.id}, t.product_id, t.product_url
          FROM unnest(${productIds}::uuid[], ${urls}::text[]) AS t(product_id, product_url)
        `;
      }
      return created;
    });
    await writeAudit(user, "product_link_correction.start", "product_link_correction_run", run.id, input.action === "retry" ? "重试历史商品链接校正" : "开始历史商品链接校正", { runId: run.id, retryOf: input.runId || null });
    void processProductLinkCorrection(String(run.id));
    return ok({ ...run, syncing: true });
  } catch (error) { return apiError(error); }
}
