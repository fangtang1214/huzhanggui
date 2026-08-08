"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { apiFetch, formatDate, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader } from "../ui";

type LeagueAccount = { id: string; name: string; appid: string; active: boolean; isPrimary: boolean; createdAt: string; createdByName?: string | null; };
type CorrectionRun = { id: string; status: "pending" | "running" | "completed" | "failed"; totalCount: number; processedCount: number; successCount: number; failedCount: number; createdAt: string; completedAt?: string | null; error?: string | null; };
type CorrectionItem = { id: string; status: "pending" | "success" | "failed"; sku: string; productName: string; oldProductUrl?: string | null; newProductUrl?: string | null; apiProductId?: string | null; error?: string | null; };
type CorrectionData = { runs: CorrectionRun[]; items: CorrectionItem[]; selectedRunId?: string | null };

const blankDraft = { name: "", appid: "", appSecret: "", active: true, isPrimary: false };

export function LeagueAccountsView() {
  const toast = useToast();
  const { data, loading, error, reload } = useRemote<LeagueAccount[]>("/api/league-accounts");
  const [correctionRunId, setCorrectionRunId] = useState("");
  const correctionRemote = useRemote<CorrectionData>(`/api/league-accounts/link-corrections${correctionRunId ? `?runId=${correctionRunId}` : ""}`);
  const correction = useMemo(() => ({
    data: correctionRemote.data || { runs: [], items: [], selectedRunId: null },
    loading: correctionRemote.loading,
    error: correctionRemote.error,
    reload: correctionRemote.reload,
  }), [correctionRemote.data, correctionRemote.error, correctionRemote.loading, correctionRemote.reload]);
  const [editing, setEditing] = useState<LeagueAccount | "new" | null>(null);
  const [draft, setDraft] = useState(blankDraft);
  const [saving, setSaving] = useState(false);
  const [startingCorrection, setStartingCorrection] = useState(false);

  useEffect(() => {
    if (!correction.data?.runs.some((run) => run.status === "pending" || run.status === "running")) return;
    const timer = window.setInterval(() => void correction.reload(), 3000);
    return () => window.clearInterval(timer);
  }, [correction]);

  function openNew() { setDraft(blankDraft); setEditing("new"); }
  function openEdit(account: LeagueAccount) { setDraft({ name: account.name, appid: account.appid, appSecret: "", active: account.active, isPrimary: account.isPrimary }); setEditing(account); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await apiFetch("/api/league-accounts", { method: "POST", body: JSON.stringify(draft) });
        toast("机构账号已添加");
      } else {
        await apiFetch(`/api/league-accounts/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...draft, appSecret: draft.appSecret || undefined }) });
        toast("机构账号已保存");
      }
      setEditing(null);
      await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "保存失败", "error"); }
    finally { setSaving(false); }
  }

  async function remove(account: LeagueAccount) {
    if (!confirm(`确定删除机构账号 ${account.name} 吗？`)) return;
    try {
      await apiFetch(`/api/league-accounts/${account.id}`, { method: "DELETE" });
      toast("机构账号已删除");
      await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "删除失败", "error"); }
  }

  async function startCorrection(action: "start" | "retry", runId?: string) {
    if (action === "start" && !confirm("将校正全部在用商品的机构推广链接。任务会在后台执行，是否继续？")) return;
    setStartingCorrection(true);
    try {
      const result = await apiFetch<{ id: string }>("/api/league-accounts/link-corrections", { method: "POST", body: JSON.stringify({ action, runId }) });
      setCorrectionRunId(result.id);
      toast(action === "retry" ? "已开始重试失败商品" : "已开始校正历史商品");
      await correction.reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "启动校正失败", "error"); }
    finally { setStartingCorrection(false); }
  }

  return <>
    <PageHeader eyebrow="系统管理" title="联盟带货机构" description="配置联盟带货机构账号后，橱窗同步会自动使用全部已启用账号获取真实推广链接。" actions={<button className="button button-primary" onClick={openNew}><Plus size={17} />添加机构账号</button>} />
     <section className="panel table-panel">
       {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.length ? <EmptyState title="尚未配置机构账号" description="在微信开发者平台注册联盟带货机构后，把 AppID 和密钥添加到这里。" /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>账号名称</th><th>机构 AppID</th><th>添加时间</th><th>状态</th><th /></tr></thead><tbody>{data.map((account) => <tr key={account.id}>
         <td><b>{account.name}</b>{account.isPrimary && <small style={{ display: "block", color: "var(--green)" }}>主账号</small>}</td>
        <td><code>{account.appid}</code></td>
        <td>{formatDate(account.createdAt, true)}</td>
        <td>{account.active ? "已启用" : "已停用"}</td>
        <td><div className="table-actions">
          <button type="button" className="button button-compact button-secondary" onClick={() => openEdit(account)}>编辑</button>
          <button type="button" className="button button-compact button-ghost" onClick={() => remove(account)}><Trash2 size={15} />删除</button>
        </div></td>
      </tr>)}</tbody></table></div>}
     </section>
     <section className="panel table-panel" style={{ marginTop: 18 }}><header className="panel-header padded"><div><p className="eyebrow">历史数据</p><h2>商品链接校正</h2></div><button type="button" className="button button-secondary" disabled={startingCorrection} onClick={() => startCorrection("start")}><RefreshCw size={16} />{startingCorrection ? "正在启动…" : "校正全部在用商品"}</button></header>{correction.loading ? <LoadingState /> : correction.error ? <ErrorState message={correction.error} retry={correction.reload} /> : !correction.data?.runs.length ? <EmptyState title="尚未执行历史校正" description="任务会使用全部已启用联盟机构账号获取真实推广链接。" /> : <div style={{ padding: "0 18px 18px", display: "grid", gap: 12 }}>{correction.data.runs.map((run) => <button type="button" className="correction-run" key={run.id} onClick={() => setCorrectionRunId(run.id)}><span><b>{run.status === "pending" || run.status === "running" ? "校正中" : run.status === "failed" ? "任务失败" : "已完成"}</b><small>{formatDate(run.createdAt, true)}</small></span><span>{run.processedCount} / {run.totalCount} · 成功 {run.successCount} · 失败 {run.failedCount}</span></button>)}{correction.data.items.length > 0 && <div className="correction-items"><header><b>当前任务结果</b>{correction.data.runs.find((run) => run.id === correction.data.selectedRunId)?.failedCount ? <button type="button" className="button button-compact button-secondary" disabled={startingCorrection} onClick={() => startCorrection("retry", correction.data?.selectedRunId || undefined)}><RefreshCw size={14} />重试失败商品</button> : null}</header>{correction.data.items.map((item) => <div key={item.id}><span><b>{item.sku}</b> · {item.productName}</span><small>{item.status === "success" ? `已更新：${item.newProductUrl || "链接未变化"}` : item.error || "处理中"}</small></div>)}</div>}</div>}</section>
    {editing && <Modal title={editing === "new" ? "添加机构账号" : `编辑机构账号 ${editing.name}`} onClose={() => { if (!saving) setEditing(null); }}>
      <form className="modal-form" onSubmit={submit}>
        <Field label="账号名称" required hint="便于内部区分的名称。"><input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="机构 AppID" required hint="微信开发者平台 → 我的业务 → 联盟带货机构中查看。"><input required maxLength={80} autoCapitalize="none" spellCheck={false} value={draft.appid} onChange={(event) => setDraft({ ...draft, appid: event.target.value.trim() })} /></Field>
        <Field label={editing === "new" ? "AppSecret" : "AppSecret（留空则不修改）"} required={editing === "new"} hint="密钥仅保存在服务器数据库中。"><input type="password" required={editing === "new"} maxLength={200} autoCapitalize="none" spellCheck={false} value={draft.appSecret} onChange={(event) => setDraft({ ...draft, appSecret: event.target.value.trim() })} placeholder={editing === "new" ? "" : "不修改请留空"} /></Field>
         {editing !== "new" && <Field label="启用状态"><label className="check-card" style={{ display: "inline-flex", gap: 8, padding: "8px 12px" }}><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked, isPrimary: event.target.checked ? draft.isPrimary : false })} /><span>{draft.active ? "启用中" : "已停用"}</span></label></Field>}
         <Field label="主账号" hint="最多只能设置一个；主账号获取成功时优先使用其机构推广链接。"><label className="check-card" style={{ display: "inline-flex", gap: 8, padding: "8px 12px" }}><input type="checkbox" checked={draft.isPrimary} disabled={!draft.active} onChange={(event) => setDraft({ ...draft, isPrimary: event.target.checked })} /><span>{draft.isPrimary ? "主账号" : "设为主账号"}</span></label></Field>
        <div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setEditing(null)}>取消</button><button className="button button-primary" disabled={saving || !draft.name.trim() || !draft.appid.trim() || (editing === "new" && !draft.appSecret.trim())}>{saving ? "正在保存…" : "保存"}</button></div>
      </form>
    </Modal>}
     <section className="panel" style={{ padding: 20 }}><header style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}><ShieldCheck size={18} /><b>说明</b></header><p style={{ margin: 0, lineHeight: 1.9, fontSize: 13, color: "var(--muted)" }}>联盟带货机构账号用于获取真实推广链接、好评率和店铺评分；商品 ID 只使用达人橱窗接口返回的 product_id。多个账号同时成功时，推广链接按主账号和服务费率规则选择，店铺信息随最终选中的机构更新。</p></section>
  </>;
}
