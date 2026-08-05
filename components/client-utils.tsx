"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CurrentUser } from "@/lib/auth";

export type LookupData = {
  departments: Array<{ id: string; name: string; kind: string }>;
  locations: Array<{ id: string; name: string; code?: string | null; departmentId: string; departmentName: string }>;
  categories: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  users: Array<{ id: string; name: string; username: string; departmentId: string; departmentName: string }>;
  permissionGroups: Array<{ label: string; items: Array<{ key: string; label: string }> }>;
};

function getCsrfToken() {
  return document.cookie.split("; ").find(row => row.startsWith("huzhanggui_csrf="))?.split("=")[1] || "";
}

export async function apiFetch<T>(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), "x-csrf-token": getCsrfToken(), ...init?.headers } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "操作失败，请稍后重试");
  return payload.data as T;
}

type AppContextValue = {
  user: CurrentUser;
  lookups: LookupData | null;
  refreshLookups: () => Promise<void>;
  can: (permission: string) => boolean;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppDataProvider({ user, children }: { user: CurrentUser; children: ReactNode }) {
  const [lookups, setLookups] = useState<LookupData | null>(null);
  const refreshLookups = useCallback(async () => {
    try { setLookups(await apiFetch<LookupData>("/api/lookups")); } catch { setLookups(null); }
  }, []);
  useEffect(() => { void refreshLookups(); }, [refreshLookups]);
  const value = useMemo<AppContextValue>(() => ({ user, lookups, refreshLookups, can: (permission) => user.isSuperAdmin || user.permissions.includes(permission) }), [user, lookups, refreshLookups]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppData() {
  const value = useContext(AppContext);
  if (!value) throw new Error("AppDataProvider is missing");
  return value;
}

type Toast = { id: number; message: string; tone: "success" | "error" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random(); setToasts((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3200);
  }, []);
  return <ToastContext.Provider value={show}>{children}<div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}>{toast.message}</div>)}</div></ToastContext.Provider>;
}

export const useToast = () => useContext(ToastContext);

export function useRemote<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null); const [loading, setLoading] = useState(Boolean(url)); const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!url) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController(); abortRef.current = controller;
    setLoading(true); setError("");
    try { setData(await apiFetch<T>(url, { signal: controller.signal })); }
    catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "加载失败");
    }
    finally { setLoading(false); }
  }, [url]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);
  return { data, loading, error, reload: load, setData };
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function formatDate(value?: string | Date | null, includeTime = false) {
  if (!value) return "—";
  return (includeTime ? dateTimeFormatter : dateFormatter).format(new Date(value));
}

export async function copyToClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      return true;
    } catch { return false; }
  }
}
