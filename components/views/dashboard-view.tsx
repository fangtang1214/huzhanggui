"use client";

import Link from "next/link";
import { ArrowRight, Boxes, CircleAlert, CornerDownLeft, MapPin, PackageCheck, PackagePlus, ScanLine } from "lucide-react";
import { statusLabel } from "@/lib/constants";
import { formatDate, useAppData, useRemote } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, PageHeader, ProductImage, StatusBadge } from "../ui";

type DashboardData = {
  summary: { totalSamples: number; activeSamples: number; returnedSamples: number; exceptionSamples: number; totalProducts: number };
  locations: Array<{ id: string; name: string; count: number }>;
  recent: Array<{ id: string; createdAt: string; toStatus: string; remark?: string; code: string; productName: string; sku: string; operatorName?: string; fromDepartmentName?: string; toDepartmentName?: string; toLocationName?: string }>;
  newProducts: Array<{ id: string; sku: string; name: string; imageUrls: string[]; createdAt: string; sampleCount: number; selectedDepartments?: string }>;
};

export function DashboardView() {
  const { user, can } = useAppData();
  const { data, loading, error, reload } = useRemote<DashboardData>(can("dashboard:view") ? "/api/dashboard" : null);
  if (loading) return <LoadingState label="正在整理今日样品…" />;
  if (error || !data) return <ErrorState message={error || "工作台暂时无法显示"} retry={reload} />;
  const maxLocation = Math.max(1, ...data.locations.map((item) => item.count));
  return <>
    <PageHeader eyebrow={`你好，${user.name}`} title="今天的样品，一眼看清" description="实时查看公司内每件样品的所在位置与最近流转。" actions={<>{can("products:create") && <Link href="/products/new" className="button button-primary"><PackagePlus size={18} />登记新到样</Link>}<Link href="/scan" className="button button-secondary"><ScanLine size={18} />手机扫码</Link></>} />
    <section className="summary-grid">
      <article className="summary-card summary-featured"><div><span>实物样品总数</span><strong>{data.summary.totalSamples}</strong><small>{data.summary.totalProducts} 款商品</small></div><div className="summary-icon"><Boxes size={24} /></div></article>
      <article className="summary-card"><div><span>在库 / 在用</span><strong>{data.summary.activeSamples}</strong><small>当前有明确位置</small></div><div className="summary-icon icon-green"><PackageCheck size={23} /></div></article>
      <article className="summary-card"><div><span>已退样</span><strong>{data.summary.returnedSamples}</strong><small>完整保留退样记录</small></div><div className="summary-icon icon-blue"><CornerDownLeft size={23} /></div></article>
      <article className="summary-card"><div><span>异常样品</span><strong>{data.summary.exceptionSamples}</strong><small>损坏、丢失或报废</small></div><div className="summary-icon icon-amber"><CircleAlert size={23} /></div></article>
    </section>
    <section className="dashboard-grid">
      <article className="panel panel-location"><header className="panel-header"><div><p className="eyebrow">当前位置</p><h2>各部门样品分布</h2></div><Link href="/products">查看全部 <ArrowRight size={15} /></Link></header>
        {data.locations.length === 0 ? <EmptyState title="还没有在库样品" description="登记到样后，位置分布会显示在这里。" /> : <div className="location-bars">{data.locations.map((item) => <div className="location-row" key={item.id}><div><span>{item.name}</span><b>{item.count} 件</b></div><div className="bar-track"><i style={{ width: `${Math.max(5, item.count / maxLocation * 100)}%` }} /></div></div>)}</div>}
      </article>
      <article className="panel"><header className="panel-header"><div><p className="eyebrow">最新动态</p><h2>最近流转记录</h2></div><Link href="/movements">全部记录 <ArrowRight size={15} /></Link></header>
        {data.recent.length === 0 ? <EmptyState title="暂无流转记录" description="样品位置变化后会自动记录。" /> : <div className="activity-list">{data.recent.map((item) => <Link href={`/samples/${item.code}`} className="activity-item" key={item.id}><span className="activity-dot" /><div><div className="activity-title"><b>{item.productName}</b><StatusBadge status={item.toStatus} /></div><p>{item.code} · {item.toStatus === "active" ? [item.toDepartmentName, item.toLocationName].filter(Boolean).join(" · ") : statusLabel(item.toStatus)}</p><small>{item.operatorName || "系统"} · {formatDate(item.createdAt, true)}</small></div></Link>)}</div>}
      </article>
    </section>
    <section className="panel new-products-panel"><header className="panel-header"><div><p className="eyebrow">刚刚到样</p><h2>最近登记的商品</h2></div><Link href="/products">商品档案 <ArrowRight size={15} /></Link></header>
      {data.newProducts.length === 0 ? <EmptyState title="还没有商品档案" action={can("products:create") ? <Link href="/products/new" className="button button-primary">登记第一款商品</Link> : undefined} /> : <div className="product-strip">{data.newProducts.map((product) => <Link href={`/products/${product.id}`} className="product-mini-card" key={product.id}><ProductImage urls={product.imageUrls} alt={product.name} size="medium" /><div><span className="sku-chip">{product.sku}</span><h3>{product.name}</h3><p><MapPin size={14} />{product.selectedDepartments || "未指定直播间"}</p><small>{product.sampleCount} 件样品 · {formatDate(product.createdAt)}</small></div></Link>)}</div>}
    </section>
  </>;
}
