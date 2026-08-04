"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, BrainCircuit, CheckCircle2, RefreshCw, RotateCcw, Settings2, Sparkles } from "lucide-react";
import { apiFetch, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../ui";

type RecognitionData = {
  setting: { mode: "strict" | "standard" | "relaxed"; model: string };
  thresholds: Record<string, number>;
  progress: { total: number; ready: number; pending: number; failed: number };
  runs: Array<{ id: string; imageUrl: string; status: string; decision: string; error?: string; candidates: unknown[]; timings?: { cacheHit?: boolean; queueMs?: number; downloadMs?: number; decodeMs?: number; inferenceMs?: number; lookupMs?: number; totalMs?: number }; userName?: string; createdAt: string }>;
  batches: Array<{ id: string; sku: string; name: string; sampleIds: string[]; status: string; version: number; mergedProductVersion: number; userName?: string; createdAt: string; correctedSku?: string; correctedAt?: string }>;
};

const duration = (value?: number) => value === undefined ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)} 秒` : `${Math.round(value)} 毫秒`;
function timingSummary(timings?: RecognitionData["runs"][number]["timings"]) {
  if (!timings || timings.totalMs === undefined) return "—";
  if (timings.cacheHit) return `缓存命中 · 总计 ${duration(timings.totalMs)} · 比对 ${duration(timings.lookupMs)}`;
  return `总计 ${duration(timings.totalMs)} · 排队 ${duration(timings.queueMs)} · 下载 ${duration(timings.downloadMs)} · 解码 ${duration(timings.decodeMs)} · 识图 ${duration(timings.inferenceMs)} · 比对 ${duration(timings.lookupMs)}`;
}

const modes = [
  { value: "strict", label: "严格", description: "只提示非常相似的商品，候选更少" },
  { value: "standard", label: "标准", description: "兼顾漏判与误判，推荐日常使用" },
  { value: "relaxed", label: "宽松", description: "提示更多候选，需要更多人工确认" },
] as const;

export function RecognitionView() {
  const { can } = useAppData(); const toast = useToast(); const { data, loading, error, reload } = useRemote<RecognitionData>("/api/recognition");
  const [busy, setBusy] = useState(""); const [notes, setNotes] = useState<Record<string, string>>({});
  async function action(payload: Record<string, unknown>, key: string, message: string) {
    setBusy(key); try { const result = await apiFetch<{ restored?: boolean; sku?: string }>("/api/recognition", { method: "POST", body: JSON.stringify(payload) }); toast(result.sku ? `${message}：${result.sku}${result.restored === false ? "（原商品有后续修改，未自动覆盖）" : ""}` : message); await reload(); } catch (reason) { toast(reason instanceof Error ? reason.message : "操作失败", "error"); } finally { setBusy(""); }
  }
  async function correct(event: FormEvent, batch: RecognitionData["batches"][number]) { event.preventDefault(); const changed = Number(batch.version) !== Number(batch.mergedProductVersion); const message = changed ? "原商品在这次合并后又被修改过。继续后，系统只会把本次新增实物移到新货号，不会覆盖原商品的后续修改；完成后请人工检查原商品资料。是否继续？" : "确定这次被误判为同款吗？系统会把本次新增的实物移到一个新货号下，并恢复原商品合并前的资料。"; if (!confirm(message)) return; await action({ action: "correct_merge", batchId: batch.id, note: notes[batch.id] || "" }, batch.id, "已纠正并生成新货号"); }
  if (loading) return <LoadingState label="正在读取图片识别状态…" />; if (error || !data) return <ErrorState message={error || "读取失败"} retry={reload} />;
  const percent = data.progress.total ? Math.round(data.progress.ready / data.progress.total * 100) : 100;
  return <>
    <PageHeader eyebrow="本地 AI" title="图片识别管理" description="模型在公司服务器内运行，只保存小型特征数据，不保存商品原图。" />
    <section className="recognition-overview"><article className="panel recognition-progress"><span className="recognition-icon"><BrainCircuit size={24} /></span><div><small>历史图片索引</small><b>{percent}%</b><p>{data.progress.ready} 已完成 · {data.progress.pending} 等待中 · {data.progress.failed} 失败</p></div><div className="progress-track"><i style={{ width: `${percent}%` }} /></div>{can("image_matching:manage") && <div className="compact-actions"><button className="button button-secondary button-compact" disabled={!!busy} onClick={() => action({ action: "retry_failed" }, "retry", "失败图片已重新排队")}><RefreshCw size={15} />重试失败项</button><button className="button button-ghost button-compact" disabled={!!busy} onClick={() => { if (confirm("确定重新建立全部历史图片索引吗？此过程会在后台逐步完成。")) void action({ action: "reindex_all" }, "reindex", "全部图片已重新排队"); }}><RotateCcw size={15} />全部重建</button></div>}</article>
      <article className="panel recognition-help"><Sparkles size={23} /><div><b>识别不代替人工判断</b><p>系统只负责筛出疑似同款，最终仍由登记人员确认。不同颜色、尺码或规格应建立新货号。</p></div></article></section>
    {can("image_matching:manage") && <section className="panel form-section"><header><Settings2 size={22} /><div><h2>匹配灵敏度</h2><p>修改后只影响新的图片识别。</p></div></header><div className="mode-grid">{modes.map((mode) => <button type="button" key={mode.value} className={data.setting.mode === mode.value ? "selected" : ""} onClick={() => action({ action: "settings", mode: mode.value }, `mode-${mode.value}`, `已切换到${mode.label}模式`)}><span>{data.setting.mode === mode.value && <CheckCircle2 size={17} />}{mode.label}</span><p>{mode.description}</p><small>相似度阈值 {Math.round(data.thresholds[mode.value] * 100)}%</small></button>)}</div></section>}
    {can("products:correct_merge") && <section className="panel table-panel"><header className="panel-header padded"><div><p className="eyebrow">同款入库</p><h2>误判纠正</h2><p className="muted">只移动该次入库新增的实物；若原商品后来又被编辑，系统不会覆盖后续修改。</p></div></header>{!data.batches.length ? <EmptyState title="还没有同款合并记录" /> : <div className="correction-list">{data.batches.map((batch) => <article key={batch.id}><div className="correction-main"><span className={batch.status === "corrected" ? "soft-badge success" : "soft-badge"}>{batch.status === "corrected" ? "已纠正" : Number(batch.version) !== Number(batch.mergedProductVersion) ? "需人工检查" : "可纠正"}</span><div><b>{batch.sku} · {batch.name}</b><p>{batch.userName || "未知人员"} 于 {formatDate(batch.createdAt, true)} 确认同款，新增 {batch.sampleIds?.length || 0} 件</p>{batch.correctedSku && <small>已移至新货号 {batch.correctedSku}</small>}</div></div>{batch.status === "active" && <form onSubmit={(event) => correct(event, batch)}><input value={notes[batch.id] || ""} onChange={(event) => setNotes({ ...notes, [batch.id]: event.target.value })} placeholder="纠正原因（选填）" /><button className="button button-secondary button-compact" disabled={!!busy}><AlertTriangle size={15} />纠正误判</button></form>}</article>)}</div>}</section>}
    <section className="panel table-panel"><header className="panel-header padded"><div><p className="eyebrow">可追溯</p><h2>最近识别记录</h2></div></header>{!data.runs.length ? <EmptyState title="还没有识别记录" /> : <div className="data-table-wrap"><table className="data-table"><thead><tr><th>时间</th><th>操作人</th><th>识别结果</th><th>耗时明细</th><th>人工决定</th><th>说明</th></tr></thead><tbody>{data.runs.map((run) => <tr key={run.id}><td>{formatDate(run.createdAt, true)}</td><td>{run.userName || "—"}</td><td>{run.status === "matched" ? `发现 ${run.candidates?.length || 0} 个候选` : run.status === "no_match" ? "未发现同款" : "识别失败"}</td><td><small>{timingSummary(run.timings)}</small></td><td>{run.decision === "matched" ? "确认同款" : run.decision === "new" ? "作为新款" : run.decision === "failed_continue" ? "失败后继续" : "尚未登记"}</td><td>{run.error || "—"}</td></tr>)}</tbody></table></div>}</section>
  </>;
}
