import { z } from "zod";
import { apiError, ok } from "@/lib/api";
import { AuthError, hasPermission, requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { GLM_MODELS } from "@/lib/glm-vision";

const statusSchema = z.enum(["all", "waiting", "pending", "processing", "ready", "failed"]);

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    if (!hasPermission(user, "image_matching:manage") && !hasPermission(user, "products:correct_merge")) throw new AuthError("没有查看图片识别结果的权限", 403);
    const sql = getDb(); const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const status = statusSchema.catch("all").parse(url.searchParams.get("status") || "all");
    const requestedModel = url.searchParams.get("model") || "all";
    const model = requestedModel === "all" || requestedModel in GLM_MODELS ? requestedModel : "all";
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = 20; const offset = (page - 1) * pageSize; const pattern = `%${search}%`;
    const rows = await sql`
      SELECT f.id,f.image_url,f.subject_status,f.subject_box,f.subject_model,f.subject_error,f.subject_attempts,f.subject_updated_at,
             p.id AS product_id,p.sku,p.name,p.archived
      FROM product_image_features f JOIN products p ON p.id=f.product_id
      WHERE (${search}='' OR p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern} OR f.image_url ILIKE ${pattern})
        AND (${status}='all' OR f.subject_status=${status})
        AND (${model}='all' OR f.subject_model=${model})
      ORDER BY f.subject_updated_at DESC,f.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
    const [count] = await sql`
      SELECT count(*)::int AS total FROM product_image_features f JOIN products p ON p.id=f.product_id
      WHERE (${search}='' OR p.sku ILIKE ${pattern} OR p.name ILIKE ${pattern} OR f.image_url ILIKE ${pattern})
        AND (${status}='all' OR f.subject_status=${status})
        AND (${model}='all' OR f.subject_model=${model})
    `;
    return ok({ rows, total: count.total, page, pageSize });
  } catch (error) { return apiError(error); }
}
