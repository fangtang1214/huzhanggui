import { z } from "zod";
import type { CurrentUser } from "./auth";
import { AuthError } from "./auth";
import { ALL_PERMISSIONS, isPermissionKey } from "./permissions";

export const accountPermissionsSchema = z.array(z.string()).max(ALL_PERMISSIONS.length)
  .refine((items) => items.every(isPermissionKey), "包含无效权限")
  .transform((items) => Array.from(new Set(items)));

function samePermissions(left: string[], right: string[]) {
  const leftSet = new Set(left); const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((permission) => rightSet.has(permission));
}

export function assertCanChangeAccountPermissions(actor: CurrentUser, before: string[], after: string[], self: boolean) {
  if (actor.isSuperAdmin) return;
  if (self && !samePermissions(before, after)) throw new AuthError("不能修改自己的账号权限", 403);
  const beforeManage = before.includes("users:manage"); const afterManage = after.includes("users:manage");
  if (beforeManage !== afterManage) throw new AuthError("只有超级管理员可以授予或移除管理账号权限", 403);
  for (const permission of ALL_PERMISSIONS) {
    if (actor.permissions.includes(permission)) continue;
    if (before.includes(permission) !== after.includes(permission)) {
      throw new AuthError("不能调整自己未拥有的权限", 403);
    }
  }
}

