"use client";
/* eslint-disable @next/next/no-img-element -- 商品图片来自用户填写的外部网址，不经过服务器图片代理。 */

import { ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, ImageOff, Inbox, LoaderCircle, X } from "lucide-react";
import { SAMPLE_STATUSES } from "@/lib/constants";

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal-card ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></header><div className="modal-body">{children}</div></section></div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function LoadingState({ label = "正在加载…" }: { label?: string }) { return <div className="state-panel"><LoaderCircle className="spin" size={28} /><p>{label}</p></div>; }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="state-panel state-error"><CircleAlert size={30} /><b>{message}</b>{retry && <button className="button button-secondary" onClick={retry}>重新加载</button>}</div>; }
export function EmptyState({ title = "暂无数据", description, action }: { title?: string; description?: string; action?: ReactNode }) { return <div className="empty-state"><Inbox size={34} /><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>; }

export function StatusBadge({ status }: { status: string }) {
  const item = SAMPLE_STATUSES.find((entry) => entry.value === status);
  return <span className={`status-badge status-${item?.tone || "gray"}`}><i />{item?.label || status}</span>;
}

export function ProductImage({ urls, alt, size = "medium" }: { urls?: string[] | null; alt: string; size?: "small" | "medium" | "large" }) {
  const src = Array.isArray(urls) ? urls[0] : null;
  if (!src) return <div className={`product-image image-${size} image-placeholder`}><ImageOff size={size === "small" ? 16 : 22} /></div>;
  return <div className={`product-image image-${size}`}><img src={src} alt={alt} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.display = "none"; }} /></div>;
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize)); if (total <= pageSize) return null;
  return <div className="pagination"><span>共 {total} 条</span><div><button className="icon-button" disabled={page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={18} /></button><b>{page} / {pages}</b><button className="icon-button" disabled={page >= pages} onClick={() => onChange(page + 1)}><ChevronRight size={18} /></button></div></div>;
}

export function Field({ label, required, hint, children, className = "" }: { label: string; required?: boolean; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`form-field ${className}`}><span>{label}{required && <em>*</em>}</span>{children}{hint && <small>{hint}</small>}</label>;
}
