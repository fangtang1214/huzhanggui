"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, CheckCircle2, CircleAlert, Copy, ExternalLink, FilePenLine, Filter, Link2, MessagesSquare, RefreshCw, Search, Store, UserRound } from "lucide-react";
import { LINK_ISSUE_STATUS_META, LINK_ISSUE_STATUSES, type LinkIssueStatus } from "@/lib/link-issues";
import { apiFetch, copyToClipboard, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader, Pagination, ProductImage } from "../ui";

type LinkIssue = {
  id: string;
  productId: string;
  previousIssueId?: string;
  oldProductUrl?: string;
  reportNote: string;
  status: LinkIssueStatus;
  newProductUrl?: string;
  resolutionNote?: string;
  reportedBy?: string;
  reportedByName?: string;
  reportedDepartmentId: string;
  reportedDepartmentName: string;
  resolvedByName?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  sku: string;
  productName: string;
  storeName?: string;
  supplyChain?: string;
  imageUrls: string[];
  canCancel: boolean;
};

type LinkIssueList = { rows: LinkIssue[]; total: number; page: number; pageSize: number; canProcess: boolean };
type ResolveForm = { result: "replaced" | "no_change" | "unresolved"; newProductUrl: string; resolutionNote: string };

function issueStatus(status: LinkIssueStatus) {
  const meta = LINK_ISSUE_STATUS_META[status];
  return <span className={`status-badge status-${meta.tone}`}><i />{meta.label}</span>;
}

function handledAgo(value?: string) {
  if (!value) return "此前";
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  return days === 0 ? "今天" : `${days} 天前`;
}

export function LinkIssuesView() {
  const { lookups } = useAppData(); const toast = useToast(); const router = useRouter(); const searchParams = useSearchParams();
  const focusId = searchParams.get("focus") || "";
  const [search, setSearch] = useState(() => searchParams.get("search") || ""); const [departmentId, setDepartmentId] = useState(""); const [status, setStatus] = useState(""); const [page, setPage] = useState(1);
  const [editingIssue, setEditingIssue] = useState<LinkIssue | null>(null); const [resolveForm, setResolveForm] = useState<ResolveForm>({ result: "replaced", newProductUrl: "", resolutionNote: "" });
  const [resubmittingIssue, setResubmittingIssue] = useState<LinkIssue | null>(null); const [reportNote, setReportNote] = useState(""); const [saving, setSaving] = useState(false);
  const query = new URLSearchParams({ search, departmentId, status, page: String(page), ...(focusId ? { focusId } : {}) }).toString();
  const { data, loading, error, reload } = useRemote<LinkIssueList>(`/api/link-issues?${query}`);

  function openResolve(issue: LinkIssue) {
    setEditingIssue(issue);
    setResolveForm({
      result: issue.status === "pending" || issue.status === "cancelled" ? "replaced" : issue.status,
      newProductUrl: issue.newProductUrl || "",
      resolutionNote: issue.resolutionNote || "",
    });
  }

  async function submitResolve(event: FormEvent) {
    event.preventDefault(); if (!editingIssue) return; setSaving(true);
    try {
      await apiFetch(`/api/link-issues/${editingIssue.id}`, { method: "PATCH", body: JSON.stringify({ action: "resolve", ...resolveForm }) });
      toast(editingIssue.status === "pending" ? "问题已处理完成" : "处理结果已更新"); setEditingIssue(null); window.dispatchEvent(new Event("link-issues:changed")); await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "处理失败", "error"); } finally { setSaving(false); }
  }

  async function cancelIssue(issue: LinkIssue) {
    if (!confirm(`确定撤销 ${issue.sku} 的链接报障吗？`)) return;
    try { await apiFetch(`/api/link-issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ action: "cancel" }) }); toast("问题已撤销"); window.dispatchEvent(new Event("link-issues:changed")); await reload(); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "撤销失败", "error"); }
  }

  async function submitAgain(event: FormEvent) {
    event.preventDefault(); if (!resubmittingIssue) return; setSaving(true);
    try {
      const result = await apiFetch<{ id: string; existing: boolean }>("/api/link-issues", { method: "POST", body: JSON.stringify({ productId: resubmittingIssue.productId, previousIssueId: resubmittingIssue.id, note: reportNote }) });
      toast(result.existing ? "该商品已有待处理问题，已为你打开" : "已新增一条链接报障"); setResubmittingIssue(null); setReportNote(""); setSearch(resubmittingIssue.sku); setDepartmentId(""); setStatus(""); setPage(1); window.dispatchEvent(new Event("link-issues:changed"));
      router.replace(`/link-issues?search=${encodeURIComponent(resubmittingIssue.sku)}&focus=${encodeURIComponent(result.id)}`);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "重新提交失败", "error"); } finally { setSaving(false); }
  }

  async function copyText(value: string, label: string) {
    const ok = await copyToClipboard(value); if (ok) toast(`${label}已复制`); else toast("复制失败，请手动选择", "error");
  }

  return <>
    <PageHeader eyebrow="链接协作" title="问题处理" description="直播间与商务共用的问题清单；处理完成的新链接会同步更新商品档案。" />
    <section className="toolbar"><div className="search-box"><Search size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索货号、商品名、店铺、供应链或链接" /></div><div className="toolbar-filters"><div className="select-wrap"><Filter size={16} /><select value={departmentId} onChange={(event) => { setDepartmentId(event.target.value); setPage(1); }}><option value="">全部报障部门</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">全部处理状态</option>{LINK_ISSUE_STATUSES.map((value) => <option value={value} key={value}>{LINK_ISSUE_STATUS_META[value].label}</option>)}</select></div></section>
    <section className="issue-list-panel">
      {loading ? <div className="panel"><LoadingState /></div> : error ? <div className="panel"><ErrorState message={error} retry={reload} /></div> : !data?.rows.length ? <div className="panel"><EmptyState title="没有找到问题记录" description={search || departmentId || status ? "可以更换筛选条件。" : "从商品档案发起链接报障后，会显示在这里。"} /></div> : <>{data.rows.map((issue) => {
        const focused = focusId === issue.id; const pending = issue.status === "pending"; const completed = issue.status === "replaced" || issue.status === "no_change" || issue.status === "unresolved";
        const processedLink = issue.status === "replaced" ? issue.newProductUrl : issue.status === "no_change" ? issue.oldProductUrl : "";
        return <article className={`issue-card ${pending ? "issue-pending" : ""} ${focused ? "issue-focused" : ""}`} id={`issue-${issue.id}`} key={issue.id}>
          {pending && <div className="issue-notice-bar issue-pending-bar"><CircleAlert size={15} /><b>等待商务处理</b><span>请优先核实报障链接并更新处理结果</span></div>}
          {focused && completed && <div className="issue-notice-bar issue-history-bar"><CircleAlert size={16} /><div><b>此问题已在{handledAgo(issue.resolvedAt)}处理过</b><p>请先检查下方的处理后链接是否可用；仍不可用时，可重新提交一条新的报障。</p></div></div>}

          <div className="issue-card-inner">
            <header className="issue-header">
              <ProductImage urls={issue.imageUrls} alt={issue.productName} size="small" />
              <div className="issue-header-info">
                <div className="issue-header-title">
                  <span className="sku-chip">{issue.sku}</span>
                  <h2>{issue.productName}</h2>
                </div>
                <div className="issue-header-extra">
                  <span><Store size={13} />{issue.storeName || "未填店铺"}</span>
                  <span className="issue-header-sep" />
                  <span><MessagesSquare size={13} />供应链：{issue.supplyChain || "未填写"}</span>
                </div>
              </div>
              {issueStatus(issue.status)}
            </header>

            <div className="issue-content">
              <div className="issue-note-box">
                <h4>问题备注</h4>
                <p>{issue.reportNote}</p>
              </div>

              <div className="issue-links-row">
                <div className="issue-link-field">
                  <span className="issue-link-label"><Link2 size={11} />报障链接</span>
                  <code title={issue.oldProductUrl || ""}>{issue.oldProductUrl || "未填写"}</code>
                  {issue.oldProductUrl && <button type="button" onClick={() => copyText(issue.oldProductUrl || "", "商品链接")}><Copy size={12} /></button>}
                </div>
                {processedLink && <div className="issue-link-field issue-link-resolved"><span className="issue-link-label"><CheckCircle2 size={11} />处理后链接</span><code title={processedLink}>{processedLink}</code><button type="button" onClick={() => copyText(processedLink, "处理后链接")}><Copy size={12} /></button></div>}
              </div>

              {issue.resolutionNote && <div className="issue-note-box issue-note-resolution"><h4>处理说明</h4><p>{issue.resolutionNote}</p></div>}
            </div>

            <footer className="issue-footer">
              <div className="issue-meta-row">
                <span><UserRound size={13} />{issue.reportedDepartmentName} · {issue.reportedByName || "未知账号"}</span>
                <span><CalendarDays size={13} />报障于 {formatDate(issue.createdAt, true)}</span>
                {issue.resolvedAt && <span><FilePenLine size={13} />{issue.resolvedByName || "未知商务"} · {formatDate(issue.resolvedAt, true)}</span>}
              </div>
              <div className="issue-actions">
                <LinkToProduct productId={issue.productId} />
                {issue.canCancel && <button type="button" className="button button-ghost button-compact" onClick={() => cancelIssue(issue)}>撤销报障</button>}
                {data.canProcess && issue.status !== "cancelled" && <button type="button" className="button button-secondary button-compact" onClick={() => openResolve(issue)}>{issue.status === "pending" ? "处理问题" : "修改结果"}</button>}
                {focused && completed && <button type="button" className="button button-primary button-compact" onClick={() => { setReportNote(""); setResubmittingIssue(issue); }}><RefreshCw size={14} />重新提交报障</button>}
              </div>
            </footer>
          </div>
        </article>;
      })}<Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} /></>}
    </section>

    {editingIssue && <Modal title={editingIssue.status === "pending" ? "处理链接问题" : "修改处理结果"} onClose={() => { if (!saving) setEditingIssue(null); }}><form className="modal-form" onSubmit={submitResolve}><div className="issue-product-summary"><ProductImage urls={editingIssue.imageUrls} alt={editingIssue.productName} size="small" /><div><b>{editingIssue.productName}</b><span>{editingIssue.sku} · {editingIssue.reportedDepartmentName}</span></div></div><Field label="处理结果" required><div className="issue-result-picker"><label className={resolveForm.result === "replaced" ? "selected" : ""}><input type="radio" name="issueResult" checked={resolveForm.result === "replaced"} onChange={() => setResolveForm({ ...resolveForm, result: "replaced" })} /><b>已更换链接</b><small>同步覆盖商品档案链接</small></label><label className={resolveForm.result === "no_change" ? "selected" : ""}><input type="radio" name="issueResult" checked={resolveForm.result === "no_change"} onChange={() => setResolveForm({ ...resolveForm, result: "no_change" })} /><b>无需更换</b><small>核实后原链接可继续使用</small></label><label className={resolveForm.result === "unresolved" ? "selected" : ""}><input type="radio" name="issueResult" checked={resolveForm.result === "unresolved"} onChange={() => setResolveForm({ ...resolveForm, result: "unresolved" })} /><b>无法处理</b><small>本次任务直接结束</small></label></div></Field>{resolveForm.result === "replaced" && <Field label="新商品链接" required hint="提交后立即同步到商品档案。"><div className="input-prefix"><ExternalLink size={17} /><input type="text" required inputMode="url" autoCapitalize="none" spellCheck={false} value={resolveForm.newProductUrl} onChange={(event) => setResolveForm({ ...resolveForm, newProductUrl: event.target.value })} placeholder="https://... 或 weixinstorehs/..." /></div></Field>}<Field label={resolveForm.result === "replaced" ? "处理备注" : "处理原因"} required={resolveForm.result !== "replaced"} hint={resolveForm.result === "replaced" ? "选填" : "必填"}><textarea rows={4} required={resolveForm.result !== "replaced"} maxLength={2000} value={resolveForm.resolutionNote} onChange={(event) => setResolveForm({ ...resolveForm, resolutionNote: event.target.value })} placeholder={resolveForm.result === "replaced" ? "备注说明（选填）" : "请填写无法更换的具体原因"} /></Field><div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setEditingIssue(null)}>取消</button><button className="button button-primary" disabled={saving}>{saving ? "正在保存…" : "确认处理结果"}</button></div></form></Modal>}

    {resubmittingIssue && <Modal title="重新提交链接报障" onClose={() => { if (!saving) setResubmittingIssue(null); }}><form className="modal-form" onSubmit={submitAgain}><div className="issue-repeat-warning"><CircleAlert size={22} /><div><b>最近一次问题已在{handledAgo(resubmittingIssue.resolvedAt)}处理</b><p>确认商品档案中的最新链接仍不可用后，再提交新的问题记录。上一次记录不会被修改。</p></div></div><Field label="新的问题备注" required><textarea rows={5} required maxLength={2000} value={reportNote} onChange={(event) => setReportNote(event.target.value)} placeholder="请描述最新链接目前出现的问题。" /></Field><div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setResubmittingIssue(null)}>取消</button><button className="button button-primary" disabled={saving || !reportNote.trim()}>{saving ? "正在提交…" : "新增报障记录"}</button></div></form></Modal>}
  </>;
}

function LinkToProduct({ productId }: { productId: string }) {
  return <a className="button button-ghost button-compact" href={`/products/${productId}`}>查看商品档案</a>;
}
