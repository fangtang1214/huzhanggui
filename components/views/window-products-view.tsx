"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, PenLine, RefreshCw, ShieldCheck } from "lucide-react";
import { apiFetch, copyToClipboard, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, PageHeader, ProductImage } from "../ui";

type WindowAccount = { id: string; name: string; appid: string; syncStatus: "idle" | "syncing" | "failed"; syncError?: string | null; syncedAt?: string | null; productCount: number };
type WindowProduct = { id: string; productId: string; outProductId?: string | null; title?: string | null; imgUrl?: string | null; sellingPriceFen?: number | null; stock?: number | null; sales?: number | null; status?: number | null; isHide?: boolean | null; link: string; registeredProductId?: string | null; registeredSku?: string | null; shopName?: string | null; shopScore?: number | null; shopIcon?: string | null; goodEvaluationRatio?: number | null; qualitySyncedAt?: string | null; serviceRatio?: number | null };
type LeagueOption = { id: string; name: string; active: boolean };

const fenToYuan = (fen?: number | null) => typeof fen === "number" ? (fen / 100).toFixed(2) : "";
const ratioText = (ratio?: number | null) => typeof ratio === "number" ? `${(ratio / 1000).toFixed(1)}%` : "—";
const scoreText = (score?: number | null) => typeof score === "number" ? `${(score / 100).toFixed(2)}` : "—";

export function WindowProductsView() {
  const { user } = useAppData();
  const router = useRouter();
  const toast = useToast();
  const [accountId, setAccountId] = useState("");
  const [leagueId, setLeagueId] = useState("");
  const [leagueOptions, setLeagueOptions] = useState<LeagueOption[]>([]);
  const url = accountId ? `/api/window-products?accountId=${accountId}` : "/api/window-products";
  const { data, loading, error, reload } = useRemote<{ accounts: WindowAccount[]; products: WindowProduct[] }>(url);
  const accounts = useMemo(() => data?.accounts || [], [data]);
  const products = useMemo(() => data?.products || [], [data]);
  const selectedId = accountId || accounts[0]?.id || "";
  const activeAccount = accounts.find((a) => a.id === selectedId) || null;

  useEffect(() => { apiFetch<LeagueOption[]>("/api/league-accounts?minimal=1").then((list) => { setLeagueOptions(list); if (list.length) setLeagueId(list[0].id); }).catch(() => {}); }, []);

  useEffect(() => {
    if (activeAccount?.syncStatus !== "syncing") return;
    const timer = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(timer);
  }, [activeAccount?.syncStatus, reload]);

  async function syncWindow() {
    if (!selectedId) return;
    try {
      await apiFetch(`/api/talent-accounts/${selectedId}/sync`, { method: "POST" });
      toast("已开始同步橱窗商品");
      if (leagueId) {
        apiFetch(`/api/league-accounts/${leagueId}/sync-quality?talentAccountId=${selectedId}`, { method: "POST" }).catch(() => {});
      }
      setTimeout(() => reload(), 2000);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "同步失败", "error"); }
  }

  async function syncQuality() {
    if (!leagueId || !selectedId) return;
    try {
      await apiFetch(`/api/league-accounts/${leagueId}/sync-quality?talentAccountId=${selectedId}`, { method: "POST" });
      toast("已开始同步商品评分数据");
      setTimeout(() => reload(), 2000);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "评分同步失败", "error"); }
  }

  async function copyLink(link: string) {
    const ok = await copyToClipboard(link);
    if (ok) toast("商品链接已复制");
    else toast("复制失败，请手动选择", "error");
  }

  async function startRegistration(product: WindowProduct) {
    const commission = typeof product.serviceRatio === "number" && product.serviceRatio > 0
      ? `${parseFloat((product.serviceRatio / 10000).toFixed(2))}%` : "";
    const draft = {
      version: 1 as const,
      form: {
        imageUrls: product.imgUrl || "",
        name: product.title || "",
        price: typeof product.sellingPriceFen === "number" ? (product.sellingPriceFen / 100).toFixed(2) : "",
        productUrl: product.link || "",
        commission,
        storeName: product.shopName || "",
        storeRating: typeof product.shopScore === "number" ? (product.shopScore / 100).toFixed(2) : "",
        quantity: "1",
        arrivedAt: new Date().toISOString().slice(0, 10),
        departmentIds: [] as string[],
        tagIds: [] as string[],
        categoryId: "",
        businessContactId: "",
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
    router.push("/products/new");
  }

  return <>
    <PageHeader eyebrow="系统管理" title="橱窗管理" description="查看带货账号橱窗中的所有商品，支持评分数据和已登记商品对照。" actions={accounts.length ? <div style={{ display: "flex", gap: 6 }}>
      <button type="button" className="button button-secondary" disabled={!selectedId || activeAccount?.syncStatus === "syncing"} onClick={syncWindow}><RefreshCw size={17} />{activeAccount?.syncStatus === "syncing" ? "同步中…" : "同步橱窗"}</button>
      {leagueOptions.length > 0 && <button type="button" className="button button-secondary button-compact" disabled={!selectedId} onClick={syncQuality}><ShieldCheck size={15} />仅同步评分</button>}
    </div> : undefined} />
    <section className="toolbar">
      {!accounts.length && !loading ? <EmptyState title="尚未配置带货账号" description="请超管在「系统管理 → 带货账号」添加微信小店带货助手的 AppID 与密钥后，再回来查看。" /> : <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
          <select value={selectedId} onChange={(event) => setAccountId(event.target.value)} style={{ minWidth: 200 }}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}（{account.productCount} 件）</option>)}</select>
          {leagueOptions.length > 1 && <select value={leagueId} onChange={(event) => setLeagueId(event.target.value)} style={{ minWidth: 200 }}><option value="">选择机构账号</option>{leagueOptions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>}
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{activeAccount ? `${activeAccount.syncStatus === "syncing" ? "正在同步橱窗与评分数据…" : activeAccount.syncedAt ? `最近同步：${formatDate(activeAccount.syncedAt, true)}` : "橱窗尚未同步"}` : ""}{activeAccount?.syncStatus === "failed" && activeAccount.syncError ? ` · 失败：${activeAccount.syncError}` : ""}</span>
        </div>
      </>}
    </section>
    <section className="panel table-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !accounts.length ? <EmptyState title="请先配置带货账号" description="请超管在「系统管理 → 带货账号」添加微信小店带货助手的 AppID 与密钥。" /> : !products.length ? <EmptyState title="橱窗商品为空" description="请点击右上角「同步橱窗」从微信拉取数据。" /> : <div className="data-table-wrap"><table className="data-table">
        <thead><tr>
          <th>商品</th>
          <th>店铺 / 评分</th>
          <th>售价</th>
          <th>好评率</th>
          <th>库存</th>
          <th>状态</th>
          <th>链接</th>
          <th>操作</th>
        </tr></thead>
        <tbody>{products.map((item) => <tr key={item.id}>
          <td><div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <ProductImage urls={item.imgUrl ? [item.imgUrl] : []} alt={item.title || "橱窗商品"} size="small" />
            <div style={{ minWidth: 0 }}>
              <b style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 240 }}>{item.title || `商品 ${item.productId}`}</b>
              <small style={{ color: "var(--muted)" }}>{item.isHide ? "橱窗中已隐藏" : ""}{item.sales ? ` · 销量 ${item.sales}` : ""}</small>
            </div>
          </div></td>
          <td><div>{item.shopName || "—"}{item.shopScore ? <small style={{ display: "block", color: "var(--muted)" }}>{scoreText(item.shopScore)}</small> : ""}</div></td>
          <td><b className="money-cell">{fenToYuan(item.sellingPriceFen) ? `¥${fenToYuan(item.sellingPriceFen)}` : "—"}</b></td>
          <td><b style={{ color: (item.goodEvaluationRatio ?? 0) >= 90000 ? "var(--green)" : (item.goodEvaluationRatio ?? 0) > 0 ? "var(--amber)" : "inherit" }}>{ratioText(item.goodEvaluationRatio)}</b></td>
          <td><b>{typeof item.stock === "number" ? item.stock : "—"}</b></td>
          <td>{item.status === 1 ? <span style={{ color: "var(--green)", fontSize: 13 }}>生效中</span> : item.status === 2 ? <span style={{ color: "var(--red)", fontSize: 13 }}>禁止售卖</span> : "—"}</td>
          <td><div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <code style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160 }} title={item.link}>{item.link}</code>
            <button type="button" className="icon-button" onClick={() => copyLink(item.link)} aria-label="复制链接" title="复制链接"><ExternalLink size={13} /></button>
          </div></td>
          <td>{item.registeredProductId ? <span style={{ fontSize: 13 }}>{item.registeredSku || "已登记"}</span> : <button type="button" className="button button-primary button-compact" style={{ fontSize: 12 }} disabled={!item.title || !item.imgUrl} onClick={() => startRegistration(item)}><PenLine size={13} />登记</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    {!leagueOptions.length && <section className="panel" style={{ padding: 20 }}>
      <p style={{ fontSize: 13, color: "var(--muted)" }}><ShieldCheck size={14} style={{ marginRight: 4 }} />还没有配置联盟带货机构账号。添加后可同步商品的好评率、店铺评分数据。<br />请超管在「系统管理 → 联盟带货机构」中添加 AppID 和密钥。</p>
    </section>}
  </>;
}
