import type { CurrentUser } from "./auth";
import { getDb } from "./db";

export async function writeAudit(
  user: CurrentUser | null,
  action: string,
  entityType: string,
  entityId: string | null,
  summary: string,
  changes?: unknown,
  ipAddress?: string | null,
) {
  const sql = getDb();
  await sql`
    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, summary, changes, ip_address)
    VALUES (${user?.id || null}, ${action}, ${entityType}, ${entityId}, ${summary},
            ${changes === undefined ? null : sql.json(changes as never)}, ${ipAddress || null})
  `;
}

