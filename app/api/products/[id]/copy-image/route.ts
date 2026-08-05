import { apiError } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUser("products:view");
    const { id } = await context.params;
    const sql = getDb();
    const [product] = await sql`SELECT image_urls FROM products WHERE id = ${id} AND archived = false`;
    const imageUrl = Array.isArray(product?.imageUrls)
      ? product.imageUrls.find((value: unknown) => typeof value === "string" && /^https?:\/\//i.test(value))
      : null;
    if (!imageUrl) return Response.json({ ok: false, message: "该商品没有可复制的主图" }, { status: 404 });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(imageUrl, { signal: controller.signal, headers: { "user-agent": "HuZhangGui/1.0" } });
      const contentType = response.headers.get("content-type") || "";
      const imageType = contentType.split(";")[0].trim().toLowerCase();
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (!response.ok || !SAFE_IMAGE_TYPES.has(imageType)) {
        return Response.json({ ok: false, message: "主图暂时无法读取" }, { status: 502 });
      }
      if (declaredSize > MAX_IMAGE_BYTES) {
        return Response.json({ ok: false, message: "主图文件过大，暂时无法复制" }, { status: 413 });
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        return Response.json({ ok: false, message: "主图文件过大，暂时无法复制" }, { status: 413 });
      }
      return new Response(buffer, {
        headers: {
          "content-type": imageType,
          "cache-control": "private, max-age=300",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return apiError(error);
  }
}
