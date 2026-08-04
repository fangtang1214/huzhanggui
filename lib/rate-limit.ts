type Attempt = { count: number; firstAt: number; blockedUntil: number };

const globalAttempts = globalThis as unknown as { huzhangguiLoginAttempts?: Map<string, Attempt> };
const attempts = globalAttempts.huzhangguiLoginAttempts || new Map<string, Attempt>();
globalAttempts.huzhangguiLoginAttempts = attempts;

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function loginLimitKey(ip: string | null, username: string) {
  return `${ip || "unknown"}:${username.trim().toLowerCase()}`;
}

export function checkLoginLimit(key: string) {
  const now = Date.now(); const item = attempts.get(key);
  if (!item) return { allowed: true, retryAfter: 0 };
  if (item.blockedUntil > now) return { allowed: false, retryAfter: Math.ceil((item.blockedUntil - now) / 1000) };
  if (now - item.firstAt > WINDOW_MS) { attempts.delete(key); return { allowed: true, retryAfter: 0 }; }
  return { allowed: true, retryAfter: 0 };
}

export function recordLoginFailure(key: string) {
  const now = Date.now(); const current = attempts.get(key);
  const item = !current || now - current.firstAt > WINDOW_MS ? { count: 1, firstAt: now, blockedUntil: 0 } : { ...current, count: current.count + 1 };
  if (item.count >= MAX_ATTEMPTS) item.blockedUntil = now + WINDOW_MS;
  attempts.set(key, item);
}

export function clearLoginFailures(key: string) {
  attempts.delete(key);
}
