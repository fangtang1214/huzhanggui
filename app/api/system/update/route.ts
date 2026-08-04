import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { apiError, ok, requestIp } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

const UPDATE_DIR = process.env.SYSTEM_UPDATE_DIR || "/updates";
const STATUS_PATH = path.join(UPDATE_DIR, "status.json");
const REQUEST_PATH = path.join(UPDATE_DIR, "request");
const ACTIVE_STATES = new Set(["queued", "running"]);

type UpdateStatus = {
  available: boolean;
  state: "idle" | "queued" | "running" | "succeeded" | "failed";
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  versionBefore?: string;
  versionAfter?: string;
};

function isEnabled() {
  return process.env.SYSTEM_UPDATE_ENABLED === "true";
}

async function readStatus(): Promise<UpdateStatus> {
  if (!isEnabled()) return { available: false, state: "idle" };
  try {
    const parsed = JSON.parse(await fs.readFile(/* turbopackIgnore: true */ STATUS_PATH, "utf8")) as Partial<UpdateStatus>;
    const state = ["idle", "queued", "running", "succeeded", "failed"].includes(parsed.state || "") ? parsed.state as UpdateStatus["state"] : "idle";
    return { available: true, state, requestedAt: parsed.requestedAt, startedAt: parsed.startedAt, finishedAt: parsed.finishedAt, versionBefore: parsed.versionBefore, versionAfter: parsed.versionAfter };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { available: true, state: "idle" };
    throw error;
  }
}

async function writeJsonAtomic(target: string, value: unknown) {
  const temporary = path.join(UPDATE_DIR, `.${path.basename(target)}-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o640 });
  await fs.rename(temporary, target);
}

export async function GET() {
  try {
    await requireSuperAdmin();
    return ok(await readStatus());
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireSuperAdmin();
    if (!isEnabled()) return Response.json({ ok: false, message: "服务器尚未启用网页更新服务，请先手动执行一次更新脚本" }, { status: 503 });
    await fs.mkdir(UPDATE_DIR, { recursive: true });
    const current = await readStatus();
    if (ACTIVE_STATES.has(current.state)) return Response.json({ ok: false, message: "系统更新正在进行，请勿重复提交" }, { status: 409 });
    try {
      await fs.access(REQUEST_PATH);
      return Response.json({ ok: false, message: "系统更新请求已提交，请稍候" }, { status: 409 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const requestedAt = new Date().toISOString();
    const status: UpdateStatus = { available: true, state: "queued", requestedAt };
    await writeAudit(user, "system.update_requested", "system", null, "从管理后台请求系统更新", undefined, requestIp(request));
    await writeJsonAtomic(STATUS_PATH, status);

    const temporaryRequest = path.join(UPDATE_DIR, `.request-${randomUUID()}.tmp`);
    await fs.writeFile(temporaryRequest, `${JSON.stringify({ requestedAt, requestedBy: user.id })}\n`, { encoding: "utf8", mode: 0o640 });
    try { await fs.link(temporaryRequest, REQUEST_PATH); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return Response.json({ ok: false, message: "系统更新请求已提交，请稍候" }, { status: 409 });
      throw error;
    } finally { await fs.unlink(temporaryRequest).catch(() => undefined); }
    return ok(status, { status: 202 });
  } catch (error) { return apiError(error); }
}
