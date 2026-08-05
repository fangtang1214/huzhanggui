import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { getDb } from "./db";

const COOKIE_NAME = "huzhanggui_session";
const LEGACY_COOKIE_NAME = "siyuan_session";
const SESSION_DAYS = 7;

export type CurrentUser = {
  id: string;
  username: string;
  name: string;
  departmentId: string;
  departmentName: string;
  departmentKind: "business" | "live_room" | "management" | "other";
  permissions: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
};

function hashToken(token: string) {
  if (!process.env.SESSION_SECRET && process.env.NODE_ENV === "production") {
    throw new Error("生产环境缺少 SESSION_SECRET");
  }
  const secret = process.env.SESSION_SECRET || "development-only-secret";
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

export function hasPermission(user: CurrentUser, permission: string) {
  return user.isSuperAdmin || user.permissions.includes(permission);
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value || cookieStore.get(LEGACY_COOKIE_NAME)?.value;
  if (!token) return null;
  const sql = getDb();
  const tokenHash = hashToken(token);
  const rows = await sql`
    SELECT u.id, u.username, u.name, u.department_id, d.name AS department_name, d.kind AS department_kind,
           u.permissions, u.is_super_admin, u.must_change_password
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    JOIN departments d ON d.id = u.department_id
    WHERE s.token_hash = ${tokenHash}
      AND s.expires_at > now()
      AND u.active = true AND d.active = true
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const row = rows[0];
  void sql`UPDATE sessions SET last_seen_at = now() WHERE token_hash = ${tokenHash}`;
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    departmentKind: row.departmentKind,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    isSuperAdmin: Boolean(row.isSuperAdmin),
    mustChangePassword: row.mustChangePassword,
  };
}

export async function authenticate(username: string, password: string) {
  const sql = getDb();
  const rows = await sql`
    SELECT u.id, u.password_hash, u.active, d.active AS department_active
    FROM users u
    JOIN departments d ON d.id = u.department_id
    WHERE lower(u.username) = ${username.trim().toLowerCase()}
    LIMIT 1
  `;
  if (rows.length === 0 || !rows[0].active || !rows[0].departmentActive) {
    return null;
  }
  const valid = await bcrypt.compare(password, rows[0].passwordHash);
  return valid ? rows[0].id : null;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const sql = getDb();
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, now() + (${SESSION_DAYS} || ' days')::interval)
  `;
  await sql`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value || cookieStore.get(LEGACY_COOKIE_NAME)?.value;
  if (token) {
    const sql = getDb();
    await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  }
  cookieStore.set(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
  cookieStore.set(LEGACY_COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function requireUser(permission?: string) {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("请先登录", 401);
  if (permission && !hasPermission(user, permission)) {
    throw new AuthError("没有执行此操作的权限", 403);
  }
  return user;
}

export async function requireSuperAdmin() {
  const user = await requireUser();
  if (!user.isSuperAdmin) {
    throw new AuthError("仅超级管理员可以执行系统更新", 403);
  }
  return user;
}

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
