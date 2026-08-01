"use client";

import { FormEvent, useState } from "react";
import { ClipboardList, Database, Download, HardDrive, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { apiFetch, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, Field, LoadingState, PageHeader, Pagination } from "../ui";

type Audit = { id: string; action: string; entityType: string; entityId?: string; summary: string; changes?: unknown; ipAddress?: string; createdAt: string; userName?: string; username?: string; departmentName?: string };
type AuditData = { rows: Audit[]; total: number; page: number; pageSize: number };

export function AuditsView() {
  const [search, setSearch] = useState(""); const [page, setPage] = useState(1); const query = new URLSearchParams({ search, page: String(page) }).toString(); const { data, loading, error, reload } = useRemote<AuditData>(`/api/audits?${query}`);
  return <><PageHeader eyebrow="不可省略的痕迹" title="系统操作日志" description="商品修改、样品流转、账号权限和数据备份等操作均自动记录。" />
    <section className="toolbar"><div className="search-box"><ClipboardList size={18} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索操作内容、姓名或账号" /></div></section>
    <section className="panel table-panel">{loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.rows.length ? <EmptyState title="暂无操作日志" /> : <><div className="audit-list">{data.rows.map((item) => <article key={item.id}><span className="audit-icon"><ClipboardList size={17} /></span><div><b>{item.summary}</b><p>{item.userName || "系统 / 未知账号"}{item.departmentName ? ` · ${item.departmentName}` : ""}</p><small>{formatDate(item.createdAt, true)}{item.ipAddress ? ` · ${item.ipAddress}` : ""}</small></div><span className="audit-action">{item.action}</span></article>)}</div><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} /></>}</section>
  </>;
}

type Backup = { name: string; size: number; createdAt: string };
function fileSize(bytes: number) { if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export function BackupsView() {
  const { can } = useAppData(); const toast = useToast(); const { data, loading, error, reload } = useRemote<Backup[]>("/api/backups"); const [saving, setSaving] = useState(false);
  async function create() { setSaving(true); try { await apiFetch("/api/backups", { method: "POST" }); toast("数据库备份已创建"); await reload(); } catch (reason) { toast(reason instanceof Error ? reason.message : "备份失败", "error"); } finally { setSaving(false); } }
  async function remove(item: Backup) { if (!confirm(`确定删除备份 ${item.name} 吗？`)) return; try { await apiFetch(`/api/backups/${item.name}`, { method: "DELETE" }); toast("备份已删除"); await reload(); } catch (reason) { toast(reason instanceof Error ? reason.message : "删除失败", "error"); } }
  return <><PageHeader eyebrow="30 天滚动保留" title="数据库备份" description="服务器每天自动备份一次并删除 30 天前的数据，也可在此手动备份和下载。" actions={can("backups:manage") && <button className="button button-primary" onClick={create} disabled={saving}><Plus size={17} />{saving ? "正在备份…" : "立即备份"}</button>} />
    <section className="backup-summary"><article className="panel"><span className="summary-icon icon-green"><ShieldCheck size={22} /></span><div><b>每日自动备份</b><p>每天凌晨 03:00（北京时间）执行</p></div></article><article className="panel"><span className="summary-icon icon-blue"><HardDrive size={22} /></span><div><b>保留最近 30 天</b><p>图片使用外链，不进入数据库备份</p></div></article><article className="panel"><span className="summary-icon icon-amber"><Database size={22} /></span><div><b>{data?.length || 0} 个备份</b><p>可下载到本地长期保存</p></div></article></section>
    <section className="panel table-panel">{loading ? <LoadingState /> : error ? <ErrorState message={error} retry={reload} /> : !data?.length ? <EmptyState title="还没有备份文件" description="部署后自动备份服务会每天生成，也可点击立即备份。" /> : <div className="backup-list">{data.map((item) => <article key={item.name}><span className="backup-file"><Database size={20} /></span><div><b>{item.name}</b><small>{formatDate(item.createdAt, true)} · {fileSize(item.size)}</small></div>{can("backups:manage") && <div><a className="icon-button" href={`/api/backups/${item.name}`} title="下载"><Download size={17} /></a><button className="icon-button danger" onClick={() => remove(item)} title="删除"><Trash2 size={17} /></button></div>}</article>)}</div>}</section>
  </>;
}

export function ProfileView() {
  const { user } = useAppData(); const toast = useToast(); const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" }); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); if (form.newPassword !== form.confirmPassword) { toast("两次输入的新密码不一致", "error"); return; } setSaving(true); try { await apiFetch("/api/auth/me", { method: "PATCH", body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) }); toast("密码已修改"); setForm({ currentPassword: "", newPassword: "", confirmPassword: "" }); } catch (reason) { toast(reason instanceof Error ? reason.message : "修改失败", "error"); } finally { setSaving(false); } }
  return <><PageHeader eyebrow="账号安全" title="我的账号" description="查看当前所属部门和角色，或修改自己的登录密码。" />
    <div className="profile-grid"><section className="panel profile-card"><span className="profile-avatar">{user.name.slice(0, 1)}</span><h2>{user.name}</h2><p>@{user.username}</p><dl><div><dt>所属部门</dt><dd>{user.departmentName}</dd></div><div><dt>当前角色</dt><dd>{user.roleName}</dd></div><div><dt>数据范围</dt><dd>{user.dataScope === "all" ? "全公司" : "本部门相关"}</dd></div></dl></section><section className="panel password-card"><div className="password-head"><span><KeyRound size={21} /></span><div><h2>修改登录密码</h2><p>新密码至少 8 位，建议包含字母、数字和符号。</p></div></div><form onSubmit={submit}><Field label="当前密码" required><input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} /></Field><Field label="新密码" required><input type="password" autoComplete="new-password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} /></Field><Field label="再次输入新密码" required><input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} /></Field><button className="button button-primary" disabled={saving}>{saving ? "正在修改…" : "修改密码"}</button></form></section></div>
  </>;
}
