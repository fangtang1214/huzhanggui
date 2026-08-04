import fs from "node:fs/promises";
import path from "node:path";
import { apiError, ok, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

function safePath(name: string) {
  if (!/^(?:huzhanggui|siyuan)-\d{8}-\d{6}\.dump$/.test(name)) throw new Error("备份文件名不正确");
  const root = process.env.NODE_ENV === "production" ? "/backups" : path.join(process.cwd(), ".local-backups");
  return path.join(root, name);
}

export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireUser("backups:manage"); const { name } = await context.params; const buffer = await fs.readFile(/*turbopackIgnore: true*/ safePath(name));
    await writeAudit(user, "backup.download", "backup", name, `下载数据库备份 ${name}`, undefined, requestIp(request));
    return new Response(buffer, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"` } });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request, context: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireUser("backups:manage"); const { name } = await context.params; await fs.unlink(safePath(name));
    await writeAudit(user, "backup.delete", "backup", name, `删除数据库备份 ${name}`, undefined, requestIp(request)); return ok({ deleted: true });
  } catch (error) { return apiError(error); }
}
