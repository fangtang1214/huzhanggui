"use client";
/* eslint-disable @next/next/no-img-element -- 商品预览直接使用外部图片网址，不经过服务器图片代理。 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDownUp, ArrowLeft, Boxes, CalendarDays, CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Clipboard, Download, ExternalLink, FilePenLine, FileSpreadsheet, Filter, GripVertical, History, Image, ImagePlus, Link2, LoaderCircle, MapPin, PackagePlus, Plus, RefreshCw, Search, Settings2, Sparkles, Store, Trash2, TriangleAlert, Upload, UserRound, X } from "lucide-react";
import { activeLocationLabel } from "@/lib/constants";
import { COMMISSION_INPUT_PATTERN, formatCommission, normalizeCommission } from "@/lib/commission";
import { isWebProductLink } from "@/lib/product-link";
import { PRODUCT_COPY_FIELDS, normalizeProductCopyConfig, type ProductCopyConfig, type ProductCopyFieldKey } from "@/lib/product-copy";
import { copyProductToClipboard } from "@/lib/product-copy-clipboard";
import { apiFetch, copyToClipboard, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader, Pagination, ProductImage, StatusBadge } from "../ui";

type ProductRow = { id: string; sku: string; name: string; archived?: boolean; storeName?: string; price?: string; productUrl?: string; commission?: string; storeRating?: string; supplyChain?: string; cooperationMechanism?: string; notes?: string; imageUrls: string[]; createdAt: string; updatedAt?: string; categoryName?: string; businessContactName?: string; sampleCount: number; activeCount: number; selectedDepartments?: string; tags?: string; pendingIssueId?: string; latestResolvedIssueId?: string; latestResolvedAt?: string };
type PriceOption = { price: string; count: number };
type ProductListData = { rows: ProductRow[]; total: number; page: number; pageSize: number; priceOptions: PriceOption[] };
type SampleRow = { id: string; code: string; arrivedAt: string; status: string; archived?: boolean; note?: string; spec?: string; departmentName?: string; locationName?: string; updatedAt: string };
type LinkHistoryRow = { id: string; url: string; replacedByUrl?: string; source: "product_edit" | "link_issue" | "intake_merge" | "recognition_correction"; sourceEntityId?: string; changedByName?: string; changedAt: string };
type ProductDetailData = { product: ProductRow & { businessContactId?: string; cooperationMechanism?: string; categoryId?: string; notes?: string; departments: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string; color: string }> }; samples: SampleRow[]; linkHistory: LinkHistoryRow[] };
type MatchCandidate = ProductRow & { archived?: boolean; similarity: number; businessContactId?: string; cooperationMechanism?: string; categoryId?: string; notes?: string; departments: Array<{ id: string; name: string }>; tags: Array<{ id: string; name: string; color: string }> };
type MatchTimings = { cacheHit?: boolean; totalMs?: number };
type MatchResult = { runId: string; status: "matched" | "no_match" | "failed"; candidates: MatchCandidate[]; message?: string; timings?: MatchTimings };

const recognitionTiming = (timings?: MatchTimings) => timings?.totalMs === undefined ? "" : `${timings.cacheHit ? "已复用图片特征 · " : ""}用时 ${timings.totalMs >= 1000 ? `${(timings.totalMs / 1000).toFixed(1)} 秒` : `${Math.round(timings.totalMs)} 毫秒`}`;

const LINK_HISTORY_SOURCE_LABELS: Record<LinkHistoryRow["source"], string> = {
  product_edit: "编辑商品",
  link_issue: "问题处理",
  intake_merge: "同款追加到样",
  recognition_correction: "同款纠正",
};

function ProductLinkHistory({ rows }: { rows: LinkHistoryRow[] }) {
  const toast = useToast();
  async function copyLink(url: string) {
    const ok = await copyToClipboard(url); if (ok) toast("历史链接已复制"); else toast("复制失败，请手动选择链接", "error");
  }
  return <section className="panel product-link-history"><header className="panel-header padded"><div><p className="eyebrow">链接追溯</p><h2>历史链接记录（{rows.length}）</h2></div><small>搜索任意历史链接仍可找到此商品，实际使用以当前商品链接为准。</small></header>{rows.length ? <div className="product-link-history-list">{rows.map((row) => <article key={row.id}><History size={17} /><div><code title={row.url}>{row.url}</code>{row.replacedByUrl && <span>更换为：<code title={row.replacedByUrl}>{row.replacedByUrl}</code></span>}<small>{LINK_HISTORY_SOURCE_LABELS[row.source]} · {row.changedByName || "系统"} · {formatDate(row.changedAt, true)}</small></div><div className="product-link-history-actions">{isWebProductLink(row.url) && <a className="icon-button" href={row.url} target="_blank" rel="noreferrer" aria-label="打开历史链接" title="打开历史链接"><ExternalLink size={16} /></a>}<button type="button" className="icon-button" onClick={() => copyLink(row.url)} aria-label="复制历史链接" title="复制历史链接"><Clipboard size={16} /></button></div></article>)}</div> : <EmptyState title="暂无历史链接" description="以后更换商品链接时，旧链接会自动记录在这里。" />}</section>;
}

function ExpandedProductSamples({ productId }: { productId: string }) {
  const { data, loading, error } = useRemote<{ samples: SampleRow[] }>(`/api/products/${productId}`);
  if (loading) return <div style={{ padding: "12px 0" }}><LoadingState /></div>;
  if (error) return <ErrorState message={error} />;
  const samples = data?.samples || [];
  if (!samples.length) return <p style={{ padding: "12px 0", color: "var(--muted)", fontSize: 13 }}>暂无实物样品</p>;
  return <div style={{ padding: "12px 0" }}><table className="data-table" style={{ fontSize: 13 }}><thead><tr><th>独立编号</th><th>规格</th><th>到样日期</th><th>状态</th><th>当前位置</th><th>最后更新</th><th /></tr></thead><tbody>{samples.map((sample) => <tr key={sample.id}><td><Link href={`/samples/${sample.code}`} className="code-link">{sample.code}</Link></td><td>{sample.spec || "—"}</td><td>{formatDate(sample.arrivedAt)}</td><td><StatusBadge status={sample.status} /></td><td><span className="table-place"><MapPin size={14} />{activeLocationLabel({ status: sample.status, department_name: sample.departmentName, location_name: sample.locationName })}</span></td><td>{formatDate(sample.updatedAt, true)}</td><td><Link className="row-link" href={`/samples/${sample.code}`}>查看流转</Link></td></tr>)}</tbody></table></div>;
}

export function ProductsView() {
  const { lookups, can, user } = useAppData(); const router = useRouter(); const toast = useToast();   const [search, setSearch] = useState(""); const [departmentId, setDepartmentId] = useState(""); const [categoryId, setCategoryId] = useState(""); const [locationId, setLocationId] = useState(""); const [prices, setPrices] = useState<string[]>([]); const [priceOrder, setPriceOrder] = useState<"" | "asc" | "desc">(""); const [page, setPage] = useState(1); const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [archiveView, setArchiveView] = useState(false); const [restoringId, setRestoringId] = useState("");
  const [reportingProduct, setReportingProduct] = useState<ProductRow | null>(null); const [reportNote, setReportNote] = useState(""); const [reporting, setReporting] = useState(false);
  const [copyConfig, setCopyConfig] = useState<ProductCopyConfig>(() => normalizeProductCopyConfig(user.productCopyConfig));
  const [copyDraft, setCopyDraft] = useState<ProductCopyConfig>(() => normalizeProductCopyConfig(user.productCopyConfig));
  const [copySettingsOpen, setCopySettingsOpen] = useState(false); const [savingCopyConfig, setSavingCopyConfig] = useState(false); const [copyingId, setCopyingId] = useState(""); const [draggingField, setDraggingField] = useState<ProductCopyFieldKey | null>(null);
  const [importOpen, setImportOpen] = useState(false); const [importing, setImporting] = useState(false); const [importResult, setImportResult] = useState<{ imported: number; total: number; failures: Array<{ row: number; message: string }> } | null>(null); const [importFile, setImportFile] = useState<File | null>(null);
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  const [imageSearchUrl, setImageSearchUrl] = useState("");
  const [imageSearching, setImageSearching] = useState(false);
  const [imageResults, setImageResults] = useState<Array<{id:string;sku:string;name:string;imageUrls:string[];price:string;storeName?:string;productUrl?:string;sampleCount:number;similarity:number}> | null>(null);
  useEffect(() => { setArchiveView(new URLSearchParams(window.location.search).get("view") === "archived"); }, []);
  const queryParams = new URLSearchParams({ search, departmentId, categoryId, page: String(page), view: archiveView ? "archived" : "active" });
  prices.forEach((price) => queryParams.append("price", price));
  if (priceOrder) queryParams.set("priceOrder", priceOrder);
  if (locationId) queryParams.set("locationId", locationId);
  const query = queryParams.toString();
  const { data, loading, error, reload } = useRemote<ProductListData>(`/api/products?${query}`);
  const autoExpandKeyRef = useRef("");
  useEffect(() => {
    if (!search.trim() || !data?.rows.length) return;
    const key = `${search}|${data.rows.map((row) => row.id).join(",")}`;
    if (key === autoExpandKeyRef.current) return;
    autoExpandKeyRef.current = key;
    setExpandedIds((ids) => Array.from(new Set([...ids, ...data.rows.map((row) => row.id)])));
  }, [search, data]);
  function toggleExpand(id: string) { setExpandedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]); }
  const priceOptions = new Map<string, PriceOption>(prices.map((price) => [price, { price, count: 0 }]));
  for (const option of data?.priceOptions || []) priceOptions.set(option.price, option);
  const availablePrices = Array.from(priceOptions.values()).sort((left, right) => Number(left.price) - Number(right.price));
  const locationGroups = useMemo(() => {
    if (!lookups?.locations?.length) return [];
    const grouped: Record<string, typeof lookups.locations> = {};
    for (const loc of lookups.locations) {
      const dept = (loc as Record<string, unknown>).departmentName as string || "未分类";
      if (!grouped[dept]) grouped[dept] = [];
      grouped[dept].push(loc);
    }
    return grouped;
  }, [lookups]);
  function switchArchiveView(nextArchived: boolean) {
    setArchiveView(nextArchived); setPage(1); setPrices([]); setPriceOrder("");
    const url = new URL(window.location.href);
    if (nextArchived) url.searchParams.set("view", "archived"); else url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }
  function togglePrice(price: string) { setPrices((values) => values.includes(price) ? values.filter((value) => value !== price) : [...values, price]); setPage(1); }
  function openCopySettings() { setCopyDraft({ order: [...copyConfig.order], enabled: [...copyConfig.enabled] }); setCopySettingsOpen(true); }
  async function submitImport(event: FormEvent) {
    event.preventDefault(); if (!importFile) return;
    setImporting(true); setImportResult(null);
    try {
      const fd = new FormData(); fd.append("file", importFile);
      const result = await apiFetch<{ imported: number; total: number; failures: Array<{ row: number; message: string }> }>("/api/import/products", { method: "POST", body: fd });
      setImportResult(result); setImportFile(null);
      if (result.imported > 0) { await reload(); window.dispatchEvent(new Event("link-issues:changed")); }
    } catch (reason) { toast(reason instanceof Error ? reason.message : "导入失败", "error"); }
    finally { setImporting(false); }
  }
  async function downloadTemplate() {
    try {
      const response = await fetch("/api/import/template");
      if (!response.ok) throw new Error("模板下载失败");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "狐掌柜商品导入模板.xlsx"; a.click();
      URL.revokeObjectURL(url);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "下载失败", "error"); }
  }
  async function searchByImage(event: FormEvent) {
    event.preventDefault();
    if (!imageSearchUrl.trim()) return;
    setImageSearching(true); setImageResults(null);
    try {
      const result = await apiFetch<{ candidates: Array<{id:string;sku:string;name:string;imageUrls:string[];price:string;storeName?:string;productUrl?:string;sampleCount:number;similarity:number}> }>("/api/image-search", { method: "POST", body: JSON.stringify({ imageUrl: imageSearchUrl.trim() }) });
      setImageResults(result.candidates);
      if (!result.candidates.length) toast("未找到相似商品");
    } catch (reason) { toast(reason instanceof Error ? reason.message : "搜索失败", "error"); }
    finally { setImageSearching(false); }
  }
  function closeImport() { setImportOpen(false); setImportFile(null); setImportResult(null); }
  function addCopyField(key: ProductCopyFieldKey) {
    setCopyDraft((config) => ({ order: [...config.order.filter((field) => field !== key), key], enabled: [...config.enabled, key] }));
  }
  function removeCopyField(key: ProductCopyFieldKey) {
    setCopyDraft((config) => ({ ...config, enabled: config.enabled.filter((field) => field !== key) }));
  }
  function reorderCopyField(source: ProductCopyFieldKey, target: ProductCopyFieldKey) {
    if (source === target) return;
    setCopyDraft((config) => {
      const selected = config.order.filter((field) => config.enabled.includes(field) && field !== source); const targetIndex = selected.indexOf(target);
      selected.splice(targetIndex < 0 ? selected.length : targetIndex, 0, source);
      const available = config.order.filter((field) => !config.enabled.includes(field));
      return { ...config, order: [...selected, ...available] };
    });
  }
  function moveCopyField(key: ProductCopyFieldKey, direction: -1 | 1) {
    setCopyDraft((config) => {
      const selected = config.order.filter((field) => config.enabled.includes(field)); const index = selected.indexOf(key); const next = index + direction;
      if (index < 0 || next < 0 || next >= selected.length) return config;
      [selected[index], selected[next]] = [selected[next], selected[index]];
      const available = config.order.filter((field) => !config.enabled.includes(field));
      return { ...config, order: [...selected, ...available] };
    });
  }
  async function saveCopyConfig() {
    if (!copyDraft.enabled.length) { toast("请至少选择一个复制字段", "error"); return; }
    setSavingCopyConfig(true);
    try {
      const saved = await apiFetch<ProductCopyConfig>("/api/auth/product-copy", { method: "PATCH", body: JSON.stringify(copyDraft) });
      setCopyConfig(saved); setCopySettingsOpen(false); toast("一键复制配置已保存");
    } catch (reason) { toast(reason instanceof Error ? reason.message : "复制配置保存失败", "error"); }
    finally { setSavingCopyConfig(false); }
  }
  async function copyProduct(product: ProductRow) {
    setCopyingId(product.id);
    try {
      const fieldCount = await copyProductToClipboard(product, copyConfig, formatDate);
      toast(`已复制 ${fieldCount} 项商品信息，可直接粘贴到表格`);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "复制失败", "error"); }
    finally { setCopyingId(""); }
  }
  function issueUrl(product: ProductRow, issueId: string) { return `/link-issues?search=${encodeURIComponent(product.sku)}&focus=${encodeURIComponent(issueId)}`; }
  function openIssue(product: ProductRow) {
    const existingId = product.pendingIssueId || product.latestResolvedIssueId;
    if (existingId) { router.push(issueUrl(product, existingId)); return; }
    setReportNote(""); setReportingProduct(product);
  }
  async function submitIssue(event: FormEvent) {
    event.preventDefault(); if (!reportingProduct) return; setReporting(true);
    try {
      const result = await apiFetch<{ id: string; existing: boolean }>("/api/link-issues", { method: "POST", body: JSON.stringify({ productId: reportingProduct.id, note: reportNote }) });
      toast(result.existing ? "该商品已有待处理问题，已为你打开" : "链接报障已提交");
      window.dispatchEvent(new Event("link-issues:changed")); setReportingProduct(null); setReportNote(""); await reload(); router.push(issueUrl(reportingProduct, result.id));
    } catch (reason) { toast(reason instanceof Error ? reason.message : "报障提交失败", "error"); } finally { setReporting(false); }
  }
  async function restoreProduct(product: ProductRow) {
    if (!confirm(`确定恢复商品“${product.name}”吗？随商品归档的样品也会一起恢复。`)) return;
    setRestoringId(product.id);
    try {
      const result = await apiFetch<{ sampleCount: number }>(`/api/products/${product.id}/restore`, { method: "POST" });
      toast(`商品已恢复，同时恢复 ${result.sampleCount} 件样品`); await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "恢复失败", "error"); }
    finally { setRestoringId(""); }
  }
  if (archiveView) return <>
    <PageHeader eyebrow="商品档案" title="已归档商品" description="归档内容会完整保留，可查看档案或恢复继续使用。" actions={can("products:create") ? <Link className="button button-primary" href="/products/new"><PackagePlus size={18} />登记新商品</Link> : undefined} />
    <nav className="archive-view-switch" aria-label="商品档案范围">
      <button type="button" onClick={() => switchArchiveView(false)}><Boxes size={17} />在用商品</button>
      <button type="button" className="active" onClick={() => switchArchiveView(true)}><Archive size={17} />已归档</button>
    </nav>
    <section className="toolbar">
      <div className="search-box"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索已归档商品的货号、序号、名称、店铺或链接" /></div>
      <div className="toolbar-filters">
        <div className="select-wrap"><Filter size={16} /><select value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }}><option value="">全部选品部门</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
        <select value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}><option value="">全部分类</option>{lookups?.categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
        <select value={locationId} onChange={(event) => { setLocationId(event.target.value); setPage(1); }}><option value="">全部存放位置</option>{Object.entries(locationGroups).map(([dept, locs]) => <optgroup key={dept} label={dept}>{locs.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>)}</select>
      </div>
    </section>
    <section className="panel table-panel archived-products-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.rows.length ? <EmptyState title="没有已归档商品" description={search || departmentId || categoryId || locationId ? "没有符合当前筛选条件的归档记录。" : "归档的商品会集中显示在这里。"} /> : <>
        <div className="data-table-wrap"><table className="data-table product-table"><thead><tr><th>商品</th><th>选品部门</th><th>商务信息</th><th>价格</th><th>佣金</th><th>归档样品</th><th>归档时间</th><th /></tr></thead><tbody>{data.rows.map((product) => <Fragment key={product.id}><tr className="archived-product-row">
          <td><div style={{ display: "flex", gap: 6, alignItems: "center" }}><button type="button" className="icon-button" style={{ flexShrink: 0, width: 26, height: 26 }} onClick={() => toggleExpand(product.id)} aria-label="展开样品位置" title="展开样品位置">{expandedIds.includes(product.id) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button><Link href={"/products/" + product.id} className="table-product"><ProductImage urls={product.imageUrls} alt={product.name} size="small" /><div><b>{product.name}</b><span>{product.sku} {product.categoryName && "· " + product.categoryName}</span>{product.tags && <small>{product.tags}</small>}</div></Link></div></td>
          <td><span className="table-departments">{product.selectedDepartments || "—"}</span></td>
          <td><div className="stacked-cell"><span>{product.storeName || "未填店铺"}</span><small>{product.businessContactName || "未指定对接人"}</small></div></td>
          <td><b className="money-cell">{product.price ? "¥" + product.price : "—"}</b></td>
          <td><b className="commission-cell">{product.commission ? formatCommission(product.commission) : "—"}</b></td>
          <td><b className="quantity-number">{product.sampleCount}</b><small className="quantity-sub">件历史样品</small></td>
          <td>{formatDate(product.updatedAt || product.createdAt, true)}</td>
          <td><div className="table-actions"><Link className="row-link" href={"/products/" + product.id}>查看</Link>{can("products:archive") && <button type="button" className="button button-compact button-secondary restore-button" disabled={restoringId === product.id} onClick={() => restoreProduct(product)}><RefreshCw size={15} />{restoringId === product.id ? "恢复中" : "恢复商品"}</button>}</div></td>
        </tr>{expandedIds.includes(product.id) && <tr className="expand-row"><td colSpan={8} style={{ padding: "0 14px" }}><ExpandedProductSamples productId={product.id} /></td></tr>}</Fragment>)}</tbody></table></div>
        <div className="mobile-record-list">{data.rows.map((product) => <div className="mobile-record product-mobile-record archived-product-row" key={product.id}><Link href={"/products/" + product.id}><ProductImage urls={product.imageUrls} alt={product.name} size="medium" /><div className="mobile-record-main"><div><span className="sku-chip">{product.sku}</span><b>{product.name}</b></div><p>{product.selectedDepartments || "未指定直播间"}</p><small>{product.sampleCount} 件历史样品 · 归档于 {formatDate(product.updatedAt)}</small></div></Link>{can("products:archive") && <button type="button" className="icon-button restore-mobile-button" aria-label="恢复商品" disabled={restoringId === product.id} onClick={() => restoreProduct(product)}><RefreshCw size={18} /></button>}</div>)}</div>
        <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
      </>}
    </section>
  </>;
  return <>
    <PageHeader eyebrow="商品档案" title={archiveView ? "已归档商品" : "所有商品款式"} description={archiveView ? "归档内容会完整保留，可查看档案或恢复继续使用。" : "一个基础货号对应一个款式，每件实物在基础货号后追加独立序号。"} actions={<>{!archiveView && <button className="button button-secondary" type="button" onClick={openCopySettings}><Settings2 size={17} />复制设置</button>}{!archiveView && can("products:export") && <Link className="button button-secondary" href="/api/export?type=products"><Download size={17} />导出 Excel</Link>}{can("products:create") && <button className="button button-secondary" onClick={() => { setImportFile(null); setImportResult(null); setImportOpen(true); }}><Upload size={17} />批量导入</button>}{can("products:create") && <Link className="button button-primary" href="/products/new"><PackagePlus size={18} />登记新商品</Link>}</>} />
    <nav className="archive-view-switch" aria-label="商品档案范围"><button type="button" className={!archiveView ? "active" : ""} onClick={() => switchArchiveView(false)}><Boxes size={17} />在用商品</button><button type="button" className={archiveView ? "active" : ""} onClick={() => switchArchiveView(true)}><Archive size={17} />已归档</button></nav>
    <section className="toolbar"><button type="button" className={`button button-compact ${imageSearchOpen ? "button-primary" : "button-ghost"}`} onClick={() => { setImageSearchOpen(!imageSearchOpen); setImageResults(null); setImageSearchUrl(""); }}><Image size={16} />以图搜商品</button><div className="search-box"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索货号、序号、商品名、店铺或链接" /></div><div className="toolbar-filters"><div className="select-wrap"><Filter size={16} /><select value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }}><option value="">全部选品部门</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><select value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}><option value="">全部分类</option>{lookups?.categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><select value={locationId} onChange={(event) => { setLocationId(event.target.value); setPage(1); }}><option value="">全部存放位置</option>{Object.entries(locationGroups).map(([dept, locs]) => <optgroup key={dept} label={dept}>{locs.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</optgroup>)}</select><details className="price-filter"><summary><ArrowDownUp size={16} /><span>{prices.length ? `已选 ${prices.length} 个价格` : "价格筛选"}</span><ChevronDown size={15} /></summary><div className="price-filter-menu"><header><div><b>商品价格</b><small>勾选已有价格，可同时选择多个</small></div>{(prices.length > 0 || priceOrder) && <button type="button" onClick={() => { setPrices([]); setPriceOrder(""); setPage(1); }}>清空</button>}</header><div className="price-sort"><span>排序</span><button type="button" className={!priceOrder ? "selected" : ""} onClick={() => { setPriceOrder(""); setPage(1); }}>默认</button><button type="button" className={priceOrder === "asc" ? "selected" : ""} onClick={() => { setPriceOrder("asc"); setPage(1); }}>从低到高</button><button type="button" className={priceOrder === "desc" ? "selected" : ""} onClick={() => { setPriceOrder("desc"); setPage(1); }}>从高到低</button></div><div className="price-option-list">{availablePrices.length ? availablePrices.map((option) => <label className={prices.includes(option.price) ? "selected" : ""} key={option.price}><input type="checkbox" checked={prices.includes(option.price)} onChange={() => togglePrice(option.price)} /><span>¥{option.price}</span><small>{option.count} 件商品</small></label>) : <p>暂无已填写的商品价格</p>}</div></div></details></div></section>
    {imageSearchOpen && <section className="panel image-search-panel">
  <form onSubmit={searchByImage} style={{display:"flex",gap:"8px",alignItems:"center"}}>
    <div className="search-box" style={{flex:1}}><Search size={18} /><input value={imageSearchUrl} onChange={(e) => setImageSearchUrl(e.target.value)} placeholder="粘贴商品图片的公开URL，搜索相似商品…" /></div>
    <button className="button button-primary" disabled={imageSearching || !imageSearchUrl.trim()}>{imageSearching ? "搜索中…" : "搜索"}</button>
  </form>
  {imageResults && <div style={{marginTop:"12px"}}>
    {imageResults.length === 0 ? <EmptyState title="未找到相似商品" description="可以尝试换一张更清晰的图片。" /> : <div style={{display:"grid",gap:"8px"}}>
      {imageResults.map((p) => <Link key={p.id} href={`/products/${p.id}`} className="image-search-result" style={{display:"flex",alignItems:"center",gap:"12px",padding:"10px 12px",borderRadius:"10px",border:"1px solid var(--line-soft)",background:"var(--paper-strong)",textDecoration:"none",color:"inherit"}}>
        <ProductImage urls={p.imageUrls} alt={p.name} size="small" />
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:"8px"}}><span className="sku-chip">{p.sku}</span><b style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.name}</b></div>
          <div style={{fontSize:"11px",color:"var(--muted)",marginTop:"2px"}}>{p.storeName || ""}{p.price ? ` · ¥${p.price}` : ""} · {p.sampleCount} 件样品</div>
        </div>
        <span className="similarity-chip" style={{flexShrink:0}}>{p.similarity}%</span>
      </Link>)}
    </div>}
  </div>}
</section>}
    <section className="panel table-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.rows.length ? <EmptyState title="没有找到商品" description={search || prices.length || locationId ? "试试更换筛选条件。" : "登记第一款商品后会显示在这里。"} action={can("products:create") ? <Link href="/products/new" className="button button-primary">登记商品</Link> : undefined} /> : <><div className="data-table-wrap"><table className="data-table product-table"><thead><tr><th>商品</th><th>选品部门</th><th>商务信息</th><th>价格</th><th>佣金</th><th>实物数量</th><th>最近更新</th><th /></tr></thead><tbody>{data.rows.map((product) => <Fragment key={product.id}><tr><td><div style={{ display: "flex", gap: 6, alignItems: "center" }}><button type="button" className="icon-button" style={{ flexShrink: 0, width: 26, height: 26 }} onClick={() => toggleExpand(product.id)} aria-label="展开样品位置" title="展开样品位置">{expandedIds.includes(product.id) ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button><Link href={`/products/${product.id}`} className="table-product"><ProductImage urls={product.imageUrls} alt={product.name} size="small" /><div><b>{product.name}</b><span>{product.sku} {product.categoryName && `· ${product.categoryName}`}</span>{product.tags && <small>{product.tags}</small>}</div></Link></div></td><td><span className="table-departments">{product.selectedDepartments || "—"}</span></td><td><div className="stacked-cell"><span>{product.storeName || "未填店铺"}</span><small>{product.businessContactName || "未指定对接人"}</small></div></td><td><b className="money-cell">{product.price ? `¥${product.price}` : "—"}</b></td><td><b className="commission-cell">{product.commission ? formatCommission(product.commission) : "—"}</b></td><td><b className="quantity-number">{product.sampleCount}</b><small className="quantity-sub">{product.activeCount} 件在库/在用</small></td><td>{formatDate(product.updatedAt || product.createdAt)}</td><td><div className="table-actions"><button type="button" className="button button-compact button-secondary" disabled={copyingId === product.id} onClick={() => copyProduct(product)}><Clipboard size={15} />{copyingId === product.id ? "复制中" : "一键复制"}</button><Link className="row-link" href={`/products/${product.id}`}>查看</Link><button type="button" className={`button button-compact ${product.pendingIssueId ? "button-warning" : "button-secondary"}`} onClick={() => openIssue(product)}><CircleAlert size={15} />{product.pendingIssueId ? "查看报障" : product.latestResolvedIssueId ? "历史报障" : "链接报障"}</button>{product.productUrl && <button type="button" className="button button-compact button-secondary" onClick={async () => { const ok = await copyToClipboard(product.productUrl || ""); if (ok) toast("链接已复制"); else toast("复制失败", "error"); }}><Link2 size={15} />复制链接</button>}</div></td></tr>{expandedIds.includes(product.id) && <tr className="expand-row"><td colSpan={8} style={{ padding: "0 14px" }}><ExpandedProductSamples productId={product.id} /></td></tr>}</Fragment>)}</tbody></table></div><div className="mobile-record-list">{data.rows.map((product) => <div className="mobile-record product-mobile-record" key={product.id}><Link href={`/products/${product.id}`}><ProductImage urls={product.imageUrls} alt={product.name} size="medium" /><div className="mobile-record-main"><div><span className="sku-chip">{product.sku}</span><b>{product.name}</b></div><p>{product.selectedDepartments || "未指定直播间"}</p><small>{product.price ? `¥${product.price} · ` : ""}{product.commission ? `${formatCommission(product.commission)} · ` : ""}{product.sampleCount} 件样品 · {formatDate(product.updatedAt)}</small></div></Link><div className="product-mobile-actions"><button type="button" className="icon-button" aria-label={`复制 ${product.name}`} disabled={copyingId === product.id} onClick={() => copyProduct(product)}><Clipboard size={18} /></button><button type="button" className={`icon-button issue-mobile-button ${product.pendingIssueId ? "has-pending" : ""}`} aria-label={product.pendingIssueId ? "查看待处理报障" : product.latestResolvedIssueId ? "查看历史报障" : "链接报障"} onClick={() => openIssue(product)}><CircleAlert size={19} /></button>{product.productUrl && <button type="button" className="icon-button" aria-label="复制链接" onClick={async () => { const ok = await copyToClipboard(product.productUrl || ""); if (ok) toast("链接已复制"); else toast("复制失败", "error"); }}><Link2 size={18} /></button>}</div></div>)}</div><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} /></>}
    </section>
    {reportingProduct && <Modal title="链接报障" onClose={() => { if (!reporting) setReportingProduct(null); }}><form className="modal-form" onSubmit={submitIssue}><div className="issue-product-summary"><ProductImage urls={reportingProduct.imageUrls} alt={reportingProduct.name} size="small" /><div><b>{reportingProduct.name}</b><span>{reportingProduct.sku} · {reportingProduct.storeName || "未填店铺"}</span></div></div><Field label="问题备注" required hint="请说明链接失效、商品下架或其他需要商务核实的情况。"><textarea rows={5} required maxLength={2000} value={reportNote} onChange={(event) => setReportNote(event.target.value)} placeholder="例如：直播间点击后显示商品已下架，请提供可用的新链接。" /></Field><div className="modal-actions"><button type="button" className="button button-ghost" disabled={reporting} onClick={() => setReportingProduct(null)}>取消</button><button className="button button-primary" disabled={reporting || !reportNote.trim()}>{reporting ? "正在提交…" : "提交报障"}</button></div></form></Modal>}
    {copySettingsOpen && <Modal title="设置一键复制内容" onClose={() => { if (!savingCopyConfig) setCopySettingsOpen(false); }} wide><div className="copy-settings">{(() => { const selectedKeys = copyDraft.order.filter((key) => copyDraft.enabled.includes(key)); const availableFields = PRODUCT_COPY_FIELDS.filter((field) => !copyDraft.enabled.includes(field.key)); return <><div className="copy-order-preview"><div className="copy-preview-title"><b>粘贴后的单元格顺序</b><span>从左到右，共 {selectedKeys.length} 列</span></div>{selectedKeys.length ? <div className="copy-preview-flow">{selectedKeys.map((key, index) => { const field = PRODUCT_COPY_FIELDS.find((item) => item.key === key); return <span className="copy-preview-step" key={key}><i>{index + 1}</i>{field?.label}{index < selectedKeys.length - 1 && <b>→</b>}</span>; })}</div> : <p className="copy-empty-preview">尚未选择内容，请从下方添加。</p>}</div><section className="copy-config-section"><header className="copy-section-head"><div><b>已选内容和顺序</b><p>最上面的内容会粘贴到第 1 列。拖动卡片或点击箭头可以调整顺序。</p></div></header><div className="copy-selected-list">{selectedKeys.map((key, index) => { const field = PRODUCT_COPY_FIELDS.find((item) => item.key === key); if (!field) return null; return <div className={`copy-selected-item ${draggingField === key ? "dragging" : ""}`} draggable onDragStart={() => setDraggingField(key)} onDragEnd={() => setDraggingField(null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (draggingField) reorderCopyField(draggingField, key); setDraggingField(null); }} key={key}><GripVertical className="copy-drag-handle" size={20} /><span className="copy-order-number">{index + 1}</span><div className="copy-selected-copy"><b>{field.label}</b><small>粘贴到第 {index + 1} 列</small></div><div className="copy-item-actions"><button type="button" className="icon-button" disabled={index === 0} onClick={() => moveCopyField(key, -1)} aria-label={`上移${field.label}`} title="上移一列"><ChevronUp size={17} /></button><button type="button" className="icon-button" disabled={index === selectedKeys.length - 1} onClick={() => moveCopyField(key, 1)} aria-label={`下移${field.label}`} title="下移一列"><ChevronDown size={17} /></button><button type="button" className="icon-button danger" onClick={() => removeCopyField(key)} aria-label={`移除${field.label}`} title="不再复制此项"><X size={17} /></button></div></div>; })}</div></section><section className="copy-config-section"><header className="copy-section-head"><div><b>添加其他内容</b><p>点击后会添加到复制顺序的最后一列。</p></div><span>{availableFields.length} 项可添加</span></header>{availableFields.length ? <div className="copy-available-grid">{availableFields.map((field) => <button type="button" className="copy-add-field" onClick={() => addCopyField(field.key)} key={field.key}><Plus size={16} /><span>{field.label}</span></button>)}</div> : <div className="copy-all-selected">所有内容都已添加</div>}</section><div className="modal-actions"><span className="copy-selected-count">将复制 {selectedKeys.length} 项内容</span><button type="button" className="button button-ghost" disabled={savingCopyConfig} onClick={() => setCopySettingsOpen(false)}>取消</button><button type="button" className="button button-primary" disabled={savingCopyConfig || !selectedKeys.length} onClick={saveCopyConfig}>{savingCopyConfig ? "保存中…" : "保存设置"}</button></div></>; })()}</div></Modal>}
    {importOpen && <Modal title="批量导入商品" onClose={closeImport} wide>
      {importResult ? <div><div className="recognition-status phase-ready"><CheckCircle2 size={20} /><div><b>导入完成</b><span>成功 {importResult.imported} 件，跳过 {importResult.failures.length} 行</span></div></div>{importResult.failures.length > 0 && <div style={{marginTop:"12px",maxHeight:"320px",overflow:"auto",display:"grid",gap:"6px"}}>{importResult.failures.map((f, i) => <div key={i} style={{padding:"8px 10px",borderRadius:"8px",background:"#fff5f2",fontSize:"12px"}}><b>第 {f.row} 行</b>：{f.message}</div>)}</div>}</div> : <form className="modal-form" onSubmit={submitImport}><Field label="下载模板" hint="按模板填写商品信息，分类和部门等下拉列请从参考数据中选择。"><button type="button" className="button button-secondary" onClick={downloadTemplate}><Download size={17} />下载 Excel 导入模板</button></Field><Field label="上传文件"><div className="input-prefix"><FileSpreadsheet size={17} /><input type="file" accept=".xlsx" onChange={(event) => setImportFile(event.target.files?.[0] || null)} /></div></Field><div className="modal-actions"><button type="button" className="button button-ghost" onClick={closeImport}>取消</button><button className="button button-primary" disabled={importing || !importFile}>{importing ? "正在导入…" : "开始导入"}</button></div></form>}
    </Modal>}
  </>;
}

type ProductFormState = { sku: string; name: string; departmentIds: string[]; businessContactId: string; storeName: string; price: string; productUrl: string; commission: string; storeRating: string; supplyChain: string; cooperationMechanism: string; categoryId: string; tagIds: string[]; imageUrls: string; notes: string; quantity: string; arrivedAt: string; initialDepartmentId: string; initialLocationId: string; spec?: string };
const today = () => { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 10); };
const blankForm = (): ProductFormState => ({ sku: "", name: "", departmentIds: [], businessContactId: "", storeName: "", price: "", productUrl: "", commission: "", storeRating: "", supplyChain: "", cooperationMechanism: "", categoryId: "", tagIds: [], imageUrls: "", notes: "", quantity: "1", arrivedAt: today(), initialDepartmentId: "", initialLocationId: "", spec: "" });
type ProductDraft = { version: 1; form: ProductFormState; savedAt: number; autoRestore?: boolean };
const PRODUCT_DRAFT_LIFETIME = 7 * 24 * 60 * 60 * 1000;

export function ProductFormView({ id }: { id?: string }) {
  const { user, lookups } = useAppData(); const router = useRouter(); const toast = useToast(); const [form, setForm] = useState<ProductFormState>(blankForm); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const draftKey = `huzhanggui:product-draft:${user.id}`; const [draftReady, setDraftReady] = useState(Boolean(id)); const [draftCandidate, setDraftCandidate] = useState<ProductDraft | null>(null); const [draftTouched, setDraftTouched] = useState(false); const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const [checkedUrls, setCheckedUrls] = useState<string[]>([]); const [excludedProducts, setExcludedProducts] = useState<string[]>([]);
  const [recognition, setRecognition] = useState<{ phase: "waiting" | "checking" | "ready" | "failed"; runId: string; runUrl: string; decision: "" | "matched" | "new" | "failed_continue"; matchedProductId: string; message: string; timingText: string }>({ phase: id ? "ready" : "waiting", runId: "", runUrl: "", decision: "", matchedProductId: "", message: "", timingText: "" });
  const [confirmedMatch, setConfirmedMatch] = useState<{ runId: string; runUrl: string; productId: string; sku: string } | null>(null);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]); const [recognizingUrl, setRecognizingUrl] = useState("");
  const detail = useRemote<ProductDetailData>(id ? `/api/products/${id}` : null);
  useEffect(() => {
    if (id) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) { setDraftReady(true); return; }
      const draft = JSON.parse(raw) as ProductDraft;
      const valid = draft?.version === 1 && typeof draft.savedAt === "number" && Date.now() - draft.savedAt < PRODUCT_DRAFT_LIFETIME
        && draft.form && typeof draft.form.imageUrls === "string" && Array.isArray(draft.form.departmentIds) && Array.isArray(draft.form.tagIds);
      if (valid) {
        if (draft.autoRestore) {
          setForm({ ...blankForm(), ...draft.form, departmentIds: draft.form.departmentIds || [], tagIds: draft.form.tagIds || [] });
          setCheckedUrls([]); setExcludedProducts([]); setConfirmedMatch(null); setCandidates([]); setRecognizingUrl("");
          setRecognition({ phase: "waiting", runId: "", runUrl: "", decision: "", matchedProductId: "", message: "", timingText: "" });
          setDraftSavedAt(draft.savedAt); setDraftTouched(true); setDraftReady(true);
        } else {
          setDraftCandidate(draft);
        }
      }
      else { localStorage.removeItem(draftKey); setDraftReady(true); }
    } catch {
      localStorage.removeItem(draftKey); setDraftReady(true);
    }
  }, [draftKey, id]);
  useEffect(() => {
    if (id || !draftReady || !draftTouched) return;
    const savedAt = Date.now();
    localStorage.setItem(draftKey, JSON.stringify({ version: 1, form, savedAt } satisfies ProductDraft));
    setDraftSavedAt(savedAt);
  }, [draftKey, draftReady, draftTouched, form, id]);
  useEffect(() => { if (!id && lookups && !form.initialDepartmentId) { const business = lookups.departments.find((item) => item.kind === "business"); if (business) setForm((current) => ({ ...current, initialDepartmentId: business.id })); } }, [id, lookups, form.initialDepartmentId]);
  useEffect(() => { if (!id && user && !form.businessContactId) { setForm((current) => ({ ...current, businessContactId: user.id })); } }, [id, user, form.businessContactId]);
  useEffect(() => { if (id && detail.data) { const p = detail.data.product; setForm({ sku: p.sku, name: p.name, departmentIds: p.departments.map((item) => item.id), businessContactId: p.businessContactId || "", storeName: p.storeName || "", price: p.price || "", productUrl: p.productUrl || "", commission: p.commission || "", storeRating: p.storeRating || "", supplyChain: p.supplyChain || "", cooperationMechanism: p.cooperationMechanism || "", categoryId: p.categoryId || "", tagIds: p.tags.map((item) => item.id), imageUrls: (p.imageUrls || []).join("\n"), notes: p.notes || "", quantity: "1", arrivedAt: today(), initialDepartmentId: "", initialLocationId: "" }); } }, [id, detail.data]);
  const set = (key: keyof ProductFormState, value: string | string[]) => { setDraftTouched(true); setForm((current) => ({ ...current, [key]: value })); };
  const imageUrls = form.imageUrls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const primaryImageUrl = imageUrls.find((url) => { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } }) || "";
  const locations = lookups?.locations.filter((item) => item.departmentId === form.initialDepartmentId) || [];
  useEffect(() => {
    if (id || recognition.decision === "matched" || !recognition.runUrl || primaryImageUrl === recognition.runUrl || recognition.phase === "checking") return;
    setCheckedUrls([]); setCandidates([]); setExcludedProducts([]);
    setRecognition((value) => ({ ...value, phase: "waiting", runId: "", runUrl: "", decision: "", matchedProductId: "", message: "主图已变更，请重新识别", timingText: "" }));
  }, [id, primaryImageUrl, recognition.decision, recognition.phase, recognition.runUrl]);
  useEffect(() => {
    if (id || recognition.phase === "checking" || candidates.length) return;
    const nextUrl = primaryImageUrl && !checkedUrls.includes(primaryImageUrl) ? primaryImageUrl : "";
    if (!nextUrl) return;
    const timer = window.setTimeout(async () => {
      setRecognition((value) => ({ ...value, phase: "checking", message: "", timingText: "" })); setRecognizingUrl(nextUrl);
      try {
        const result = await apiFetch<MatchResult>("/api/image-matching", { method: "POST", body: JSON.stringify({ imageUrl: nextUrl, excludeProductIds: excludedProducts }) });
        const timingText = recognitionTiming(result.timings);
        setCheckedUrls((value) => [...new Set([...value, nextUrl])]);
        if (result.status === "matched") { setCandidates(result.candidates); setRecognition((value) => ({ ...value, phase: "ready", runId: result.runId, runUrl: nextUrl, message: "", timingText })); }
        else if (result.status === "failed") setRecognition((value) => ({ ...value, phase: "failed", runId: result.runId, runUrl: nextUrl, decision: "", message: result.message || "图片识别失败", timingText }));
        else if (confirmedMatch) setRecognition((value) => ({ ...value, phase: "ready", runId: confirmedMatch.runId, runUrl: confirmedMatch.runUrl, decision: "matched", matchedProductId: confirmedMatch.productId, message: `主图未发现其他疑似款，仍沿用 ${confirmedMatch.sku}`, timingText }));
        else setRecognition((value) => ({ ...value, phase: "ready", runId: result.runId, runUrl: nextUrl, decision: "new", matchedProductId: "", message: "主图未发现疑似同款", timingText }));
      } catch (reason) { setRecognition((value) => ({ ...value, phase: "failed", message: reason instanceof Error ? reason.message : "图片识别失败" })); }
      finally { setRecognizingUrl(""); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [id, primaryImageUrl, checkedUrls, recognition.phase, candidates.length, excludedProducts, confirmedMatch]);
  function chooseCandidate(candidate: MatchCandidate) {
    setDraftTouched(true);
    const mergedImages = Array.from(new Set([...(candidate.imageUrls || []), ...imageUrls]));
    setForm((current) => ({ ...current, sku: candidate.sku, name: candidate.name, departmentIds: candidate.departments.map((item) => item.id), businessContactId: candidate.businessContactId || "", storeName: candidate.storeName || "", price: candidate.price || "", productUrl: candidate.productUrl || "", commission: candidate.commission || "", storeRating: candidate.storeRating || "", supplyChain: candidate.supplyChain || "", cooperationMechanism: candidate.cooperationMechanism || "", categoryId: candidate.categoryId || "", tagIds: candidate.tags.map((item) => item.id), imageUrls: mergedImages.join("\n"), notes: candidate.notes || "" }));
    setCheckedUrls((value) => [...new Set([...value, ...(candidate.imageUrls || [])])]); setExcludedProducts((value) => [...new Set([...value, candidate.id])]); setCandidates([]);
    setConfirmedMatch({ runId: recognition.runId, runUrl: recognition.runUrl, productId: candidate.id, sku: candidate.sku });
    setRecognition((value) => ({ ...value, phase: "ready", decision: "matched", matchedProductId: candidate.id, message: `已确认与 ${candidate.sku} 为同款，本次将沿用该货号` }));
    void apiFetch("/api/image-matching", { method: "PATCH", body: JSON.stringify({ runId: recognition.runId, decision: "matched", selectedProductId: candidate.id }) }).catch(() => undefined);
  }
  function rejectCandidates() { setExcludedProducts((value) => [...new Set([...value, ...candidates.map((item) => item.id)])]); setCandidates([]); setRecognition((value) => confirmedMatch ? ({ ...value, phase: "ready", runId: confirmedMatch.runId, runUrl: confirmedMatch.runUrl, decision: "matched", matchedProductId: confirmedMatch.productId, message: `新增图片的候选均已排除，仍沿用 ${confirmedMatch.sku}` }) : ({ ...value, phase: "ready", decision: "new", matchedProductId: "", message: "已确认都不是同款，将自动生成新货号" })); void apiFetch("/api/image-matching", { method: "PATCH", body: JSON.stringify({ runId: recognition.runId, decision: "new" }) }).catch(() => undefined); }
  function continueDraft() {
    if (!draftCandidate) return;
    setForm({ ...blankForm(), ...draftCandidate.form, departmentIds: draftCandidate.form.departmentIds || [], tagIds: draftCandidate.form.tagIds || [] });
    setCheckedUrls([]); setExcludedProducts([]); setConfirmedMatch(null); setCandidates([]); setRecognizingUrl("");
    setRecognition({ phase: "waiting", runId: "", runUrl: "", decision: "", matchedProductId: "", message: "草稿已恢复，正在重新核验主图", timingText: "" });
    setDraftSavedAt(draftCandidate.savedAt); setDraftTouched(true); setDraftCandidate(null); setDraftReady(true);
  }
  function discardDraft() {
    localStorage.removeItem(draftKey); setDraftCandidate(null); setDraftSavedAt(null); setDraftTouched(false); setDraftReady(true);
  }
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); setError(""); try { const payload = { ...form, price: form.price || null, storeRating: form.storeRating || null, businessContactId: form.businessContactId || null, categoryId: form.categoryId || null, productUrl: form.productUrl || "", imageUrls, initialLocationId: form.initialLocationId || null, initialSampleSpec: form.spec || null }; if (id) { const { quantity, arrivedAt, initialDepartmentId, initialLocationId, spec, sku, ...update } = payload; void quantity; void arrivedAt; void initialDepartmentId; void initialLocationId; void spec; void sku; await apiFetch(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify(update) }); toast("商品信息已保存"); router.push(`/products/${id}`); } else { if (!recognition.runId || !recognition.decision) throw new Error("请先完成图片识别"); const result = await apiFetch<{ id: string; matched?: boolean; sku: string }>("/api/products", { method: "POST", body: JSON.stringify({ ...payload, matchRunId: recognition.runId, matchDecision: recognition.decision, matchedProductId: recognition.matchedProductId || null }) }); localStorage.removeItem(draftKey); setDraftReady(false); toast(result.matched ? `已按同款 ${result.sku} 追加 ${form.quantity} 件样品` : `新商品 ${result.sku} 登记成功`); const returnUrl = new URLSearchParams(window.location.search).get("returnUrl"); if (returnUrl) { router.push(returnUrl); } else { router.push(`/products/${result.id}`); } } } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); window.scrollTo({ top: 0, behavior: "smooth" }); } finally { setSaving(false); } }
  if (id && detail.loading) return <LoadingState />;
  return <form onSubmit={submit}>
    <PageHeader eyebrow={id ? "编辑档案" : "到样登记"} title={id ? "修改商品信息" : "登记新商品与实物样品"} description={id ? "货号不可修改，其他字段的每次修改都会保留操作记录。" : "填写主图后会自动识别同款；识别期间可以继续填写其他资料。"} actions={<><button type="button" className="button button-ghost" onClick={() => router.back()}><ArrowLeft size={17} />返回</button>{id && <button className="button button-primary" disabled={saving}>{saving ? "正在保存…" : "保存修改"}</button>}</>} />
    {!id && draftReady && <div className="draft-save-state"><CheckCircle2 size={17} /><span>{draftSavedAt ? `草稿已自动保存 · ${formatDate(new Date(draftSavedAt), true)}` : "填写内容会自动保存 7 天，可放心切换到其他页面"}</span><small>仅保存在当前账号的这个浏览器中</small></div>}
    {error && <div className="form-error page-form-error">{error}</div>}
    <section className="panel form-section image-first-card"><header><span className="section-number">01</span><div><h2>先填写商品图片</h2><p>每行一个外部图片网址，系统不保存原图。第一张有效图片作为主图即时识别，其余图片在保存后由后台建立索引。</p></div></header><div className="image-url-layout"><Field label="图片网址" required hint="支持多张；调整第一张图片会重新识别。确认同款后会保留旧图片并合并新图片。"><textarea rows={5} value={form.imageUrls} onChange={(event) => set("imageUrls", event.target.value)} placeholder={"https://example.com/image-1.jpg\nhttps://example.com/image-2.jpg"} /></Field><div className="image-preview-grid">{imageUrls.length ? imageUrls.slice(0, 6).map((url, index) => <div className="image-preview" key={`${url}-${index}`}><img src={url} alt={`预览 ${index + 1}`} referrerPolicy="no-referrer" /></div>) : <div className="image-preview-empty"><ImagePlus size={26} /><span>请先粘贴图片网址</span></div>}</div></div>{!id && <div className={`recognition-status phase-${recognition.phase}`}>{recognition.phase === "waiting" && <><Sparkles size={19} /><span>填写第一张以 http:// 或 https:// 开头的图片网址后自动识别同款</span></>}{recognition.phase === "checking" && <><LoaderCircle className="spin" size={19} /><span>正在识别主图，可以继续填写下方资料</span></>}{recognition.phase === "ready" && recognition.message && <><CheckCircle2 size={19} /><div><span>{recognition.message}</span>{recognition.timingText && <small>{recognition.timingText}</small>}</div></>}{recognition.phase === "failed" && <><TriangleAlert size={19} /><div><b>识别过程出错</b><span>{recognition.message}</span>{recognition.timingText && <small>{recognition.timingText}</small>}</div><button type="button" className="button button-secondary button-compact" onClick={() => { setCheckedUrls((value) => value.filter((url) => url !== primaryImageUrl)); setRecognition((value) => ({ ...value, phase: "waiting", message: "", timingText: "" })); }}><RefreshCw size={15} />重试</button><button type="button" className="button button-ghost button-compact" onClick={() => { setRecognition((value) => confirmedMatch ? ({ ...value, phase: "ready", runId: confirmedMatch.runId, runUrl: confirmedMatch.runUrl, decision: "matched", matchedProductId: confirmedMatch.productId, message: `主图识别失败，已选择继续沿用 ${confirmedMatch.sku}` }) : ({ ...value, phase: "ready", decision: "failed_continue", matchedProductId: "", message: "识别失败，已选择仍按新款继续" })); void apiFetch("/api/image-matching", { method: "PATCH", body: JSON.stringify({ runId: recognition.runId, decision: "failed_continue" }) }).catch(() => undefined); }}>仍按当前判断继续</button></>}</div>}</section>
    {(id || imageUrls.length > 0) && <div className="form-layout"><div className="form-main">
      <section className="panel form-section"><header><span className="section-number">02</span><div><h2>商品基本信息</h2><p>基础货号对应唯一款式，不同颜色或规格请使用新货号。</p></div></header><div className="form-grid">
        <Field label="商品基础货号"><input value={id || recognition.decision === "matched" ? form.sku : `保存后自动生成，例如 HZG-${today().slice(0, 4)}-0001`} readOnly className="readonly-input" /></Field><Field label="商品名称" required><input value={form.name} onChange={(event) => set("name", event.target.value)} placeholder="输入便于查找的商品名称" /></Field>
        <Field label="商品分类"><select value={form.categoryId} onChange={(event) => set("categoryId", event.target.value)}><option value="">暂不分类</option>{lookups?.categories.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="商务对接人"><select value={form.businessContactId} onChange={(event) => set("businessContactId", event.target.value)}><option value="">暂不指定</option>{lookups?.users.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.departmentName}</option>)}</select></Field>
        <Field label="选品部门" required className="field-full"><div className="check-grid">{lookups?.departments.map((item) => <label className={`check-card ${form.departmentIds.includes(item.id) ? "checked" : ""}`} key={item.id}><input type="checkbox" checked={form.departmentIds.includes(item.id)} onChange={() => set("departmentIds", form.departmentIds.includes(item.id) ? form.departmentIds.filter((value) => value !== item.id) : [...form.departmentIds, item.id])} /><span>{item.name}</span></label>)}</div></Field>
        <Field label="商品标签" className="field-full"><div className="tag-picker">{lookups?.tags.map((item) => <label key={item.id} style={{ "--tag-color": item.color } as React.CSSProperties} className={form.tagIds.includes(item.id) ? "selected" : ""}><input type="checkbox" checked={form.tagIds.includes(item.id)} onChange={() => set("tagIds", form.tagIds.includes(item.id) ? form.tagIds.filter((value) => value !== item.id) : [...form.tagIds, item.id])} />{item.name}</label>)}</div></Field>
      </div></section>
      <section className="panel form-section"><header><span className="section-number">03</span><div><h2>店铺与合作信息</h2><p>这些字段可后续修改，商品链接变更会记录操作人和时间。</p></div></header><div className="form-grid">
        <Field label="店铺名"><input value={form.storeName} onChange={(event) => set("storeName", event.target.value)} /></Field><Field label="供应链 / 机构"><input value={form.supplyChain} onChange={(event) => set("supplyChain", event.target.value)} /></Field>
        <Field label="价格"><div className="input-suffix"><input type="number" min="0" step="0.01" value={form.price} onChange={(event) => set("price", event.target.value)} /><span>元</span></div></Field><Field label="佣金" hint="填写 20 或 20% 均会统一显示为 20%"><input inputMode="decimal" value={form.commission} onChange={(event) => set("commission", event.target.value)} onBlur={() => { const value = form.commission.trim(); if (value && COMMISSION_INPUT_PATTERN.test(value)) set("commission", normalizeCommission(value) || ""); }} placeholder="例如 20 或 20%" /></Field>
        <Field label="店铺评分"><input type="number" min="0" max="5" step="0.01" value={form.storeRating} onChange={(event) => set("storeRating", event.target.value)} placeholder="0 - 5" /></Field><Field label="合作机制"><input value={form.cooperationMechanism} onChange={(event) => set("cooperationMechanism", event.target.value)} placeholder="填写合作、佣金或排期说明" /></Field>
        <Field label="商品链接" hint="支持完整网址，也支持 weixinstorehs/28656350764640 这类视频号链接。" className="field-full"><div className="input-prefix"><ExternalLink size={17} /><input type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={form.productUrl} onChange={(event) => set("productUrl", event.target.value)} placeholder="https://... 或 weixinstorehs/..." /></div></Field>
      </div></section>
    </div><aside className="form-side">
      {!id && <section className="panel form-section arrival-card"><header><span className="section-number">04</span><div><h2>本次到样</h2><p>每件实物会获得独立编号。</p></div></header><div className="form-grid single">
        <Field label="到样数量" required><div className="input-suffix"><input type="number" min="1" max="500" value={form.quantity} onChange={(event) => set("quantity", event.target.value)} /><span>件</span></div></Field><Field label="到样日期" required><input type="date" value={form.arrivedAt} onChange={(event) => set("arrivedAt", event.target.value)} /></Field>
        <Field label="初始所在部门" required><select value={form.initialDepartmentId} onChange={(event) => { set("initialDepartmentId", event.target.value); set("initialLocationId", ""); }}><option value="">请选择部门</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>        <Field label="具体存放位置"><select value={form.initialLocationId} onChange={(event) => set("initialLocationId", event.target.value)}><option value="">暂不细分</option>{locations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="样品规格" hint="例如颜色、尺码"><input value={form.spec} onChange={(event) => set("spec", event.target.value)} placeholder="例如 白色" /></Field>
      </div><div className="arrival-result"><Boxes size={20} /><div><b>将创建 {Number(form.quantity) || 0} 个独立编号</b><span>例如 HZG-{today().slice(0, 4)}-0001-001</span></div></div><div className="arrival-submit"><button className="button button-primary" disabled={saving || recognition.phase !== "ready" || !recognition.decision || candidates.length > 0}>{saving ? "正在保存…" : recognition.decision === "matched" ? "按同款追加到样" : "完成登记"}</button><small>{recognition.phase === "checking" ? "图片识别完成后即可提交" : "确认以上信息后完成本次到样登记"}</small></div></section>}
      <section className="panel form-section"><header><div><h2>备注</h2><p>可记录选品或合作补充信息。</p></div></header><Field label="内部备注"><textarea rows={6} value={form.notes} onChange={(event) => set("notes", event.target.value)} /></Field></section>
    </aside></div>}
    {candidates.length > 0 && <Modal title="发现疑似同款，请人工确认" onClose={rejectCandidates} wide><div className="match-intro"><img src={recognizingUrl || imageUrls[0]} alt="本次新图片" referrerPolicy="no-referrer" /><div><b>本次填写的主图</b><p>请逐一对比。颜色、尺码或规格不同，请选择“都不是同款”。</p>{recognition.timingText && <small>{recognition.timingText}</small>}</div></div><div className="match-candidate-list">{candidates.map((candidate) => <article className="match-candidate" key={candidate.id}><div className="match-images"><img src={recognizingUrl || imageUrls[0]} alt="新图片" referrerPolicy="no-referrer" /><img src={candidate.imageUrls?.[0]} alt={candidate.name} referrerPolicy="no-referrer" /></div><div className="match-candidate-copy"><span className="similarity-chip">相似度 {Math.round(candidate.similarity * 100)}%</span><b>{candidate.name}</b><p>{candidate.sku} · {candidate.storeName || "未填店铺"}{candidate.archived ? " · 已归档" : ""}</p><button type="button" className="button button-primary button-compact" onClick={() => chooseCandidate(candidate)}>确认是同款</button></div></article>)}</div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={rejectCandidates}>都不是同款，创建新款</button></div></Modal>}
    {draftCandidate && <Modal title="发现未完成的到样登记" onClose={continueDraft}><div className="draft-restore-dialog"><div><CheckCircle2 size={28} /><span><b>上次内容已临时保存</b><small>最后保存于 {formatDate(new Date(draftCandidate.savedAt), true)}，恢复后会重新核验商品主图。</small></span></div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={discardDraft}>放弃草稿</button><button type="button" className="button button-primary" onClick={continueDraft}>继续登记</button></div></div></Modal>}
  </form>;
}

export function ProductDetailView({ id }: { id: string }) {
  const { can, lookups, user } = useAppData(); const router = useRouter(); const toast = useToast(); const { data, loading, error, reload } = useRemote<ProductDetailData>(`/api/products/${id}`); const [stockOpen, setStockOpen] = useState(false);
  const [stock, setStock] = useState({ quantity: "1", arrivedAt: today(), departmentId: "", locationId: "", note: "", spec: "" }); const [saving, setSaving] = useState(false);
  useEffect(() => { if (lookups && !stock.departmentId) { const business = lookups.departments.find((item) => item.kind === "business"); if (business) setStock((value) => ({ ...value, departmentId: business.id })); } }, [lookups, stock.departmentId]);
  if (loading) return <LoadingState />; if (error || !data) return <ErrorState message={error || "商品不存在"} retry={reload} />;
  const p = data.product; const stockLocations = lookups?.locations.filter((item) => item.departmentId === stock.departmentId) || [];
  async function addStock(event: FormEvent) { event.preventDefault(); setSaving(true); try { await apiFetch(`/api/products/${id}/stock`, { method: "POST", body: JSON.stringify({ ...stock, locationId: stock.locationId || null }) }); toast(`已追加 ${stock.quantity} 件实物样品`); setStockOpen(false); await reload(); } catch (reason) { toast(reason instanceof Error ? reason.message : "追加失败", "error"); } finally { setSaving(false); } }
  async function archive() { if (!confirm("确定归档这个商品吗？在用样品未处理时不能归档。")) return; try { await apiFetch(`/api/products/${id}`, { method: "DELETE" }); toast("商品已归档"); router.push("/products?view=archived"); } catch (reason) { toast(reason instanceof Error ? reason.message : "归档失败", "error"); } }
  async function deletePermanent() { if (!confirm(`确定永久删除商品 ${p.sku} 吗？此操作不可恢复，将同时删除所有样品、流转记录和链接问题。`)) return; try { await apiFetch(`/api/products/${id}?permanent=1`, { method: "DELETE" }); toast("商品已永久删除"); router.push("/products"); } catch (reason) { toast(reason instanceof Error ? reason.message : "删除失败", "error"); } }
  async function restore() {
    if (!confirm("确定恢复这个商品吗？随商品归档的样品也会一起恢复。")) return;
    setSaving(true);
    try {
      const result = await apiFetch<{ sampleCount: number }>("/api/products/" + id + "/restore", { method: "POST" });
      toast("商品已恢复，同时恢复 " + result.sampleCount + " 件样品"); await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "恢复失败", "error"); }
    finally { setSaving(false); }
  }
  if (p.archived) return <>
    <PageHeader eyebrow={"已归档 · " + p.sku} title={p.name} description={"此档案当前仅供查看 · 共 " + data.samples.length + " 件历史样品"} actions={<><Link href="/products?view=archived" className="button button-ghost"><ArrowLeft size={17} />返回归档列表</Link>{can("products:archive") && <button className="button button-primary" disabled={saving} onClick={restore}><RefreshCw size={17} />{saving ? "恢复中…" : "恢复商品"}</button>}{user.isSuperAdmin && <button className="button button-ghost" style={{color:"var(--red)"}} onClick={deletePermanent}><Trash2 size={17} />永久删除</button>}</>} />
    <div className="archive-detail-notice"><Archive size={20} /><div><b>该商品已归档</b><span>商品和样品信息均已保留，恢复后可继续编辑、追加到样和处理链接问题。</span></div></div>
    <div className="detail-grid">
      <section className="panel product-hero-card"><ProductImage urls={p.imageUrls} alt={p.name} size="large" /><div className="product-hero-copy"><div className="badge-line"><span className="sku-chip">{p.sku}</span><span className="soft-badge archived-badge">已归档</span>{p.categoryName && <span className="soft-badge">{p.categoryName}</span>}{p.tags.map((tag) => <span className="soft-badge" style={{ borderColor: tag.color, color: tag.color }} key={tag.id}>{tag.name}</span>)}</div><h2>{p.name}</h2><div className="product-meta-grid"><span><Store size={16} />{p.storeName || "未填店铺"}</span><span><UserRound size={16} />{p.businessContactName || "未指定商务"}</span><span><MapPin size={16} />{p.departments.map((item) => item.name).join("、")}</span><span><CalendarDays size={16} />登记于 {formatDate(p.createdAt)}</span></div><div className="commercial-line"><div><small>价格</small><b>{p.price ? "¥" + p.price : "—"}</b></div><div><small>佣金</small><b>{p.commission ? formatCommission(p.commission) : "—"}</b></div><div><small>店铺评分</small><b>{p.storeRating || "—"}</b></div></div>{p.productUrl && (isWebProductLink(p.productUrl) ? <a className="external-product-link" href={p.productUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开商品链接</a> : <button type="button" className="external-product-link" title={p.productUrl} onClick={async () => { const ok = await copyToClipboard(p.productUrl || ""); if (ok) toast("视频号商品链接已复制"); else toast("复制失败", "error"); }}><Clipboard size={16} />复制视频号商品链接</button>)}</div></section>
      <section className="panel detail-info"><h2>合作信息</h2><dl><div><dt>供应链 / 机构</dt><dd>{p.supplyChain || "—"}</dd></div><div><dt>合作机制</dt><dd>{p.cooperationMechanism || "—"}</dd></div><div><dt>内部备注</dt><dd>{p.notes || "—"}</dd></div></dl></section>
    </div>
    <section className="panel table-panel"><header className="panel-header padded"><div><p className="eyebrow">历史记录</p><h2>归档样品（{data.samples.length}）</h2></div></header>{data.samples.length === 0 ? <EmptyState title="没有历史样品" /> : <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>独立编号</th><th>规格</th><th>到样日期</th><th>归档前状态</th><th>最后位置</th><th>最后更新</th></tr></thead><tbody>{data.samples.map((sample) => <tr key={sample.id}><td><span className="code-text">{sample.code}</span></td><td>{sample.spec || "—"}</td><td>{formatDate(sample.arrivedAt)}</td><td><StatusBadge status={sample.status} /></td><td>{activeLocationLabel({ status: sample.status, department_name: sample.departmentName, location_name: sample.locationName })}</td><td>{formatDate(sample.updatedAt, true)}</td></tr>)}</tbody></table></div><div className="mobile-record-list">{data.samples.map((sample) => <div className="mobile-record compact" key={sample.id}><div><b className="code-text">{sample.code}</b><p>{activeLocationLabel({ status: sample.status, department_name: sample.departmentName, location_name: sample.locationName })}</p><small>到样 {formatDate(sample.arrivedAt)}</small></div><StatusBadge status={sample.status} /></div>)}</div></>}</section>
    <ProductLinkHistory rows={data.linkHistory || []} />
  </>;
  return <>
    <PageHeader eyebrow={p.sku} title={p.name} description={`${p.departments.map((item) => item.name).join("、")} · 共 ${data.samples.length} 件实物样品`} actions={<><Link href="/products" className="button button-ghost"><ArrowLeft size={17} />返回</Link>{can("products:edit") && <button className="button button-secondary" onClick={() => setStockOpen(true)}><Plus size={17} />追加到样</button>}{can("products:edit") && <Link href={`/products/${id}/edit`} className="button button-primary"><FilePenLine size={17} />编辑档案</Link>}</>} />
    <div className="detail-grid"><section className="panel product-hero-card"><ProductImage urls={p.imageUrls} alt={p.name} size="large" /><div className="product-hero-copy"><div className="badge-line"><span className="sku-chip">{p.sku}</span>{p.categoryName && <span className="soft-badge">{p.categoryName}</span>}{p.tags.map((tag) => <span className="soft-badge" style={{ borderColor: tag.color, color: tag.color }} key={tag.id}>{tag.name}</span>)}</div><h2>{p.name}</h2><div className="product-meta-grid"><span><Store size={16} />{p.storeName || "未填店铺"}</span><span><UserRound size={16} />{p.businessContactName || "未指定商务"}</span><span><MapPin size={16} />{p.departments.map((item) => item.name).join("、")}</span><span><CalendarDays size={16} />登记于 {formatDate(p.createdAt)}</span></div><div className="commercial-line"><div><small>价格</small><b>{p.price ? `¥${p.price}` : "—"}</b></div><div><small>佣金</small><b>{p.commission ? formatCommission(p.commission) : "—"}</b></div><div><small>店铺评分</small><b>{p.storeRating || "—"}</b></div></div>{p.productUrl && (isWebProductLink(p.productUrl) ? <a className="external-product-link" href={p.productUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开商品链接</a> : <button type="button" className="external-product-link" title={p.productUrl} onClick={async () => { const ok = await copyToClipboard(p.productUrl || ""); if (ok) toast("视频号商品链接已复制"); else toast("复制失败", "error"); }}><Clipboard size={16} />复制视频号商品链接</button>)}</div></section>
      <section className="panel detail-info"><h2>合作信息</h2><dl><div><dt>供应链 / 机构</dt><dd>{p.supplyChain || "—"}</dd></div><div><dt>合作机制</dt><dd>{p.cooperationMechanism || "—"}</dd></div><div><dt>内部备注</dt><dd>{p.notes || "—"}</dd></div></dl>{can("products:archive") && <button className="danger-link" onClick={archive}><Archive size={16} />归档商品</button>}{user.isSuperAdmin && <button className="danger-link" onClick={deletePermanent}><Trash2 size={16} />永久删除</button>}</section></div>
    
    
    <section className="panel table-panel"><header className="panel-header padded"><div><p className="eyebrow">逐件管理</p><h2>实物样品（{data.samples.length}）</h2></div></header>{data.samples.length === 0 ? <EmptyState title="暂时没有实物样品" /> : <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>独立编号</th><th>规格</th><th>到样日期</th><th>状态</th><th>当前位置</th><th>最后更新</th><th /></tr></thead><tbody>{data.samples.map((sample) => <tr key={sample.id}><td><Link href={`/samples/${sample.code}`} className="code-link">{sample.code}</Link></td><td>{sample.spec || "—"}</td><td>{formatDate(sample.arrivedAt)}</td><td><StatusBadge status={sample.status} /></td><td>{activeLocationLabel({ status: sample.status, department_name: sample.departmentName, location_name: sample.locationName })}</td><td>{formatDate(sample.updatedAt, true)}</td><td><Link className="row-link" href={`/samples/${sample.code}`}>查看流转</Link></td></tr>)}</tbody></table></div><div className="mobile-record-list">{data.samples.map((sample) => <Link href={`/samples/${sample.code}`} className="mobile-record compact" key={sample.id}><div><b className="code-link">{sample.code}</b><p>{activeLocationLabel({ status: sample.status, department_name: sample.departmentName, location_name: sample.locationName })}</p><small>到样 {formatDate(sample.arrivedAt)}</small></div><StatusBadge status={sample.status} /></Link>)}</div></> }</section>
    <ProductLinkHistory rows={data.linkHistory || []} />
    {stockOpen && <Modal title="追加实物样品" onClose={() => setStockOpen(false)}><form className="modal-form" onSubmit={addStock}><div className="form-grid"><Field label="追加数量" required><input type="number" min="1" max="500" value={stock.quantity} onChange={(event) => setStock({ ...stock, quantity: event.target.value })} /></Field><Field label="到样日期" required><input type="date" value={stock.arrivedAt} onChange={(event) => setStock({ ...stock, arrivedAt: event.target.value })} /></Field><Field label="所在部门" required><select value={stock.departmentId} onChange={(event) => setStock({ ...stock, departmentId: event.target.value, locationId: "" })}><option value="">请选择</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="具体位置"><select value={stock.locationId} onChange={(event) => setStock({ ...stock, locationId: event.target.value })}><option value="">暂不细分</option>{stockLocations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="备注" className="field-full"><textarea rows={3} value={stock.note} onChange={(event) => setStock({ ...stock, note: event.target.value })} /></Field><Field label="样品规格" hint="例如颜色、尺码"><input value={stock.spec} onChange={(event) => setStock({ ...stock, spec: event.target.value })} placeholder="例如 白色" /></Field></div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setStockOpen(false)}>取消</button><button className="button button-primary" disabled={saving}>{saving ? "正在创建…" : `创建 ${stock.quantity || 0} 件样品`}</button></div></form></Modal>}
  </>;
}
