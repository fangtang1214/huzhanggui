"use client";

import { FormEvent, useState } from "react";
import { Edit3, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { apiFetch, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader } from "../ui";

type User = {
  id: string;
  username: string;
  name: string;
  departmentId: string;
  departmentName: string;
  permissions: string[];
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string;
  createdAt: string;
};

type UserForm = { username: string; name: string; password: string; departmentId: string; permissions: string[]; mustChangePassword: boolean };
const blankForm = (departmentId = ""): UserForm => ({ username: "", name: "", password: "", departmentId, permissions: [], mustChangePassword: true });

export function UsersView() {
  const { lookups, can, refreshLookups, user: currentUser } = useAppData(); const toast = useToast();
  const { data, loading, error, reload } = useRemote<User[]>("/api/users");
  const [open, setOpen] = useState(false); const [editing, setEditing] = useState<User | null>(null); const [saving, setSaving] = useState(false); const [form, setForm] = useState<UserForm>(blankForm());

  function show(item?: User) {
    setEditing(item || null);
    setForm(item ? { username: item.username, name: item.name, password: "", departmentId: item.departmentId, permissions: item.permissions, mustChangePassword: item.mustChangePassword } : blankForm(lookups?.departments[0]?.id || ""));
    setOpen(true);
  }

  function canEditPermission(key: string) {
    if (editing?.isSuperAdmin) return false;
    if (currentUser.isSuperAdmin) return true;
    if (editing?.id === currentUser.id || key === "users:manage") return false;
    return currentUser.permissions.includes(key);
  }

  function togglePermission(key: string) {
    if (!canEditPermission(key)) return;
    setForm((value) => ({ ...value, permissions: value.permissions.includes(key) ? value.permissions.filter((item) => item !== key) : [...value.permissions, key] }));
  }

  function toggleGroup(keys: string[]) {
    const editable = keys.filter(canEditPermission); if (!editable.length) return;
    const allSelected = editable.every((key) => form.permissions.includes(key));
    setForm((value) => ({ ...value, permissions: allSelected ? value.permissions.filter((key) => !editable.includes(key)) : Array.from(new Set([...value.permissions, ...editable])) }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try {
      await apiFetch(editing ? `/api/users/${editing.id}` : "/api/users", { method: editing ? "PATCH" : "POST", body: JSON.stringify(form) });
      toast(editing ? "账号已修改" : "账号已创建"); setOpen(false); await Promise.all([reload(), refreshLookups()]);
    } catch (reason) { toast(reason instanceof Error ? reason.message : "保存失败", "error"); } finally { setSaving(false); }
  }

  async function remove(item: User) {
    if (!confirm(`确定停用账号“${item.username}”吗？`)) return;
    try { await apiFetch(`/api/users/${item.id}`, { method: "DELETE" }); toast("账号已停用"); await reload(); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "停用失败", "error"); }
  }

  const canManage = can("users:manage");
  return <>
    <PageHeader eyebrow="一人一账号" title="账号与权限" description="每个账号直接配置功能权限；拥有查看权限的账号均可查看全公司的业务数据。" actions={canManage && <button className="button button-primary" onClick={() => show()}><Plus size={17} />创建账号</button>} />
    <section className="panel table-panel">{loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.length ? <EmptyState title="暂无账号" /> : <><div className="data-table-wrap"><table className="data-table"><thead><tr><th>姓名 / 账号</th><th>所属部门</th><th>账号权限</th><th>最后登录</th><th>状态</th><th /></tr></thead><tbody>{data.map((item) => {
      const editable = canManage && (!item.isSuperAdmin || currentUser.isSuperAdmin);
      return <tr key={item.id}><td><div className="user-cell"><span className="avatar">{item.name.slice(0, 1)}</span><div><b>{item.name}</b><small>@{item.username}</small></div></div></td><td>{item.departmentName}</td><td>{item.isSuperAdmin ? <span className="role-chip"><ShieldCheck size={14} />超级管理员 · 全部权限</span> : <span className="soft-badge">{item.permissions.length} 项权限</span>}</td><td>{item.lastLoginAt ? formatDate(item.lastLoginAt, true) : "从未登录"}</td><td>{item.mustChangePassword ? <span className="soft-badge warning">首次登录需改密码</span> : <span className="soft-badge success">正常</span>}</td><td>{editable && <div className="table-actions"><button className="icon-button" onClick={() => show(item)} title="编辑账号与权限"><Edit3 size={16} /></button>{item.id !== currentUser.id && !item.isSuperAdmin && <button className="icon-button danger" onClick={() => remove(item)} title="停用"><Trash2 size={16} /></button>}</div>}</td></tr>;
    })}</tbody></table></div><div className="mobile-record-list">{data.map((item) => { const editable = canManage && (!item.isSuperAdmin || currentUser.isSuperAdmin); return <article className="mobile-record compact" key={item.id}><div className="user-cell"><span className="avatar">{item.name.slice(0, 1)}</span><div><b>{item.name}</b><small>@{item.username} · {item.departmentName} · {item.isSuperAdmin ? "全部权限" : `${item.permissions.length} 项权限`}</small></div></div>{editable && <button className="icon-button" onClick={() => show(item)} aria-label={`编辑 ${item.username}`}><Edit3 size={16} /></button>}</article>; })}</div></>}</section>

    {open && <Modal title={editing ? `编辑账号 ${editing.username}` : "创建账号"} onClose={() => { if (!saving) setOpen(false); }} wide><form className="modal-form" onSubmit={submit}><div className="form-grid"><Field label="登录账号" required><input autoFocus value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></Field><Field label="姓名" required><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="所属部门" required><select value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value })}><option value="">请选择</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label={editing ? "重置密码" : "初始密码"} required={!editing} hint={editing ? "不修改密码请留空" : "至少 8 位，建议字母、数字和符号组合"}><div className="input-prefix"><KeyRound size={17} /><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required={!editing} /></div></Field></div><label className="switch-row"><input type="checkbox" checked={form.mustChangePassword} onChange={(event) => setForm({ ...form, mustChangePassword: event.target.checked })} /><span>下次登录时提醒修改密码</span></label>
      {editing?.isSuperAdmin ? <div className="super-admin-permission-note"><ShieldCheck size={22} /><div><b>固定拥有全部权限</b><p>超级管理员权限由系统保护，不能修改或停用。</p></div></div> : <div className="permission-matrix account-permission-matrix"><header><div><b>账号功能权限</b><p>{editing?.id === currentUser.id && !currentUser.isSuperAdmin ? "不能修改自己的权限" : "新账号默认不授予任何权限，请按需勾选"}</p></div><span>已选择 {form.permissions.length} 项</span></header>{lookups?.permissionGroups.map((group) => { const keys = group.items.map((item) => item.key); const editableKeys = keys.filter(canEditPermission); return <section key={group.label}><div className="permission-group-title"><label className={!editableKeys.length ? "permission-locked" : ""}><input type="checkbox" disabled={!editableKeys.length} checked={editableKeys.length > 0 && editableKeys.every((key) => form.permissions.includes(key))} onChange={() => toggleGroup(keys)} /><b>{group.label}</b></label></div><div className="permission-items">{group.items.map((item) => { const allowed = canEditPermission(item.key); return <label className={`${form.permissions.includes(item.key) ? "checked" : ""} ${!allowed ? "permission-locked" : ""}`} key={item.key}><input type="checkbox" disabled={!allowed} checked={form.permissions.includes(item.key)} onChange={() => togglePermission(item.key)} /><span>{item.label}</span>{!allowed && <small>不可调整</small>}</label>; })}</div></section>; })}</div>}
      <div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setOpen(false)}>取消</button><button className="button button-primary" disabled={saving}>{saving ? "保存中…" : "保存账号"}</button></div></form></Modal>}
  </>;
}
