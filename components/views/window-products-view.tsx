"use client";

import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { apiFetch, copyToClipboard, formatDate, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, PageHeader, ProductImage } from "../ui";

type WindowAccount = { id: string; name: string; appid: string; syncStatus: "idle" | "syncing" | "failed"; syncError?: string | null; syncedAt?: string | null; productCount: number };
type WindowProduct = { id: string; productId: string; outProductId?: string | null; title?: string | null; imgUrl?: string | null; sellingPriceFen?: number | null; stock?: number | null; sales?: number | null; status?: number | null; isHide?: boolean | null; link: string; registeredProductId?: string | null; registeredSku?: string | null };

const fenToYuan = (fen?: number | null) => typeof fen === "number" ? (fen / 100).toFixed(2) : "";

export function WindowProductsView() {
  const toast = useToast();
  const [accountId, setAccountId] = useState("");
  const { data, loading, error, reload } = useRemote<{ accounts: WindowAccount[]; products: WindowProduct[] }>(`/api/window-products${accountId ? `?accountId=${accountId}` : ""}`);
  const accounts = data?.accounts || [];
  const products = data?.products || [];
  const activeAccount = accounts.find((account) => account.id === accountId) || null;

  async function syncWindow() {
    if (!accountId) return;
    try {
      await apiFetch(`/api/talent-accounts/${accountId}/sync`, { method: "POST" });
      toast("已开始同步橱窗商品，稍后列表会自动刷新");
      setTimeout(() => reload(), 2000);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "同步失败", "error"); }
  }

  async function copyLink(link: string) {
    const ok = await copyToClipboard(link);
    if (ok) toast("商品链接已复制");
    else toast("复制失败，请手动选择", "error");
  }

  return <>
    <PageHeader eyebrow="系统管理" title="橱窗管理" description="查看带货账号橱窗中的所有商品，支持链接复制和已登记商品对照。" actions={accounts.length ? <button type="button" className="button button-secondary" disabled={!accountId || activeAccount?.syncStatus === "syncing"} onClick={syncWindow}><RefreshCw size={17} />{activeAccount?.syncStatus === "syncing" ? "同步中…" : "同步橱窗"}</button> : undefined} />
    <section className="toolbar">
      {!accounts.length && !loading ? <EmptyState title="尚未配置带货账号" description="请超管在「系统管理 → 带货账号」添加微信小店带货助手的 AppID 与密钥后，再回来查看。" /> : <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", flex: 1 }}>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)} style={{ minWidth: 200 }}>{accounts.map((account) => <option value={account.id} key={account.id}>{account.name}（{account.productCount} 件）</option>)}</select>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{activeAccount ? `${activeAccount.syncStatus === "syncing" ? "正在同步…" : activeAccount.syncedAt ? `最近同步：${formatDate(activeAccount.syncedAt, true)}` : "尚未同步"}` : ""}{activeAccount?.syncStatus === "failed" && activeAccount.syncError ? ` · 上次同步失败：${activeAccount.syncError}` : ""}</span>
        </div>
      </>}
    </section>
    <section className="panel table-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !accountId ? <EmptyState title="请先选择一个带货账号" description="选择一个已配置的带货账号即可查看其橱窗商品列表。" /> : !products.length ? <EmptyState title="橱窗商品为空" description="请点击右上角「同步橱窗」从微信拉取数据。" /> : <div className="data-table-wrap"><table className="data-table">
        <thead><tr>
          <th>商品</th>
          <th>橱窗 ID</th>
          <th>售价</th>
          <th>库存</th>
          <th>销量</th>
          <th>状态</th>
          <th>链接</th>
          <th>狐掌柜</th>
        </tr></thead>
        <tbody>{products.map((item) => <tr key={item.id}>
          <td><div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <ProductImage urls={item.imgUrl ? [item.imgUrl] : []} alt={item.title || "橱窗商品"} size="small" />
            <div style={{ minWidth: 0 }}>
              <b style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }}>{item.title || `商品 ${item.productId}`}</b>
              {item.isHide && <small style={{ color: "var(--muted)" }}>橱窗中已隐藏</small>}
            </div>
          </div></td>
          <td><code style={{ fontSize: 11 }}>{item.productId}</code></td>
          <td><b className="money-cell">{fenToYuan(item.sellingPriceFen) ? `¥${fenToYuan(item.sellingPriceFen)}` : "—"}</b></td>
          <td><b>{typeof item.stock === "number" ? item.stock : "—"}</b></td>
          <td><b>{typeof item.sales === "number" ? item.sales : "—"}</b></td>
          <td>{item.status === 1 ? <span style={{ color: "var(--green)", fontSize: 13 }}>生效中</span> : item.status === 2 ? <span style={{ color: "var(--red)", fontSize: 13 }}>禁止售卖</span> : "—"}</td>
          <td><div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <code style={{ fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }} title={item.link}>{item.link}</code>
            <button type="button" className="icon-button" onClick={() => copyLink(item.link)} aria-label="复制链接" title="复制链接"><ExternalLink size={13} /></button>
          </div></td>
          <td>{item.registeredProductId ? <span style={{ fontSize: 13 }}>{item.registeredSku || "已登记"}</span> : <span style={{ color: "var(--muted)", fontSize: 12 }}>未登记</span>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  </>;
}
