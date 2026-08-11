import { apiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

let cacheEntry: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL = 30_000;

export async function GET() {
  try {
    if (cacheEntry && Date.now() - cacheEntry.timestamp < CACHE_TTL) {
      return ok(cacheEntry.data);
    }
    await requireUser("dashboard:view");
    const sql = getDb();
    const [summary] = await sql`
      SELECT
        count(*) FILTER (WHERE s.archived = false)::int AS total_samples,
        count(*) FILTER (WHERE s.archived = false AND s.status = 'active')::int AS active_samples,
        count(*) FILTER (WHERE s.archived = false AND s.status = 'returned')::int AS returned_samples,
        count(*) FILTER (WHERE s.archived = false AND s.status IN ('damaged','lost'))::int AS exception_samples,
        count(DISTINCT s.product_id) FILTER (WHERE s.archived = false)::int AS total_products
      FROM samples s
    `;
    const locations = await sql`
      SELECT d.id, d.name, count(s.id)::int AS count
      FROM departments d
      LEFT JOIN samples s ON s.current_department_id = d.id AND s.status = 'active' AND s.archived = false
      WHERE d.active = true
      GROUP BY d.id, d.name HAVING count(s.id) > 0
      ORDER BY count DESC, d.name LIMIT 8
    `;
    const recent = await sql`
      SELECT m.id, m.created_at, m.to_status, m.remark, s.code, p.name AS product_name,
             p.sku, u.name AS operator_name, fd.name AS from_department_name,
             td.name AS to_department_name, tl.name AS to_location_name
      FROM sample_movements m
      JOIN samples s ON s.id = m.sample_id
      JOIN products p ON p.id = s.product_id
      LEFT JOIN users u ON u.id = m.operator_id
      LEFT JOIN departments fd ON fd.id = m.from_department_id
      LEFT JOIN departments td ON td.id = m.to_department_id
      LEFT JOIN locations tl ON tl.id = m.to_location_id
      ORDER BY m.created_at DESC LIMIT 8
    `;
    const newSampleProducts = await sql`
      WITH recent_samples AS (
        SELECT s.product_id,
               count(*) FILTER (WHERE s.created_at >= now() - interval '24 hours')::int AS sample_count_24h,
               count(*)::int AS sample_count_7d,
               max(s.created_at) AS latest_sample_created_at
        FROM samples s
        WHERE s.archived = false
          AND s.created_at >= now() - interval '7 days'
        GROUP BY s.product_id
      )
      SELECT p.id, p.sku, p.name, p.image_urls,
             recent.sample_count_24h, recent.sample_count_7d, recent.latest_sample_created_at,
             (SELECT string_agg(DISTINCT d.name, '、')
              FROM product_departments pd
              JOIN departments d ON d.id = pd.department_id
              WHERE pd.product_id = p.id) AS selected_departments
      FROM recent_samples recent
      JOIN products p ON p.id = recent.product_id
      WHERE p.archived = false
      ORDER BY recent.latest_sample_created_at DESC
      LIMIT 12
    `;
    const data = { summary, locations, recent, newSampleProducts };
    cacheEntry = { data, timestamp: Date.now() };
    return ok(data);
  } catch (error) {
    return apiError(error);
  }
}
