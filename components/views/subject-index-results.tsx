"use client";
/* eslint-disable @next/next/no-img-element -- 仅显示外部商品图片，不经过服务器代理或保存。 */

import Link from "next/link";
import { FormEvent, useState } from "react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { formatDate, useRemote } from "../client-utils";
import { EmptyState, ErrorState, LoadingState, Pagination } from "../ui";

type GlmModelOption = { id: string; label: string; billing: "free" | "paid"; description: string };
type SubjectIndexRow = {
  id: string;
  imageUrl: string;
  subjectStatus: "waiting" | "pending" | "processing" | "ready" | "failed";
  subjectBox?: [number, number, number, number] | null;
  subjectModel?: string | null;
  subjectError?: string | null;
  subjectAttempts: number;
  subjectUpdatedAt: string;
  productId: string;
  sku: string;
  name: string;
  archived: boolean;
};
type SubjectIndexData = { rows: SubjectIndexRow[]; total: number; page: number; pageSize: number };

const statusLabels: Record<SubjectIndexRow["subjectStatus"], string> = { waiting: "尚未开始", pending: "等待处理", processing: "处理中", ready: "已完成", failed: "失败" };

function SubjectPreview({ row }: { row: SubjectIndexRow }) {
  const box = Array.isArray(row.subjectBox) && row.subjectBox.length === 4 ? row.subjectBox : null;
  const style = box ? { left: `${box[0] / 10}%`, top: `${box[1] / 10}%`, width: `${Math.max(0, box[2] - box[0]) / 10}%`, height: `${Math.max(0, box[3] - box[1]) / 10}%` } : undefined;
  return <div className="subject-preview"><img src={row.imageUrl} alt={row.name} referrerPolicy="no-referrer" />{style && <i style={style} title={`主体框 ${box?.join(", ")}`} />}</div>;
}

export function SubjectIndexResults({ models }: { models: GlmModelOption[] }) {
  const [draftSearch, setDraftSearch] = useState(""); const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all"); const [model, setModel] = useState("all"); const [page, setPage] = useState(1);
  const query = new URLSearchParams({ search, status, model, page: String(page) }).toString();
  const { data, loading, error, reload } = useRemote<SubjectIndexData>(`/api/recognition/subject-index?${query}`);
  const modelLabels = new Map(models.map((item) => [item.id, item.label]));
  function submitSearch(event: FormEvent) { event.preventDefault(); setPage(1); setSearch(draftSearch.trim()); }
  return <section className="panel table-panel subject-index-panel"><header className="panel-header padded"><div><p className="eyebrow">GLM 主体定位</p><h2>主体索引结果</h2><p className="muted">绿色框是 GLM 识别出的商品主体范围；这里只显示图片网址和特征结果，不保存原图。</p></div><button type="button" className="button button-secondary button-compact" onClick={() => reload()}><RefreshCw size={15} />刷新</button></header><form className="subject-index-filters" onSubmit={submitSearch}><div className="input-prefix"><Search size={16} /><input value={draftSearch} onChange={(event) => setDraftSearch(event.target.value)} placeholder="搜索货号、商品名称或图片网址" /></div><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">全部状态</option><option value="ready">已完成</option><option value="pending">等待处理</option><option value="processing">处理中</option><option value="failed">失败</option><option value="waiting">尚未开始</option></select><select value={model} onChange={(event) => { setModel(event.target.value); setPage(1); }}><option value="all">全部模型</option>{models.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><button className="button button-primary button-compact">查询</button></form>{loading ? <LoadingState label="正在读取主体索引结果…" /> : error ? <ErrorState message={error} retry={reload} /> : !data?.rows.length ? <EmptyState title="暂无符合条件的主体索引结果" description="开始建立 GLM 索引后，处理结果会显示在这里。" /> : <><div className="subject-index-list">{data.rows.map((row) => <article key={row.id}><SubjectPreview row={row} /><div className="subject-index-product"><div><span className={`soft-badge subject-${row.subjectStatus}`}>{statusLabels[row.subjectStatus]}</span>{row.archived && <span className="soft-badge">已归档</span>}</div><Link href={`/products/${row.productId}`}><b>{row.sku}</b><span>{row.name}</span></Link><small>{row.subjectModel ? modelLabels.get(row.subjectModel) || row.subjectModel : "尚未记录处理模型"} · 尝试 {row.subjectAttempts} 次 · {formatDate(row.subjectUpdatedAt, true)}</small>{row.subjectError && <p>{row.subjectError}</p>}</div><div className="subject-index-box"><small>主体框坐标（0–1000）</small><code>{row.subjectBox?.join(", ") || "—"}</code><a href={row.imageUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />查看原网址</a></div></article>)}</div><Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} /></>}</section>;
}
