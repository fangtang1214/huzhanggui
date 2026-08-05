"use client";

import Link from "next/link";
import { Download, MoveRight, Search } from "lucide-react";
import { statusLabel } from "@/lib/constants";
import { formatDate, useRemote } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, PageHeader, Pagination, ProductImage, StatusBadge } from "../ui";
import { useState } from "react";

type Movement = { id: string; batchId?: string; fromStatus?: string; toStatus: string; remark?: string; createdAt: string; sampleId: string; code: string; sku: string; productName: string; imageUrls: string[]; fromDepartmentName?: string; fromLocationName?: string; toDepartmentName?: string; toLocationName?: string; operatorName?: string };
type Data = { rows: Movement[]; total: number; page: number; pageSize: number };

function place(status: string | undefined, department?: string, location?: string) {
  if (!status) return "首次登记"; if (status !== "active") return statusLabel(status); return [department, location].filter(Boolean).join(" · ") || "位置待确认";
}

export function MovementsView() {
  const [search, setSearch] = useState(""); const [page, setPage] = useState(1); const query = new URLSearchParams({ search, page: String(page) }).toString(); const { data, loading, error, reload } = useRemote<Data>(`/api/movements?${query}`);
  return <>
    <PageHeader eyebrow="全程可追溯" title="样品流转记录" description="任何有权限的人员修改样品位置或状态，都会在这里留下记录。" actions={<Link href="/api/export?type=movements" className="button button-secondary"><Download size={17} />导出 Excel</Link>} />
    <section className="toolbar"><div className="search-box"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索实物编号、货号、商品或操作人" /></div></section>
    <section className="panel table-panel">{loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.rows.length ? <EmptyState title="暂无流转记录" /> : <><div className="movement-feed">{data.rows.map((item) => <Link href={`/samples/${item.code}`} className="movement-row" key={item.id}><div className="movement-time"><b>{formatDate(item.createdAt, true).split(" ").pop()}</b><span>{formatDate(item.createdAt)}</span></div><div className="movement-product"><ProductImage urls={item.imageUrls} alt={item.productName} size="small" /><div><span className="code-text">{item.code}</span><b>{item.productName}</b><small>货号 {item.sku}</small></div></div><div className="movement-path"><div><small>从</small><span>{place(item.fromStatus, item.fromDepartmentName, item.fromLocationName)}</span></div><MoveRight size={20} /><div><small>到</small><b>{place(item.toStatus, item.toDepartmentName, item.toLocationName)}</b></div></div><div className="movement-operator"><StatusBadge status={item.toStatus} /><span>{item.operatorName || "系统"}</span>{item.remark && <small>{item.remark}</small>}</div></Link>)}</div><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} /></>}</section>
  </>;
}
