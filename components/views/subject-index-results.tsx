"use client";
/* eslint-disable @next/next/no-img-element -- 仅显示外部商品图片，不经过服务器代理或保存。 */

import Link from "next/link";
import { FormEvent, PointerEvent, useRef, useState } from "react";
import { ExternalLink, Pencil, RefreshCw, Search } from "lucide-react";
import { apiFetch, formatDate, useRemote, useToast } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, Modal, Pagination } from "../ui";

type GlmModelOption = { id: string; label: string; billing: "free" | "paid"; description: string };
type SubjectBox = [number, number, number, number];
type SubjectIndexRow = {
  id: string;
  imageUrl: string;
  subjectStatus: "waiting" | "pending" | "processing" | "ready" | "failed";
  subjectBox?: SubjectBox | null;
  subjectModel?: string | null;
  subjectError?: string | null;
  subjectAttempts: number;
  subjectUpdatedAt: string;
  subjectBoxSource: "glm" | "manual";
  subjectCorrectedAt?: string | null;
  subjectCorrectedByName?: string | null;
  productId: string;
  sku: string;
  name: string;
  archived: boolean;
};
type SubjectIndexData = { rows: SubjectIndexRow[]; total: number; page: number; pageSize: number; canCorrect: boolean };

const statusLabels: Record<SubjectIndexRow["subjectStatus"], string> = { waiting: "尚未开始", pending: "等待处理", processing: "处理中", ready: "已完成", failed: "失败" };
const clamp = (value: number) => Math.min(1000, Math.max(0, Math.round(value)));

function boxStyle(box?: SubjectBox | null) {
  return box ? { left: `${box[0] / 10}%`, top: `${box[1] / 10}%`, width: `${Math.max(0, box[2] - box[0]) / 10}%`, height: `${Math.max(0, box[3] - box[1]) / 10}%` } : undefined;
}

function SubjectPreview({ row }: { row: SubjectIndexRow }) {
  const style = boxStyle(Array.isArray(row.subjectBox) && row.subjectBox.length === 4 ? row.subjectBox : null);
  return <div className="subject-preview"><span><img src={row.imageUrl} alt={row.name} referrerPolicy="no-referrer" />{style && <i className={row.subjectBoxSource === "manual" ? "manual" : ""} style={style} title={`主体框 ${row.subjectBox?.join(", ")}`} />}</span></div>;
}

function SubjectBoxEditor({ row, box, onChange }: { row: SubjectIndexRow; box: SubjectBox; onChange: (box: SubjectBox) => void }) {
  const origin = useRef<[number, number] | null>(null);
  function point(event: PointerEvent<HTMLDivElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    return [clamp((event.clientX - rect.left) / rect.width * 1000), clamp((event.clientY - rect.top) / rect.height * 1000)];
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!origin.current) return;
    const next = point(event); const start = origin.current;
    onChange([Math.min(start[0], next[0]), Math.min(start[1], next[1]), Math.max(start[0], next[0]), Math.max(start[1], next[1])]);
  }
  return <div className="subject-box-editor">
    <p>在图片上按住并拖动，重新框住真正需要识别的主商品。橙色框保存后将作为人工结果永久优先。</p>
    <div className="subject-box-editor-stage"><div className="subject-box-editor-canvas">
      <img src={row.imageUrl} alt={row.name} referrerPolicy="no-referrer" draggable={false} />
      <div className="subject-box-editor-surface" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); origin.current = point(event); onChange([origin.current[0], origin.current[1], origin.current[0], origin.current[1]]); }} onPointerMove={move} onPointerUp={(event) => { move(event); origin.current = null; }} onPointerCancel={() => { origin.current = null; }}>
        <i style={boxStyle(box)} />
      </div>
    </div></div>
    <small>当前坐标（0–1000）：{box.join(", ")}</small>
  </div>;
}

export function SubjectIndexResults({ models }: { models: GlmModelOption[] }) {
  const toast = useToast();
  const [draftSearch, setDraftSearch] = useState(""); const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all"); const [model, setModel] = useState("all"); const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<SubjectIndexRow | null>(null); const [draftBox, setDraftBox] = useState<SubjectBox>([100, 100, 900, 900]); const [saving, setSaving] = useState(false);
  const query = new URLSearchParams({ search, status, model, page: String(page) }).toString();
  const { data, loading, error, reload } = useRemote<SubjectIndexData>(`/api/recognition/subject-index?${query}`);
  const modelLabels = new Map(models.map((item) => [item.id, item.label]));
  function submitSearch(event: FormEvent) { event.preventDefault(); setPage(1); setSearch(draftSearch.trim()); }
  function edit(row: SubjectIndexRow) { setEditing(row); setDraftBox(row.subjectBox || [100, 100, 900, 900]); }
  async function saveCorrection() {
    if (!editing || draftBox[2] - draftBox[0] < 10 || draftBox[3] - draftBox[1] < 10) return;
    setSaving(true);
    try {
      await apiFetch("/api/recognition/subject-index", { method: "POST", body: JSON.stringify({ id: editing.id, box: draftBox }) });
      toast("主体框已人工纠正并重新生成索引"); setEditing(null); await reload();
    } catch (reason) { toast(reason instanceof Error ? reason.message : "主体框保存失败", "error"); }
    finally { setSaving(false); }
  }
  return <>
    <section className="panel table-panel subject-index-panel">
      <header className="panel-header padded"><div><p className="eyebrow">GLM 主体定位</p><h2>主体索引结果</h2><p className="muted">绿色是 GLM 自动框，橙色是人工框；GLM 选错时可以重新框选，人工结果不会被重试或模型重建覆盖。</p></div><button type="button" className="button button-secondary button-compact" onClick={() => reload()}><RefreshCw size={15} />刷新</button></header>
      <form className="subject-index-filters" onSubmit={submitSearch}><div className="input-prefix"><Search size={16} /><input value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder="搜索货号、商品名称或图片网址" /></div><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">全部状态</option><option value="ready">已完成</option><option value="pending">等待处理</option><option value="processing">处理中</option><option value="failed">失败</option><option value="waiting">尚未开始</option></select><select value={model} onChange={(event) => { setModel(event.target.value); setPage(1); }}><option value="all">全部模型</option>{models.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button className="button button-primary button-compact">查询</button></form>
      {loading ? <LoadingState label="正在读取主体索引结果…" /> : error ? <ErrorState message={error} retry={reload} /> : !data?.rows.length ? <EmptyState title="暂无符合条件的主体索引结果" description="开始建立 GLM 索引后，处理结果会显示在这里。" /> : <><div className="subject-index-list">{data.rows.map((row) => <article key={row.id}>
        <SubjectPreview row={row} />
        <div className="subject-index-product"><div><span className={`soft-badge subject-${row.subjectStatus}`}>{statusLabels[row.subjectStatus]}</span>{row.subjectBoxSource === "manual" && <span className="soft-badge success">人工已纠正</span>}{row.archived && <span className="soft-badge">已归档</span>}</div><Link href={`/products/${row.productId}`}><b>{row.sku}</b><span>{row.name}</span></Link><small>{row.subjectModel ? modelLabels.get(row.subjectModel) || row.subjectModel : "尚未记录处理模型"} · 尝试 {row.subjectAttempts} 次 · {formatDate(row.subjectUpdatedAt, true)}</small>{row.subjectBoxSource === "manual" && <small>由 {row.subjectCorrectedByName || "管理员"} 于 {formatDate(row.subjectCorrectedAt, true)} 人工框选</small>}{row.subjectError && <p>{row.subjectError}</p>}</div>
        <div className="subject-index-box"><small>主体框坐标（0–1000）</small><code>{row.subjectBox?.join(", ") || "—"}</code><a href={row.imageUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />查看原网址</a>{data.canCorrect && <button type="button" className="button button-secondary button-compact" onClick={() => edit(row)}><Pencil size={14} />纠正主体框</button>}</div>
      </article>)}</div><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} /></>}
    </section>
    {editing && <Modal title={`纠正主体框 · ${editing.sku}`} onClose={() => { if (!saving) setEditing(null); }} wide><SubjectBoxEditor row={editing} box={draftBox} onChange={setDraftBox} /><div className="modal-actions"><button type="button" className="button button-ghost" disabled={saving} onClick={() => setEditing(null)}>取消</button><button type="button" className="button button-primary" disabled={saving || draftBox[2] - draftBox[0] < 10 || draftBox[3] - draftBox[1] < 10} onClick={saveCorrection}>{saving ? "正在重新生成索引…" : "保存人工主体框"}</button></div></Modal>}
  </>;
}
