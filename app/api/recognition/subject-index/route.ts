import { z } from "zod";
import { apiError, ok, readJson, requestIp } from "@/lib/api";
import { AuthError, hasPermission, requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { GLM_MODELS, getGlmSettings } from "@/lib/glm-vision";
import { embedImage, IMAGE_MODEL } from "@/lib/image-matching";

const statusSchema = z.enum(["all", "waiting", "pending", "processing", "ready", "failed"]);
const boxSchema = z.tuple([
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
  z.number().finite().min(0).max(1000),
]).refine((box) => box[2] - box[0] >= 10 && box[3] - box[1] >= 10, "主体框范围太小或坐标顺序不正确");
const correctionSchema = z.object({ id: z.string().uuid(), box: boxSchema });
const vectorLiteral = (values: number[]) => `[${values.map(Number).join(",")}]`;

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
             f.subject_box_source,f.subject_corrected_at,p.id AS product_id,p.sku,p.name,p.archived,corrector.name AS subject_corrected_by_name
      FROM product_image_features f JOIN products p ON p.id=f.product_id
      LEFT JOIN users corrector ON corrector.id=f.subject_corrected_by
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
    return ok({ rows, total: count.total, page, pageSize, canCorrect: hasPermission(user, "image_matching:manage") });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!hasPermission(user, "image_matching:manage")) throw new AuthError("没有纠正商品主体框的权限", 403);
    const input = correctionSchema.parse(await readJson(request)); const sql = getDb();
    const [feature] = await sql`SELECT id,image_url,url_hash FROM product_image_features WHERE id=${input.id}`;
    if (!feature) return Response.json({ ok: false, message: "该图片索引不存在或已被删除" }, { status: 404 });
    const settings = await getGlmSettings();
    const result = await embedImage(String(feature.imageUrl), input.box, "interactive");
    if (result.model !== IMAGE_MODEL) throw new Error("图片识别模型版本不一致，请稍后重试");
    const embedding = vectorLiteral(result.embedding);
    await sql.begin(async (tx) => {
      await tx`INSERT INTO image_subject_cache(url_hash,model,image_url,subject_box,embedding,box_source)
        VALUES(${feature.urlHash},${settings.model},${feature.imageUrl},${tx.json(input.box)},${embedding}::vector(512),'manual')
        ON CONFLICT(url_hash,model) DO UPDATE SET image_url=excluded.image_url,subject_box=excluded.subject_box,
          embedding=excluded.embedding,box_source='manual',updated_at=now()`;
      await tx`UPDATE product_image_features SET subject_status='ready',subject_box=${tx.json(input.box)},subject_model=${settings.model},
        subject_embedding_vector=${embedding}::vector(512),subject_error=NULL,subject_box_source='manual',
        subject_corrected_by=${user.id},subject_corrected_at=now(),subject_updated_at=now()
        WHERE url_hash=${feature.urlHash}`;
    });
    await writeAudit(user, "image.subject_box_corrected", "product_image_feature", input.id, "已人工纠正商品主体框", { box: input.box, model: settings.model }, requestIp(request));
    return ok({ saved: true, box: input.box, model: settings.model });
  } catch (error) { return apiError(error); }
}
