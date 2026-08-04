import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { AuthError, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { productLinkSchema } from "@/lib/product-link";

const cancelSchema = z.object({ action: z.literal("cancel") });
const resolveSchema = z.object({
  action: z.literal("resolve"),
  result: z.enum(["replaced", "no_change", "unresolved"]),
  newProductUrl: productLinkSchema.optional().default(""),
  resolutionNote: z.string().trim().max(2000, "处理说明不能超过 2000 字").optional().default(""),
}).superRefine((input, context) => {
  if (input.result === "replaced" && !input.newProductUrl) {
    context.addIssue({ code: "custom", path: ["newProductUrl"], message: "请填写新商品链接" });
  }
  if ((input.result === "no_change" || input.result === "unresolved") && !input.resolutionNote) {
    context.addIssue({ code: "custom", path: ["resolutionNote"], message: "请填写处理原因" });
  }
});
const actionSchema = z.union([cancelSchema, resolveSchema]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const issueId = z.string().uuid().parse(id);
    const input = actionSchema.parse(await readJson(request));
    const sql = getDb();
    const ipAddress = requestIp(request);

    const result = await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT li.*, p.sku, p.name AS product_name, p.product_url
        FROM link_issues li JOIN products p ON p.id = li.product_id
        WHERE li.id = ${issueId} FOR UPDATE OF li`;
      const issue = rows[0];
      if (!issue) return { missing: true as const };

      const before = {
        status: issue.status,
        newProductUrl: issue.newProductUrl || null,
        resolutionNote: issue.resolutionNote || null,
        resolvedBy: issue.resolvedBy || null,
        resolvedAt: issue.resolvedAt || null,
        productUrl: issue.productUrl || null,
      };

      if (input.action === "cancel") {
        if (issue.status !== "pending") return { conflict: "只有待处理问题可以撤销" };
        if (issue.reportedBy !== user.id) throw new AuthError("只有原发起人可以撤销问题", 403);
        await tx`
          UPDATE link_issues SET status = 'cancelled', new_product_url = NULL, resolution_note = NULL,
                 resolved_by = NULL, resolved_at = now(), updated_at = now()
          WHERE id = ${issueId}`;
        await tx`
          INSERT INTO audit_logs(user_id, action, entity_type, entity_id, summary, changes, ip_address)
          VALUES(${user.id}, 'link_issue.cancel', 'link_issue', ${issueId}, ${`撤销 ${issue.sku} 的链接报障`},
                 ${tx.json({ before, after: { status: "cancelled" } })}, ${ipAddress})`;
        return { id: issueId, status: "cancelled" as const };
      }

      if (user.departmentKind !== "business") throw new AuthError("只有商务部账号可以处理链接问题", 403);
      if (issue.status === "cancelled") return { conflict: "已撤销的问题不能再修改处理结果" };

      const newProductUrl = input.result === "replaced" ? input.newProductUrl : null;
      const resolutionNote = input.resolutionNote || null;
      if (input.result === "replaced") {
        await tx`
          UPDATE products SET product_url = ${newProductUrl}, version = version + 1, updated_at = now()
          WHERE id = ${issue.productId}`;
      }
      await tx`
        UPDATE link_issues SET status = ${input.result}, new_product_url = ${newProductUrl},
               resolution_note = ${resolutionNote}, resolved_by = ${user.id}, resolved_at = now(), updated_at = now()
        WHERE id = ${issueId}`;
      const action = issue.status === "pending" ? "link_issue.resolve" : "link_issue.update_result";
      const summary = issue.status === "pending" ? `处理 ${issue.sku} 的链接报障` : `修改 ${issue.sku} 的链接报障结果`;
      await tx`
        INSERT INTO audit_logs(user_id, action, entity_type, entity_id, summary, changes, ip_address)
        VALUES(${user.id}, ${action}, 'link_issue', ${issueId}, ${summary},
               ${tx.json({ before, after: { status: input.result, newProductUrl, resolutionNote, productUrl: input.result === "replaced" ? newProductUrl : issue.productUrl || null } })}, ${ipAddress})`;
      return { id: issueId, status: input.result };
    });

    if ("missing" in result) return Response.json({ ok: false, message: "问题记录不存在" }, { status: 404 });
    if ("conflict" in result) return Response.json({ ok: false, message: result.conflict }, { status: 409 });
    return ok(result);
  } catch (error) {
    return apiError(error);
  }
}

