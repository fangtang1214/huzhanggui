"use client";

import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, ClipboardList, Database, Download, FileSpreadsheet, HardDrive, KeyRound, Link2, Plus, RefreshCw, Send, ServerCog, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
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

type UpdateStatus = { available: boolean; state: "idle" | "queued" | "running" | "succeeded" | "failed"; requestedAt?: string; startedAt?: string; finishedAt?: string; versionBefore?: string; versionAfter?: string; exitCode?: number; failureReason?: string };
const UPDATE_COPY: Record<UpdateStatus["state"], { label: string; description: string }> = {
  idle: { label: "可以更新", description: "系统已准备好接收更新请求。" },
  queued: { label: "等待执行", description: "更新请求已提交，服务器即将开始处理。" },
  running: { label: "正在更新", description: "服务器正在备份数据、下载代码并重新构建网站，期间可能短暂无法访问。" },
  succeeded: { label: "更新完成", description: "网站已经更新并恢复运行，可以刷新页面使用新版本。" },
  failed: { label: "更新失败", description: "服务器未能完成更新，原有数据不会因此删除；具体原因会显示在下方。" },
};

export function SystemUpdateView() {
  const { user } = useAppData(); const toast = useToast(); const { data, loading, error, reload, setData } = useRemote<UpdateStatus>("/api/system/update"); const [submitting, setSubmitting] = useState(false);
  const active = data?.state === "queued" || data?.state === "running";
  useEffect(() => { if (!active) return; let cancelled = false; let timer: number; const poll = async () => { await reload(); if (!cancelled) timer = window.setTimeout(poll, 3000); }; timer = window.setTimeout(poll, 3000); return () => { cancelled = true; window.clearTimeout(timer); }; }, [active, reload]);
  if (!user.isSuperAdmin) return <ErrorState message="仅超级管理员可以使用系统更新" />;
  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} retry={reload} />;
  const status = data || { available: false, state: "idle" as const }; const copy = UPDATE_COPY[status.state];
  async function update() {
    if (!confirm("更新期间网站可能有几分钟无法访问。系统会先自动备份数据库，确定立即更新吗？")) return;
    setSubmitting(true);
    try { const next = await apiFetch<UpdateStatus>("/api/system/update", { method: "POST" }); setData(next); toast("更新请求已提交，请保持此页面打开"); }
    catch (reason) { toast(reason instanceof Error ? reason.message : "更新请求提交失败", "error"); }
    finally { setSubmitting(false); }
  }
  return <><PageHeader eyebrow="仅超级管理员" title="系统更新" description="从 GitHub 获取最新版本，自动备份数据库并重新部署网站。" />
    <section className="panel system-update-card"><div className={`update-state state-${status.state}`}><span>{status.state === "succeeded" ? <CheckCircle2 size={27} /> : status.state === "failed" ? <CircleAlert size={27} /> : <ServerCog size={27} />}</span><div><p className="eyebrow">当前状态</p><h2>{copy.label}</h2><p>{copy.description}</p></div>{active && <RefreshCw className="spin" size={24} />}</div>
      <dl className="update-details"><div><dt>更新前版本</dt><dd>{status.versionBefore || "—"}</dd></div><div><dt>更新后版本</dt><dd>{status.versionAfter || "—"}</dd></div><div><dt>请求时间</dt><dd>{formatDate(status.requestedAt, true)}</dd></div><div><dt>完成时间</dt><dd>{formatDate(status.finishedAt, true)}</dd></div></dl>
      {status.state === "failed" && status.failureReason && <div className="update-failure"><b>失败原因{status.exitCode !== undefined ? `（代码 ${status.exitCode}）` : ""}</b><pre>{status.failureReason}</pre></div>}
      {error && data && <p className="update-reconnecting">网站正在重启，暂时无法读取进度，系统会自动重试连接。</p>}
      {!status.available && <p className="update-unavailable"><TriangleAlert size={18} />网页更新服务尚未安装，请在服务器手动运行一次更新脚本后再使用。</p>}
      <div className="update-actions"><button className="button button-primary" onClick={update} disabled={!status.available || active || submitting}><RefreshCw size={17} />{submitting ? "正在提交…" : active ? "更新进行中…" : "立即更新"}</button>{status.state === "succeeded" && <button className="button button-secondary" onClick={() => window.location.reload()}>刷新页面</button>}</div>
      <p className="update-safety"><ShieldCheck size={18} /><span><b>安全更新</b> 更新请求只能由超级管理员提交；执行更新的宿主机服务不会向网站开放 Docker 或系统命令权限。</span></p>
    </section></>;
}

type WecomSheetStatus = {
  configured: boolean;
  updatedAt?: string | null;
  activeProductCount: number;
  totalProductCount: number;
  mappedProductCount: number;
  intervalMinutes: number;
  fields: string[];
  syncStatus: "idle" | "pending" | "running" | "failed";
  syncRequestedAt?: string | null;
  syncStartedAt?: string | null;
  syncedAt?: string | null;
  syncError?: string | null;
  totalCount: number;
  progressCount: number;
  addedCount: number;
  updatedCount: number;
  imageFailedCount: number;
  imageError?: string | null;
};

export function WecomSheetSyncView() {
  const { user } = useAppData();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useRemote<WecomSheetStatus>("/api/system/wecom-sheet");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ webhookUrl: "", exampleData: "" });

  const syncing = data?.syncStatus === "pending" || data?.syncStatus === "running";
  useEffect(() => {
    if (!syncing) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => { await reload(); if (!cancelled) timer = window.setTimeout(poll, 2500); };
    timer = window.setTimeout(poll, 2500);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [syncing, reload]);

  if (!user.isSuperAdmin) return <ErrorState message="仅超级管理员可以配置表格同步" />;
  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} retry={reload} />;
  const status = data || { configured: false, activeProductCount: 0, totalProductCount: 0, mappedProductCount: 0, intervalMinutes: 30, fields: [], syncStatus: "idle" as const, totalCount: 0, progressCount: 0, addedCount: 0, updatedCount: 0, imageFailedCount: 0 };
  const active = status.syncStatus === "pending" || status.syncStatus === "running";
  const stateTitle = status.syncStatus === "pending" ? "等待同步" : status.syncStatus === "running" ? "正在同步" : status.syncStatus === "failed" ? "同步失败" : status.syncedAt ? "同步正常" : status.configured ? "等待首次同步" : "尚未配置";
  const stateDescription = status.syncStatus === "pending" ? "后台服务即将开始处理商品数据" : status.syncStatus === "running" ? `已处理 ${status.progressCount} / ${status.totalCount} 件商品` : status.syncStatus === "failed" ? "连接或数据格式出现问题，请查看右侧提示" : status.syncedAt ? status.imageFailedCount ? `${status.imageFailedCount} 张主图暂未显示，下次会自动重试` : `每 ${status.intervalMinutes} 分钟自动检查商品变化` : status.configured ? "连接已保存，正在等待后台服务" : "连接后才会向智能表格推送商品档案";

  async function configure(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const next = await apiFetch<WecomSheetStatus>("/api/system/wecom-sheet", { method: "PUT", body: JSON.stringify(form) });
      setData(next);
      setForm({ webhookUrl: "", exampleData: "" });
      setEditing(false);
      toast("连接已保存，首次商品同步已排队");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "保存连接失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function disable() {
    if (!confirm("停用后网站不会再更新智能表格，表格中已经同步的行会保留。确定停用吗？")) return;
    setSaving(true);
    try {
      const next = await apiFetch<WecomSheetStatus>("/api/system/wecom-sheet", { method: "DELETE" });
      setData(next);
      setEditing(false);
      toast("智能表格同步已停用");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "停用失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function syncNow() {
    setSaving(true);
    try {
      const next = await apiFetch<WecomSheetStatus>("/api/system/wecom-sheet", { method: "POST" });
      setData(next);
      toast(active ? "已追加一次同步任务" : "商品同步已排队");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "同步请求失败", "error");
    } finally {
      setSaving(false);
    }
  }

  return <><PageHeader eyebrow="企业微信智能表格" title="商品库自动同步" description="通过“接收外部数据”Webhook 推送商品档案，每 30 分钟自动检查一次变化。" />
    <div className="sheet-sync-layout">
      <section className="panel sheet-sync-card">
        <div className={`sheet-sync-state ${status.configured && status.syncStatus !== "failed" ? "enabled" : "disabled"}`}><span>{status.syncStatus === "failed" ? <CircleAlert size={27} /> : <FileSpreadsheet size={27} />}</span><div><p className="eyebrow">同步状态</p><h2>{stateTitle}</h2><p>{stateDescription}</p></div>{status.syncStatus === "running" && <RefreshCw className="spin" size={22} />}</div>
        {status.syncStatus === "running" && <div className="sheet-sync-progress"><i style={{ width: `${status.totalCount ? Math.min(100, status.progressCount / status.totalCount * 100) : 8}%` }} /></div>}
        <dl className="sheet-sync-details"><div><dt>在用商品</dt><dd>{status.activeProductCount}</dd></div><div><dt>已建立同步</dt><dd>{status.mappedProductCount}</dd></div><div><dt>最近同步</dt><dd>{formatDate(status.syncedAt, true)}</dd></div><div><dt>自动频率</dt><dd>每 {status.intervalMinutes} 分钟</dd></div><div><dt>上次新增</dt><dd>{status.addedCount}</dd></div><div><dt>上次更新</dt><dd>{status.updatedCount}</dd></div><div><dt>图片失败</dt><dd>{status.imageFailedCount}</dd></div><div><dt>图片处理</dt><dd>自动压缩</dd></div></dl>
        {status.syncError && <p className="sheet-sync-error"><CircleAlert size={18} /><span><b>同步没有完成</b>{status.syncError}</span></p>}
        {!status.syncError && status.imageFailedCount > 0 && <p className="sheet-sync-notice"><TriangleAlert size={18} /><span><b>部分图片暂未同步</b>{status.imageError || `${status.imageFailedCount} 张主图下载或转换失败，下次同步会自动重试。`}</span></p>}
        {status.configured && <div className="update-actions"><button className="button button-primary" onClick={syncNow} disabled={saving}><Send size={17} />{saving ? "正在提交…" : active ? "再同步一次" : "立即同步"}</button><button className="button button-secondary" onClick={() => setEditing(true)} disabled={active || saving}>更换连接</button><button className="button button-secondary" onClick={disable} disabled={active || saving}>停用</button></div>}
        <p className="update-safety"><ShieldCheck size={18} /><span><b>不会碰手工行</b> 网站只更新自己创建的商品行；归档商品保留原行并标记“已归档”。</span></p>
      </section>

      <section className="panel sheet-sync-guide">
        <header><div><p className="eyebrow">安全连接</p><h2>{status.configured && !editing ? "智能表格已连接" : "粘贴 Webhook 和示例数据"}</h2></div></header>
        {status.configured && !editing ? <div className="sheet-sync-connected"><span><Link2 size={25} /></span><h3>连接信息已加密保存</h3><p>首次同步会新增全部在用商品，之后只推送发生变化的商品；主图会自动压缩并显示，同时保留原始链接。</p><ol><li>商品新增或修改后，最迟约 {status.intervalMinutes} 分钟进入表格。</li><li>也可以点击左侧“立即同步”马上检查。</li><li>若在企业微信里重建字段，请点击“更换连接”并重新粘贴。</li></ol></div> : <form className="sheet-sync-form" onSubmit={configure}>
          <label><span>Webhook 地址</span><small>在“接收外部数据”页面点击复制；不要发到聊天或公开网页。</small><input type="password" autoComplete="off" placeholder="https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=…" value={form.webhookUrl} onChange={(event) => setForm({ ...form, webhookUrl: event.target.value })} required /></label>
          <label><span>示例数据</span><small>复制页面中的完整 JSON，用于识别每一列的字段编号。</small><textarea rows={12} spellCheck={false} placeholder={'{\n  "schema": { … },\n  "add_records": [ … ]\n}'} value={form.exampleData} onChange={(event) => setForm({ ...form, exampleData: event.target.value })} required /></label>
          <p className="sheet-sync-notice"><TriangleAlert size={18} />保存后会立即用真实商品做首次同步，不会生成额外的测试行。</p>
          <div className="update-actions"><button className="button button-primary" disabled={saving}><Link2 size={17} />{saving ? "正在保存…" : "保存并开始同步"}</button>{status.configured && <button type="button" className="button button-secondary" onClick={() => { setEditing(false); setForm({ webhookUrl: "", exampleData: "" }); }} disabled={saving}>取消</button>}</div>
        </form>}
      </section>
    </div>
    <section className="panel sheet-sync-fields"><div><p className="eyebrow">固定字段结构</p><h2>同步字段</h2><p>“主图”自动显示商品档案第一张图片，“主图链接”保留原始地址；归档商品会保留并标记状态。</p></div><ol>{status.fields.map((field, index) => <li key={field}><i>{String.fromCharCode(65 + index)}</i><span>{field}</span></li>)}</ol></section>
  </>;
}

export function ProfileView() {
  const { user } = useAppData(); const toast = useToast(); const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" }); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); if (form.newPassword !== form.confirmPassword) { toast("两次输入的新密码不一致", "error"); return; } setSaving(true); try { await apiFetch("/api/auth/me", { method: "PATCH", body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) }); toast("密码已修改"); setForm({ currentPassword: "", newPassword: "", confirmPassword: "" }); } catch (reason) { toast(reason instanceof Error ? reason.message : "修改失败", "error"); } finally { setSaving(false); } }
  return <><PageHeader eyebrow="账号安全" title="我的账号" description="查看当前所属部门和账号权限，或修改自己的登录密码。" />
    <div className="profile-grid"><section className="panel profile-card"><span className="profile-avatar">{user.name.slice(0, 1)}</span><h2>{user.name}</h2><p>@{user.username}</p><dl><div><dt>所属部门</dt><dd>{user.departmentName}</dd></div><div><dt>账号类型</dt><dd>{user.isSuperAdmin ? "超级管理员" : "普通账号"}</dd></div><div><dt>功能权限</dt><dd>{user.isSuperAdmin ? "全部权限" : `已授权 ${user.permissions.length} 项`}</dd></div></dl></section><section className="panel password-card"><div className="password-head"><span><KeyRound size={21} /></span><div><h2>修改登录密码</h2><p>新密码至少 8 位，建议包含字母、数字和符号。</p></div></div><form onSubmit={submit}><Field label="当前密码" required><input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} /></Field><Field label="新密码" required><input type="password" autoComplete="new-password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} /></Field><Field label="再次输入新密码" required><input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} /></Field><button className="button button-primary" disabled={saving}>{saving ? "正在修改…" : "修改密码"}</button></form></section></div>
  </>;
}
