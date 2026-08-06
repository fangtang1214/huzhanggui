"use client";

import { FormEvent, useState } from "react";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { apiFetch, formatDate, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader } from "../ui";

type LeagueAccount = { id: string; name: string; appid: string; active: boolean; createdAt: string; createdByName?: string | null; };

const blankDraft = { name: "", appid: "", appSecret: "", active: true };

export function LeagueAccountsView() {
  const toast = useToast();
  const { data, loading, error, reload } = useRemote<LeagueAccount[]>("/api/league-accounts");
  const [editing, setEditing] = useState<LeagueAccount | "new" | null>(null);
  const [draft, setDraft] = useState(blankDraft);
  const [saving, setSaving] = useState(false);

  function openNew() { setDraft(blankDraft); setEditing("new"); }
  function openEdit(account: LeagueAccount) { setDraft({ name: account.name, appid: account.appid, appSecret: "", active: account.active }); setEditing(account); }

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

  return <>
    <PageHeader eyebrow="系统管理" title="联盟带货机构" description="配置联盟带货机构的 AppID 与密钥后，可在橱窗管理中同步商品的好评率与店铺评分。" actions={<button className="button button-primary" onClick={openNew}><Plus size={17} />添加机构账号</button>} />
    <section className="panel table-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.length ? <EmptyState title="尚未配置机构账号" description="在微信开发者平台注册联盟带货机构后，把 AppID 和密钥添加到这里。" /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>账号名称</th><th>机构 AppID</th><th>添加时间</th><th>状态</th><th /></tr></thead><tbody>{data.map((account) => <tr key={account.id}>
        <td><b>{account.name}</b></td>
        <td><code>{account.appid}</code></td>
        <td>{formatDate(account.createdAt, true)}</td>
        <td>{account.active ? "已启用" : "已停用"}</td>
        <td><div className="table-actions">
          <button type="button" className="button button-compact button-secondary" onClick={() => openEdit(account)}>编辑</button>
          <button type="button" className="button button-compact button-ghost" onClick={() => remove(account)}><Trash2 size={15} />删除</button>
        </div></td>
      </tr>)}</tbody></table></div>}
    </section>
    {editing && <Modal title={editing === "new" ? "添加机构账号" : `编辑机构账号 ${editing.name}`} onClose={() => { if (!saving) setEditing(null); }}>
      <form className="modal-form" onSubmit={submit}>
        <Field label="账号名称" required hint="便于内部区分的名称。"><input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="机构 AppID" required hint="微信开发者平台 → 我的业务 → 联盟带货机构中查看。"><input required maxLength={80} autoCapitalize="none" spellCheck={false} value={draft.appid} onChange={(event) => setDraft({ ...draft, appid: event.target.value.trim() })} /></Field>
        <Field label={editing === "new" ? "AppSecret" : "AppSecret（留空则不修改）"} required={editing === "new"} hint="密钥仅保存在服务器数据库中。"><input type="password" required={editing === "new"} maxLength={200} autoCapitalize="none" spellCheck={false} value={draft.appSecret} onChange={(event) => setDraft({ ...draft, appSecret: event.target.value.trim() })} placeholder={editing === "new" ? "" : "不修改请留空"} /></Field>
        {editing !== "new" && <Field label="启用状态"><label className="check-card" style={{ display: "inline-flex", gap: 8, padding: "8px 12px" }}><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "启用中" : "已停用"}</span></label></Field>}
        <div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setEditing(null)}>取消</button><button className="button button-primary" disabled={saving || !draft.name.trim() || !draft.appid.trim() || (editing === "new" && !draft.appSecret.trim())}>{saving ? "正在保存…" : "保存"}</button></div>
      </form>
    </Modal>}
    <section className="panel" style={{ padding: 20 }}><header style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}><ShieldCheck size={18} /><b>说明</b></header><p style={{ margin: 0, lineHeight: 1.9, fontSize: 13, color: "var(--muted)" }}>联盟带货机构账号用于调取商品好评分和店铺评分数据。开通流程与带货助手类似：登录微信开发者平台 → 我的业务 → 联盟带货机构 → AppID / Secret → 配置 IP 白名单 → 添加到上方表格。配置完成后，到「橱窗管理」页面点击「同步评分」即可。</p></section>
  </>;
}
