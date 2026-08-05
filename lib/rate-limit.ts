import { getDb } from "./db";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function loginLimitKey(ip: string | null, username: string) {
  return `${ip || "unknown"}:${username.trim().toLowerCase()}`;
}

export async function checkLoginLimit(key: string) {
  const sql = getDb();
  await sql`DELETE FROM login_attempts WHERE expires_at < now()`;
  const [row] = await sql`SELECT count, blocked_until FROM login_attempts WHERE key = ${key} LIMIT 1`;
  if (!row) return { allowed: true, retryAfter: 0 };
  const now = Date.now();
  if (row.blockedUntil && new Date(row.blockedUntil).getTime() > now) {
    return { allowed: false, retryAfter: Math.ceil((new Date(row.blockedUntil).getTime() - now) / 1000) };
  }
  if (row.count >= MAX_ATTEMPTS) return { allowed: false, retryAfter: Math.ceil(WINDOW_MS / 1000) };
  return { allowed: true, retryAfter: 0 };
}

export async function recordLoginFailure(key: string) {
  const sql = getDb();
  await sql`
    INSERT INTO login_attempts (key, count, expires_at)
    VALUES (${key}, 1, now() + (${WINDOW_MS} || ' milliseconds')::interval)
    ON CONFLICT (key) DO UPDATE SET
      count = login_attempts.count + 1,
      blocked_until = CASE WHEN login_attempts.count + 1 >= ${MAX_ATTEMPTS} THEN now() + (${WINDOW_MS} || ' milliseconds')::interval ELSE NULL END,
      expires_at = now() + (${WINDOW_MS} || ' milliseconds')::interval
  `;
}

export async function clearLoginFailures(key: string) {
  const sql = getDb();
  await sql`DELETE FROM login_attempts WHERE key = ${key}`;
}
