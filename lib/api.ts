import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "./auth";
import { SkuGenerationError } from "./sku";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function created(data: unknown) {
  return ok(data, { status: 201 });
}

export function apiError(error: unknown) {
  if (error instanceof AuthError) {
    return NextResponse.json({ ok: false, message: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { ok: false, message: error.issues[0]?.message || "提交内容不完整" },
      { status: 400 },
    );
  }
  if (error instanceof SkuGenerationError) {
    console.error(error);
    return NextResponse.json({ ok: false, message: "自动编号生成异常，本次登记未保存，请联系管理员" }, { status: 500 });
  }
  const dbError = error as { code?: string; constraint_name?: string; message?: string };
  if (dbError?.code === "23505") {
    return NextResponse.json({ ok: false, message: "名称或编号已经存在" }, { status: 409 });
  }
  if (dbError?.code === "23503") {
    return NextResponse.json({ ok: false, message: "该数据正在被使用，不能删除" }, { status: 409 });
  }
  console.error(error);
  return NextResponse.json({ ok: false, message: "系统处理失败，请稍后重试" }, { status: 500 });
}

export async function readJson<T = unknown>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ZodError([{ code: "custom", path: [], message: "请求内容格式不正确" }]);
  }
}

export function requestIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null
  );
}
