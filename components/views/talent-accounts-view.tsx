"use client";

import { FormEvent, useState } from "react";
import { Plus, RefreshCw, Store, Trash2 } from "lucide-react";
import { apiFetch, formatDate, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader } from "../ui";

type TalentAccount = {
  id: string;
  name: string;
  appid: string;
  active: boolean;
  syncStatus: "idle" | "syncing" | "failed";
  syncError?: string | null;
  syncedAt?: string | null;
  createdAt: string;
  createdByName?: string | null;
  productCount: number;
};

const blankDraft = { name: "", appid: "", appSecret: "", active: true };

export function TalentAccountsView() {
  const toast = useToast();
  const { data, loading, error, reload } = useRemote<TalentAccount[]>("/api/talent-accounts");
  const [editing, setEditing] = useState<TalentAccount | "new" | null>(null);
  const [draft, setDraft] = useState(blankDraft);
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState("");

  function openNew() { setDraft(blankDraft); setEditing("new"); }
  function openEdit(account: TalentAccount) { setDraft({ name: account.name, appid: account.appid, appSecret: "", active: account.active }); setEditing(account); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    try {
      if (editing === "new") {
        await apiFetch("/api/talent-accounts", { method: "POST", body: JSON.stringify(draft) });
        toast("带货账号已添加");
      } else {
        await apiFetch(`/api/talent-accounts/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...draft, appSecret: draft.appSecret || undefined }) });
        toast("带货账号已保存");
      }
      setEditing(null);
      await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "保存失败", "error"); }
    finally { setSaving(false); }
  }

  async function remove(account: TalentAccount) {
    if (!confirm(`确定删除带货账号 ${account.name} 吗？已同步的橱窗商品缓存会一并删除。`)) return;
    try {
      await apiFetch(`/api/talent-accounts/${account.id}`, { method: "DELETE" });
      toast("带货账号已删除");
      await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "删除失败", "error"); }
  }

  async function sync(account: TalentAccount) {
    setSyncingId(account.id);
    try {
      await apiFetch(`/api/talent-accounts/${account.id}/sync`, { method: "POST" });
      toast("已开始同步橱窗商品，稍后可在登记页查看");
    } catch (reason) { toast(reason instanceof Error ? reason.message : "同步失败", "error"); }
    finally { setSyncingId(""); }
  }

  return <>
    <PageHeader eyebrow="系统管理" title="带货账号" description="配置微信小店带货助手的 AppID 与密钥后，登记商品时可直接从橱窗选择商品并自动填入图片、名称与链接。" actions={<button className="button button-primary" onClick={openNew}><Plus size={17} />添加带货账号</button>} />
    <section className="panel table-panel">
      {loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.length ? <EmptyState title="尚未配置带货账号" description="管理员在微信小店带货助手后台开通“开放能力”后，把 AppID 和密钥添加到这里。" /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>账号名称</th><th>带货者 AppID</th><th>橱窗商品</th><th>最近同步</th><th>状态</th><th /></tr></thead><tbody>{data.map((account) => <tr key={account.id}>
        <td><b>{account.name}</b></td>
        <td><code>{account.appid}</code></td>
        <td>{account.productCount} 件</td>
        <td>{account.syncedAt ? formatDate(account.syncedAt, true) : "从未同步"}{account.syncStatus === "failed" && account.syncError && <small style={{ display: "block", color: "var(--red)" }}>{account.syncError}</small>}</td>
        <td>{account.active ? (account.syncStatus === "syncing" ? "同步中…" : "已启用") : "已停用"}</td>
        <td><div className="table-actions">
          <button type="button" className="button button-compact button-secondary" disabled={!account.active || account.syncStatus === "syncing" || syncingId === account.id} onClick={() => sync(account)}><RefreshCw size={15} />{account.syncStatus === "syncing" ? "同步中" : "同步橱窗"}</button>
          <button type="button" className="button button-compact button-secondary" onClick={() => openEdit(account)}>编辑</button>
          <button type="button" className="button button-compact button-ghost" onClick={() => remove(account)}><Trash2 size={15} />删除</button>
        </div></td>
      </tr>)}</tbody></table></div>}
    </section>
    {editing && <Modal title={editing === "new" ? "添加带货账号" : `编辑带货账号 ${editing.name}`} onClose={() => { if (!saving) setEditing(null); }}>
      <form className="modal-form" onSubmit={submit}>
        <Field label="账号名称" required hint="便于内部区分的名称，例如“玲姐-李家和”。"><input required maxLength={100} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="带货者 AppID" required hint="微信开发者平台 → 我的业务 → 带货助手中查看。"><input required maxLength={80} autoCapitalize="none" spellCheck={false} value={draft.appid} onChange={(event) => setDraft({ ...draft, appid: event.target.value.trim() })} /></Field>
        <Field label={editing === "new" ? "AppSecret" : "AppSecret（留空则不修改）"} required={editing === "new"} hint="密钥仅保存在服务器数据库中，保存后界面不再回显。"><input type="password" required={editing === "new"} maxLength={200} autoCapitalize="none" spellCheck={false} value={draft.appSecret} onChange={(event) => setDraft({ ...draft, appSecret: event.target.value.trim() })} placeholder={editing === "new" ? "" : "不修改请留空"} /></Field>
        {editing !== "new" && <Field label="启用状态"><label className="check-card" style={{ display: "inline-flex", gap: 8, padding: "8px 12px" }}><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "启用中" : "已停用"}</span></label></Field>}
        <div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setEditing(null)}>取消</button><button className="button button-primary" disabled={saving || !draft.name.trim() || !draft.appid.trim() || (editing === "new" && !draft.appSecret.trim())}>{saving ? "正在保存…" : "保存"}</button></div>
      </form>
    </Modal>}
    <section className="panel" style={{ padding: 20 }}><header style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}><Store size={18} /><b>开通步骤</b></header><ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9, fontSize: 13, color: "var(--muted)" }}>
      <li>管理员扫码登录微信小店带货助手（store.weixin.qq.com/talent），点击右上角头像 →「开放能力」→ 开通；</li>
      <li>打开微信开发者平台（developers.weixin.qq.com/platform）→ 我的业务 → 带货助手，开通接口能力并复制 AppID 与 Secret；</li>
      <li>在同一页面把本服务器的公网 IP 加入 API IP 白名单；</li>
      <li>把 AppID 与 Secret 添加到上方列表，点击「同步橱窗」拉取商品；</li>
      <li>之后在微信后台新加入橱窗的商品，重新点一次「同步橱窗」即可在登记页选择。</li>
    </ol></section>
  </>;
}
