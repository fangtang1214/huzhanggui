import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiError, created, ok, requestIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

const run = promisify(execFile);
const BACKUP_DIR = process.env.NODE_ENV === "production" ? "/backups" : path.join(process.cwd(), ".local-backups");

async function listBackups() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const files = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
  const rows = await Promise.all(files.filter((item) => item.isFile() && /^siyuan-\d{8}-\d{6}\.dump$/.test(item.name)).map(async (item) => {
    const stat = await fs.stat(path.join(BACKUP_DIR, item.name)); return { name: item.name, size: stat.size, createdAt: stat.mtime.toISOString() };
  }));
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function GET() {
  try { await requireUser("backups:view"); return ok(await listBackups()); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser("backups:manage");
    if (!process.env.DATABASE_URL) throw new Error("数据库未配置");
    const now = new Date(); const stamp = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now).reduce<Record<string, string>>((acc, part) => { acc[part.type] = part.value; return acc; }, {});
    const name = `siyuan-${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${stamp.minute}${stamp.second}.dump`; await fs.mkdir(BACKUP_DIR, { recursive: true });
    await run("pg_dump", ["--dbname", process.env.DATABASE_URL, "--format=custom", "--compress=9", "--file", path.join(BACKUP_DIR, name)], { timeout: 10 * 60 * 1000 });
    await writeAudit(user, "backup.create", "backup", name, `手动创建数据库备份 ${name}`, undefined, requestIp(request));
    return created({ name });
  } catch (error) { return apiError(error); }
}
