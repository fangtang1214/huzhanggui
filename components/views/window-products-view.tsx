"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownUp, ChevronDown, ExternalLink, Filter, PenLine, RefreshCw, Search, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { formatWindowServiceRatio } from "@/lib/window-registration";
import { apiFetch, copyToClipboard, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, PageHeader, ProductImage } from "../ui";

type WindowAccount = { id: string; name: string; appid: string; syncStatus: "idle" | "syncing" | "failed"; syncError?: string | null; syncedAt?: string | null; productCount: number };
type PromotionCandidate = { id: string; accountId: string; accountName: string; accountIsPrimary: boolean; headSupplierItemLink: string; promotionLink: string; serviceRatio?: number | null; commissionRatio?: number | null };
type WindowProduct = { id: string; productId: string; promotionError?: string | null; promotionSyncedAt?: string | null; promotionStatus: "pending" | "selected" | "confirmed" | "needs_choice" | "needs_replacement"; promotionConfirmed?: boolean; promotionAccountName?: string | null; promotionCandidates: PromotionCandidate[]; title?: string | null; imgUrl?: string | null; sellingPriceFen?: number | null; stock?: number | null; sales?: number | null; status?: number | null; isHide?: boolean | null; link?: string | null; registeredProductId?: string | null; registeredSku?: string | null; registeredProductUrl?: string | null; shopName?: string | null; shopScore?: number | null; shopIcon?: string | null; goodEvaluationRatio?: number | null; qualitySyncedAt?: string | null; serviceRatio?: number | null };
type LeagueState = { activeCount: number; hasPrimary: boolean };
type SortField = "" | "price" | "score" | "eval";

const fenToYuan = (fen?: number | null) => typeof fen === "number" ? (fen / 100).toFixed(2) : "";
const ratioText = (ratio?: number | null) => typeof ratio === "number" ? `${(ratio / 1000).toFixed(1)}%` : "—";
const scoreText = (score?: number | null) => typeof score === "number" ? `${(score / 100).toFixed(2)}` : "—";
const serviceRatioText = (ratio?: number | null) => typeof ratio === "number" ? `${parseFloat((ratio / 10000).toFixed(2))}%` : "未返回";
function decisionCandidates(product: WindowProduct) {
  if (product.promotionStatus !== "needs_choice") return product.promotionCandidates;
  const primary = product.promotionCandidates.filter((candidate) => candidate.accountIsPrimary);
  const pool = primary.length ? primary : product.promotionCandidates;
  const highest = Math.max(...pool.map((candidate) => candidate.serviceRatio ?? -1));
  return pool.filter((candidate) => (candidate.serviceRatio ?? -1) === highest);
}

export function WindowProductsView() {
  const { user } = useAppData();
  const router = useRouter();
  const toast = useToast();
  const [accountId, setAccountId] = useState(() => { try { return localStorage.getItem("huzhanggui:window-account") || ""; } catch { return ""; } });
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [priceRange, setPriceRange] = useState("");
  const [scoreRange, setScoreRange] = useState("");
  const [evalRange, setEvalRange] = useState("");
  const [stockFilter, setStockFilter] = useState("");
  const [regFilter, setRegFilter] = useState("");
  const [confirmingCandidateId, setConfirmingCandidateId] = useState("");
  const url = accountId ? `/api/window-products?accountId=${accountId}` : "/api/window-products";
  const { data, loading, error, reload } = useRemote<{ accounts: WindowAccount[]; products: WindowProduct[]; leagueState: LeagueState }>(url);
  const accounts = useMemo(() => data?.accounts || [], [data]);
  const products = useMemo(() => data?.products || [], [data]);
  const pendingPromotions = useMemo(() => products.filter((item) => item.promotionStatus === "needs_choice" || item.promotionStatus === "needs_replacement"), [products]);
  const selectedId = accountId || accounts[0]?.id || "";
  const activeAccount = accounts.find((a) => a.id === selectedId) || null;

  useEffect(() => { try { if (accountId) localStorage.setItem("huzhanggui:window-account", accountId); } catch { /* localStorage unavailable */ } }, [accountId]);

  useEffect(() => {
    if (activeAccount?.syncStatus !== "syncing") return;
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, [activeAccount?.syncStatus, reload]);

  const filteredProducts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    let list = keyword
      ? products.filter((item) =>
          (item.title || "").toLowerCase().includes(keyword) ||
          item.productId.includes(keyword) ||
          (item.shopName || "").toLowerCase().includes(keyword) ||
          (item.link || "").toLowerCase().includes(keyword))
      : [...products];
    if (priceRange) {
      list = list.filter((item) => {
        const f = (item.sellingPriceFen ?? 0) / 100;
        if (priceRange === "lt10") return f < 10;
        if (priceRange === "10to50") return f >= 10 && f < 50;
        if (priceRange === "50to100") return f >= 50 && f < 100;
        if (priceRange === "gt100") return f >= 100;
        return true;
      });
    }
    if (scoreRange) {
      list = list.filter((item) => {
        const s = item.shopScore;
        if (scoreRange === "gte45") return s != null && s >= 450;
        if (scoreRange === "40to45") return s != null && s >= 400 && s < 450;
        if (scoreRange === "lt40") return s != null && s < 400;
        if (scoreRange === "none") return s == null;
        return true;
      });
    }
    if (evalRange) {
      list = list.filter((item) => {
        const r = item.goodEvaluationRatio;
        if (evalRange === "gte90") return r != null && r >= 90000;
        if (evalRange === "80to90") return r != null && r >= 80000 && r < 90000;
        if (evalRange === "lt80") return r != null && r < 80000;
        if (evalRange === "none") return r == null;
        return true;
      });
    }
    if (stockFilter) {
      list = list.filter((item) => stockFilter === "has" ? (item.stock ?? 0) > 0 : (item.stock ?? 0) === 0);
    }
    if (regFilter) {
      list = list.filter((item) => regFilter === "yes" ? Boolean(item.registeredProductId) : !item.registeredProductId);
    }
    if (sortField && sortDir) {
      list.sort((a, b) => {
        let va = 0; let vb = 0;
        if (sortField === "price") { va = a.sellingPriceFen ?? 0; vb = b.sellingPriceFen ?? 0; }
        else if (sortField === "score") { va = a.shopScore ?? 0; vb = b.shopScore ?? 0; }
        else if (sortField === "eval") { va = a.goodEvaluationRatio ?? 0; vb = b.goodEvaluationRatio ?? 0; }
        return sortDir === "asc" ? va - vb : vb - va;
      });
    }
    return list;
  }, [products, search, sortField, sortDir, priceRange, scoreRange, evalRange, stockFilter, regFilter]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      if (sortDir === "asc") setSortDir("desc");
      else { setSortField(""); setSortDir("asc"); }
    } else { setSortField(field); setSortDir("asc"); }
  }

  const sortLabel = () => {
    if (!sortField) return "排序";
    const labels: Record<SortField, string> = { price: "售价", score: "评分", eval: "好评率", "": "" };
    return `${labels[sortField]}${sortDir === "asc" ? "↑" : "↓"}`;
  };

  const thSort = (field: SortField, label: string) => (
    <button type="button" className="table-sort-th" onClick={() => toggleSort(field)}>
      <span>{label}</span>
      <ArrowDownUp size={12} className={sortField === field ? (sortDir === "asc" ? "sort-asc" : "sort-desc") : "sort-inactive"} />
    </button>
  );

  async function syncWindow() {
    if (!selectedId) return;
    try {
      await apiFetch(`/api/talent-accounts/${selectedId}/sync`, { method: "POST" });
      toast("已开始同步橱窗商品和机构推广链接");
      setTimeout(() => reload(), 2000);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "同步失败", "error"); }
  }

  async function copyLink(link: string) {
    const ok = await copyToClipboard(link);
    if (ok) toast("商品链接已复制");
    else toast("复制失败，请手动选择", "error");
  }

  async function confirmPromotion(product: WindowProduct, candidate: PromotionCandidate) {
    if (product.promotionStatus === "needs_replacement" && !confirm(`确认使用 ${candidate.accountName} 的机构推广链接替换已登记商品链接吗？`)) return;
    setConfirmingCandidateId(candidate.id);
    try {
      await apiFetch("/api/window-products", { method: "POST", body: JSON.stringify({ windowProductId: product.id, candidateId: candidate.id }) });
      toast(product.promotionStatus === "needs_replacement" ? "机构推广链接已确认并更新" : "机构推广链接已确认");
      await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "确认失败", "error"); }
    finally { setConfirmingCandidateId(""); }
  }

  async function startRegistration(product: WindowProduct) {
    const commission = formatWindowServiceRatio(product.serviceRatio) || "";
    const draft = {
      version: 1 as const,
      autoRestore: true,
      form: {
        imageUrls: product.imgUrl || "",
        name: product.title || "",
        price: typeof product.sellingPriceFen === "number" ? (product.sellingPriceFen / 100).toFixed(2) : "",
         productUrl: product.link || "",
         windowProductId: product.id,
         apiProductId: product.productId || "",
        commission,
        storeName: product.shopName || "",
        storeRating: typeof product.shopScore === "number" ? (product.shopScore / 100).toFixed(2) : "",
        quantity: "1",
        arrivedAt: new Date().toISOString().slice(0, 10),
        departmentIds: [] as string[],
        tagIds: [] as string[],
        categoryId: "",
        businessContactId: user.id,
        supplyChain: "",
        cooperationMechanism: "",
        notes: "",
        initialLocationId: "",
        initialDepartmentId: "",
        sku: "",
      },
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(`huzhanggui:product-draft:${user.id}`, JSON.stringify(draft));
    } catch { /* localStorage unavailable */ }
    router.push("/products/new?returnUrl=/window-products");
  }

  return <>
    <PageHeader eyebrow="系统管理" title="橱窗管理" description="查看带货账号橱窗中的所有商品，推广链接和评分数据由已启用联盟机构账号 API 返回。" actions={accounts.length ? <div style={{ display: "flex", gap: 6 }}>
      <button type="button" className="button button-secondary" disabled={!selectedId || activeAccount?.syncStatus === "syncing"} onClick={syncWindow}><RefreshCw size={17} />{activeAccount?.syncStatus === "syncing" ? "同步中…" : "同步橱窗"}</button>
    </div> : undefined} />
    <section className="toolbar">
      {!accounts.length && !loading ? <EmptyState title="尚未配置带货账号" description="请超管在「系统管理 → 带货账号」添加微信小店带货助手的 AppID 与密钥后，再回来查看。" /> : <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
          <select value={selectedId} onChange={(event) => setAccountId(event.target.value)} style={{ minWidth: 200 }}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}（{account.productCount} 件）</option>)}</select>
          <div className="search-box" style={{ flex: 1, minWidth: 180, maxWidth: 320 }}><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索商品名称、ID、店铺或链接" /></div>
          <details className="price-filter"><summary><ArrowDownUp size={15} /><span>{sortLabel()}</span><ChevronDown size={14} /></summary><div className="price-filter-menu"><header><b>排序</b></header><div className="price-sort"><span>售价</span><button type="button" className={sortField !== "price" ? "selected" : ""} onClick={() => { setSortField(""); setSortDir("asc"); }}>默认</button><button type="button" className={sortField === "price" && sortDir === "asc" ? "selected" : ""} onClick={() => { setSortField("price"); setSortDir("asc"); }}>低→高</button><button type="button" className={sortField === "price" && sortDir === "desc" ? "selected" : ""} onClick={() => { setSortField("price"); setSortDir("desc"); }}>高→低</button></div><div className="price-sort"><span>好评率</span><button type="button" className={sortField !== "eval" ? "selected" : ""} onClick={() => { setSortField(""); setSortDir("asc"); }}>默认</button><button type="button" className={sortField === "eval" && sortDir === "asc" ? "selected" : ""} onClick={() => { setSortField("eval"); setSortDir("asc"); }}>低→高</button><button type="button" className={sortField === "eval" && sortDir === "desc" ? "selected" : ""} onClick={() => { setSortField("eval"); setSortDir("desc"); }}>高→低</button></div><div className="price-sort"><span>店铺评分</span><button type="button" className={sortField !== "score" ? "selected" : ""} onClick={() => { setSortField(""); setSortDir("asc"); }}>默认</button><button type="button" className={sortField === "score" && sortDir === "asc" ? "selected" : ""} onClick={() => { setSortField("score"); setSortDir("asc"); }}>低→高</button><button type="button" className={sortField === "score" && sortDir === "desc" ? "selected" : ""} onClick={() => { setSortField("score"); setSortDir("desc"); }}>高→低</button></div></div></details>{(() => { const priceLabel = { lt10: "¥10以下", "10to50": "¥10–50", "50to100": "¥50–100", gt100: "¥100以上" }[priceRange] || "售价"; return <details className="price-filter"><summary><Filter size={14} /><span>{priceLabel}</span><ChevronDown size={14} /></summary><div className="price-filter-menu" style={{ width: 180 }}><header><b>售价</b>{priceRange && <button type="button" onClick={() => setPriceRange("")}><X size={14} /></button>}</header><div className="price-option-list">{[{ k: "lt10", l: "¥10 以下" }, { k: "10to50", l: "¥10 – 50" }, { k: "50to100", l: "¥50 – 100" }, { k: "gt100", l: "¥100 以上" }].map((opt) => <label key={opt.k}><input type="radio" name="filter-price" checked={priceRange === opt.k} onChange={() => setPriceRange(priceRange === opt.k ? "" : opt.k)} />{opt.l}</label>)}</div></div></details>; })()}{(() => { const scoreLabel = { gte45: "≥4.5", "40to45": "4.0–4.5", lt40: "<4.0", none: "暂无" }[scoreRange] || "评分"; return <details className="price-filter"><summary><Filter size={14} /><span>{scoreLabel}</span><ChevronDown size={14} /></summary><div className="price-filter-menu" style={{ width: 180 }}><header><b>评分</b>{scoreRange && <button type="button" onClick={() => setScoreRange("")}><X size={14} /></button>}</header><div className="price-option-list">{[{ k: "gte45", l: "4.5 分以上" }, { k: "40to45", l: "4.0 – 4.5" }, { k: "lt40", l: "4.0 分以下" }, { k: "none", l: "暂无评分" }].map((opt) => <label key={opt.k}><input type="radio" name="filter-score" checked={scoreRange === opt.k} onChange={() => setScoreRange(scoreRange === opt.k ? "" : opt.k)} />{opt.l}</label>)}</div></div></details>; })()}{(() => { const evalLabel = { gte90: "≥90%", "80to90": "80–90%", lt80: "<80%", none: "暂无" }[evalRange] || "好评率"; return <details className="price-filter"><summary><Filter size={14} /><span>{evalLabel}</span><ChevronDown size={14} /></summary><div className="price-filter-menu" style={{ width: 180 }}><header><b>好评率</b>{evalRange && <button type="button" onClick={() => setEvalRange("")}><X size={14} /></button>}</header><div className="price-option-list">{[{ k: "gte90", l: "90% 以上" }, { k: "80to90", l: "80% – 90%" }, { k: "lt80", l: "80% 以下" }, { k: "none", l: "暂无数据" }].map((opt) => <label key={opt.k}><input type="radio" name="filter-eval" checked={evalRange === opt.k} onChange={() => setEvalRange(evalRange === opt.k ? "" : opt.k)} />{opt.l}</label>)}</div></div></details>; })()}{(() => { const stockLabel = { has: "有库存", empty: "无库存" }[stockFilter] || "库存"; return <details className="price-filter"><summary><Filter size={14} /><span>{stockLabel}</span><ChevronDown size={14} /></summary><div className="price-filter-menu" style={{ width: 150 }}><header><b>库存</b>{stockFilter && <button type="button" onClick={() => setStockFilter("")}><X size={14} /></button>}</header><div className="price-option-list">{[{ k: "has", l: "有库存" }, { k: "empty", l: "无库存" }].map((opt) => <label key={opt.k}><input type="radio" name="filter-stock" checked={stockFilter === opt.k} onChange={() => setStockFilter(stockFilter === opt.k ? "" : opt.k)} />{opt.l}</label>)}</div></div></details>; })()}{(() => { const regLabel = { yes: "已登记", no: "未登记" }[regFilter] || "登记"; return <details className="price-filter"><summary><Filter size={14} /><span>{regLabel}</span><ChevronDown size={14} /></summary><div className="price-filter-menu" style={{ width: 150 }}><header><b>登记</b>{regFilter && <button type="button" onClick={() => setRegFilter("")}><X size={14} /></button>}</header><div className="price-option-list">{[{ k: "yes", l: "已登记" }, { k: "no", l: "未登记" }].map((opt) => <label key={opt.k}><input type="radio" name="filter-reg" checked={regFilter === opt.k} onChange={() => setRegFilter(regFilter === opt.k ? "" : opt.k)} />{opt.l}</label>)}</div></div></details>; })()}
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{activeAccount ? `${activeAccount.syncStatus === "syncing" ? "正在同步橱窗与评分数据…" : activeAccount.syncedAt ? `最近同步：${formatDate(activeAccount.syncedAt, true)}` : "橱窗尚未同步"}` : ""}{activeAccount?.syncStatus === "failed" && activeAccount.syncError ? ` · 失败：${activeAccount.syncError}` : ""}</span>
        </div>
      </>}
    </section>
    {(data?.leagueState?.activeCount || 0) > 0 && !data?.leagueState?.hasPrimary && <section className="panel" style={{ padding: "12px 16px", marginBottom: 12, borderColor: "var(--amber)" }}><p style={{ margin: 0, color: "var(--amber)", fontSize: 13 }}><TriangleAlert size={15} style={{ marginRight: 6 }} />尚未设置联盟机构主账号；系统会按实时服务费率选择，最高费率相同时进入下方待确认列表。</p></section>}
    {pendingPromotions.length > 0 && <section className="panel" style={{ padding: 18, marginBottom: 14 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}><TriangleAlert size={18} /><div><b>待人工确认推广链接</b><small style={{ display: "block", color: "var(--muted)" }}>同费率候选和已登记商品的链接替换统一在这里处理。</small></div></header>
      <div style={{ display: "grid", gap: 12 }}>{pendingPromotions.map((item) => <article key={item.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 9 }}><span><b>{item.title || `商品 ${item.productId}`}</b><small style={{ display: "block", color: "var(--muted)" }}>达人商品 ID：{item.productId}{item.registeredSku ? ` · 已登记 ${item.registeredSku}` : ""}</small></span><span className="soft-badge">{item.promotionStatus === "needs_replacement" ? "确认替换" : "选择链接"}</span></div>
        {item.promotionStatus === "needs_replacement" && item.registeredProductUrl && <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--muted)" }}>当前已登记链接：<code>{item.registeredProductUrl}</code></p>}
        <div style={{ display: "grid", gap: 7 }}>{decisionCandidates(item).map((candidate) => <div key={candidate.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 10px", background: "var(--surface-soft)", borderRadius: 8 }}><span style={{ minWidth: 0 }}><b style={{ fontSize: 13 }}>{candidate.accountName}{candidate.accountIsPrimary ? "（主账号）" : ""}</b><code style={{ display: "block", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis" }}>{candidate.promotionLink}</code><small style={{ color: "var(--muted)" }}>实时服务费率：{serviceRatioText(candidate.serviceRatio)}</small></span><button type="button" className="button button-primary button-compact" disabled={Boolean(confirmingCandidateId)} onClick={() => confirmPromotion(item, candidate)}>{confirmingCandidateId === candidate.id ? "确认中…" : "使用此链接"}</button></div>)}</div>
      </article>)}</div>
    </section>}
    <section className="panel table-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !accounts.length ? <EmptyState title="请先配置带货账号" description="请超管在「系统管理 → 带货账号」添加微信小店带货助手的 AppID 与密钥。" /> : !products.length ? <EmptyState title="橱窗商品为空" description="请点击右上角「同步橱窗」从微信拉取数据。" /> : <div className="data-table-wrap"><table className="data-table">
        <thead><tr>
          <th>商品</th>
          <th>店铺 / 评分</th>
          <th>{thSort("price", "售价")}</th>
          <th>{thSort("eval", "好评率")}</th>
          <th>库存</th>
          <th>状态</th>
          <th>链接</th>
          <th>操作</th>
        </tr></thead>
        <tbody>{filteredProducts.map((item) => <tr key={item.id}>
          <td><div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <ProductImage urls={item.imgUrl ? [item.imgUrl] : []} alt={item.title || "橱窗商品"} size="small" />
            <div style={{ minWidth: 0 }}>
              <b style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 240 }}>{item.title || `商品 ${item.productId}`}</b>
              <small style={{ color: "var(--muted)" }}>{item.isHide ? "橱窗中已隐藏" : ""}{item.sales ? ` · 销量 ${item.sales}` : ""}</small>
            </div>
          </div></td>
          <td><div>{item.shopScore != null ? <b>{scoreText(item.shopScore)}</b> : "—"}{item.shopName ? <small style={{ display: "block", color: "var(--muted)", fontSize: 11 }}>{item.shopName}</small> : ""}</div></td>
          <td><b className="money-cell">{fenToYuan(item.sellingPriceFen) ? `¥${fenToYuan(item.sellingPriceFen)}` : "—"}</b></td>
          <td><b style={{ color: (item.goodEvaluationRatio ?? 0) >= 90000 ? "var(--green)" : (item.goodEvaluationRatio ?? 0) > 0 ? "var(--amber)" : "inherit" }}>{ratioText(item.goodEvaluationRatio)}</b></td>
          <td><b>{typeof item.stock === "number" ? item.stock : "—"}</b></td>
          <td>{item.status === 1 ? <span style={{ color: "var(--green)", fontSize: 13 }}>生效中</span> : item.status === 2 ? <span style={{ color: "var(--red)", fontSize: 13 }}>禁止售卖</span> : "—"}</td>
          <td><div style={{ display: "flex", gap: 4, alignItems: "center" }}>
             <div>{item.link ? <code style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160, display: "block" }} title={item.link}>{item.link}</code> : <span style={{ fontSize: 12, color: "var(--muted)" }}>待获取机构推广链接</span>}<small style={{ color: item.promotionStatus === "confirmed" ? "var(--green)" : "var(--amber)", display: "block" }}>{item.promotionStatus === "confirmed" ? "机构链接已确认" : item.promotionStatus === "selected" ? `已按规则选择${item.promotionAccountName ? `：${item.promotionAccountName}` : "机构链接"}` : item.promotionStatus === "needs_choice" ? "同费率候选待人工选择" : item.promotionStatus === "needs_replacement" ? "新机构链接待确认替换" : item.promotionError || "机构链接待确认"}</small></div>
            {item.link && <button type="button" className="icon-button" onClick={() => copyLink(item.link || "")} aria-label="复制链接" title="复制链接"><ExternalLink size={13} /></button>}
          </div></td>
          <td>{item.registeredProductId ? <span style={{ fontSize: 13 }}>{item.registeredSku || "已登记"}</span> : <button type="button" className="button button-primary button-compact" style={{ fontSize: 12 }} disabled={!item.title || !item.imgUrl} onClick={() => startRegistration(item)}><PenLine size={13} />登记</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
     <section className="panel" style={{ padding: 20 }}>
       <p style={{ fontSize: 13, color: "var(--muted)" }}><ShieldCheck size={14} style={{ marginRight: 4 }} />橱窗同步会逐一查询全部已启用的联盟机构账号。主账号结果优先；主账号失败时按实时服务费率选择。未获得机构推广链接的商品仍可人工登记，但链接保持为空并标记待确认，不会使用达人原始链接冒充机构链接。</p>
     </section>
  </>;
}
