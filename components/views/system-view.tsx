"use client";

import { FormEvent, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Clipboard, ClipboardCheck, ClipboardList, Database, Download, FileSpreadsheet, HardDrive, KeyRound, Plus, RefreshCw, ServerCog, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { apiFetch, copyToClipboard, formatDate, useAppData, useRemote, useToast } from "../client-utils";
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

type UpdateStatus = { available: boolean; state: "idle" | "queued" | "running" | "succeeded" | "failed"; requestedAt?: string; startedAt?: string; finishedAt?: string; versionBefore?: string; versionAfter?: string };
const UPDATE_COPY: Record<UpdateStatus["state"], { label: string; description: string }> = {
  idle: { label: "可以更新", description: "系统已准备好接收更新请求。" },
  queued: { label: "等待执行", description: "更新请求已提交，服务器即将开始处理。" },
  running: { label: "正在更新", description: "服务器正在备份数据、下载代码并重新构建网站，期间可能短暂无法访问。" },
  succeeded: { label: "更新完成", description: "网站已经更新并恢复运行，可以刷新页面使用新版本。" },
  failed: { label: "更新失败", description: "服务器未能完成更新，原有数据不会因此删除，请登录服务器查看更新日志。" },
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
      {error && data && <p className="update-reconnecting">网站正在重启，暂时无法读取进度，系统会自动重试连接。</p>}
      {!status.available && <p className="update-unavailable"><TriangleAlert size={18} />网页更新服务尚未安装，请在服务器手动运行一次更新脚本后再使用。</p>}
      <div className="update-actions"><button className="button button-primary" onClick={update} disabled={!status.available || active || submitting}><RefreshCw size={17} />{submitting ? "正在提交…" : active ? "更新进行中…" : "立即更新"}</button>{status.state === "succeeded" && <button className="button button-secondary" onClick={() => window.location.reload()}>刷新页面</button>}</div>
      <p className="update-safety"><ShieldCheck size={18} /><span><b>安全更新</b> 更新请求只能由超级管理员提交；执行更新的宿主机服务不会向网站开放 Docker 或系统命令权限。</span></p>
    </section></>;
}

type WecomSheetStatus = {
  enabled: boolean;
  updatedAt?: string | null;
  productCount: number;
  endpointPath: string;
  fields: string[];
  url?: string;
  importFormula?: string;
};

export function WecomSheetSyncView() {
  const { user } = useAppData();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useRemote<WecomSheetStatus>("/api/system/wecom-sheet");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<"url" | "formula" | "">("");

  if (!user.isSuperAdmin) return <ErrorState message="仅超级管理员可以配置表格同步" />;
  if (loading && !data) return <LoadingState />;
  if (error && !data) return <ErrorState message={error} retry={reload} />;
  const status = data || { enabled: false, productCount: 0, endpointPath: "", fields: [] };

  async function generate() {
    if (status.enabled && !confirm("生成新密钥后，之前复制到表格中的同步网址会立即失效。确定继续吗？")) return;
    setSaving(true);
    try {
      const next = await apiFetch<WecomSheetStatus>("/api/system/wecom-sheet", { method: "POST" });
      setData(next);
      setCopied("");
      toast(status.enabled ? "同步密钥已重置，请重新复制公式" : "同步接口已启用");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "生成同步密钥失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function disable() {
    if (!confirm("停用后，已经粘贴到企业微信表格中的同步公式将无法再读取商品库。确定停用吗？")) return;
    setSaving(true);
    try {
      const next = await apiFetch<WecomSheetStatus>("/api/system/wecom-sheet", { method: "DELETE" });
      setData(next);
      setCopied("");
      toast("表格同步接口已停用");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : "停用失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function copy(value: string, kind: "url" | "formula") {
    if (!(await copyToClipboard(value))) return toast("复制失败，请手动选择文字复制", "error");
    setCopied(kind);
    toast(kind === "formula" ? "测试公式已复制" : "商品库网址已复制");
    window.setTimeout(() => setCopied((current) => current === kind ? "" : current), 1800);
  }

  return <><PageHeader eyebrow="企业微信普通在线表格" title="商品库表格同步" description="生成只读商品库网址，测试企业微信在线表格能否从狐掌柜自动读取商品档案。" />
    <div className="sheet-sync-layout">
      <section className="panel sheet-sync-card">
        <div className={`sheet-sync-state ${status.enabled ? "enabled" : "disabled"}`}><span><FileSpreadsheet size={27} /></span><div><p className="eyebrow">同步接口</p><h2>{status.enabled ? "已启用" : "尚未启用"}</h2><p>{status.enabled ? `当前可同步 ${status.productCount} 个未归档商品` : "生成密钥后才会开放只读商品库"}</p></div></div>
        <dl className="sheet-sync-details"><div><dt>商品范围</dt><dd>仅未归档商品</dd></div><div><dt>商品数量</dt><dd>{status.productCount}</dd></div><div><dt>最近配置</dt><dd>{formatDate(status.updatedAt, true)}</dd></div><div><dt>接口权限</dt><dd>只读，不能修改数据</dd></div></dl>
        <div className="update-actions"><button className="button button-primary" onClick={generate} disabled={saving}><KeyRound size={17} />{saving ? "正在处理…" : status.enabled ? "重置并获取新网址" : "生成同步密钥"}</button>{status.enabled && <button className="button button-secondary" onClick={disable} disabled={saving}>停用接口</button>}</div>
        <p className="update-safety"><ShieldCheck size={18} /><span><b>密钥只展示一次</b> 网站只保存不可还原的校验值。若关闭页面前没有保存网址，请重置密钥获取新网址。</span></p>
      </section>

      <section className="panel sheet-sync-guide">
        <header><div><p className="eyebrow">第一阶段测试</p><h2>在空白在线表格中尝试导入</h2></div></header>
        {!status.enabled ? <div className="sheet-sync-empty"><KeyRound size={25} /><p>先在左侧生成同步密钥，随后这里会显示测试公式。</p></div> : status.importFormula && status.url ? <div className="sheet-sync-generated">
          <div><b>1. 先检查商品库网址</b><p>打开网址后，应看到以“货号、商品名称、价格”开头的 CSV 内容。</p><div className="sheet-sync-code"><code>{status.url}</code><button className="icon-button" onClick={() => copy(status.url!, "url")} title="复制网址">{copied === "url" ? <ClipboardCheck size={18} /> : <Clipboard size={18} />}</button></div></div>
          <div><b>2. 再测试 IMPORTDATA 公式</b><p>新建空白工作表并命名为“商品数据源”，在 A1 粘贴下面的公式。</p><div className="sheet-sync-code"><code>{status.importFormula}</code><button className="icon-button" onClick={() => copy(status.importFormula!, "formula")} title="复制公式">{copied === "formula" ? <ClipboardCheck size={18} /> : <Clipboard size={18} />}</button></div></div>
          <p className="sheet-sync-notice"><TriangleAlert size={18} />企业微信是否支持该外部取数公式需要以实际表格结果为准。若提示函数不存在，请把完整提示发给我，我们再切换同步方式。</p>
        </div> : <div className="sheet-sync-empty"><KeyRound size={25} /><p>密钥已启用，但出于安全原因不能再次显示。请点击左侧“重置并获取新网址”。</p></div>}
      </section>
    </div>
    <section className="panel sheet-sync-fields"><div><p className="eyebrow">商品库列</p><h2>同步字段</h2><p>主图链接取商品档案中的第一张图片；商品资料更新后，下次重新计算外部导入公式时会读取新值。</p></div><ol>{status.fields.map((field, index) => <li key={field}><i>{String.fromCharCode(65 + index)}</i><span>{field}</span></li>)}</ol></section>
  </>;
}

export function ProfileView() {
  const { user } = useAppData(); const toast = useToast(); const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" }); const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); if (form.newPassword !== form.confirmPassword) { toast("两次输入的新密码不一致", "error"); return; } setSaving(true); try { await apiFetch("/api/auth/me", { method: "PATCH", body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }) }); toast("密码已修改"); setForm({ currentPassword: "", newPassword: "", confirmPassword: "" }); } catch (reason) { toast(reason instanceof Error ? reason.message : "修改失败", "error"); } finally { setSaving(false); } }
  return <><PageHeader eyebrow="账号安全" title="我的账号" description="查看当前所属部门和账号权限，或修改自己的登录密码。" />
    <div className="profile-grid"><section className="panel profile-card"><span className="profile-avatar">{user.name.slice(0, 1)}</span><h2>{user.name}</h2><p>@{user.username}</p><dl><div><dt>所属部门</dt><dd>{user.departmentName}</dd></div><div><dt>账号类型</dt><dd>{user.isSuperAdmin ? "超级管理员" : "普通账号"}</dd></div><div><dt>功能权限</dt><dd>{user.isSuperAdmin ? "全部权限" : `已授权 ${user.permissions.length} 项`}</dd></div></dl></section><section className="panel password-card"><div className="password-head"><span><KeyRound size={21} /></span><div><h2>修改登录密码</h2><p>新密码至少 8 位，建议包含字母、数字和符号。</p></div></div><form onSubmit={submit}><Field label="当前密码" required><input type="password" autoComplete="current-password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} /></Field><Field label="新密码" required><input type="password" autoComplete="new-password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} /></Field><Field label="再次输入新密码" required><input type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} /></Field><button className="button button-primary" disabled={saving}>{saving ? "正在修改…" : "修改密码"}</button></form></section></div>
  </>;
}
