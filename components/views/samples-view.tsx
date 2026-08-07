"use client";
/* eslint-disable @next/next/no-img-element -- 条形码是接口即时生成的数据图片，不能交给 Next 图片代理。 */

import { type IScannerControls } from "@zxing/browser";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, Camera, Check, Clipboard, Download, History, Keyboard, Layers3, MapPin, MoveRight, ScanLine, Search, Smartphone, X } from "lucide-react";
import { activeLocationLabel, SAMPLE_STATUSES, statusLabel } from "@/lib/constants";
import { extractSampleCode } from "@/lib/scan-code";
import { apiFetch, copyToClipboard, formatDate, useAppData, useRemote, useToast } from "../client-utils";
import { ErrorState, Field, LoadingState, Modal, PageHeader, ProductImage, StatusBadge } from "../ui";
import { BatchScanner } from "./batch-scanner";

type SampleRow = { id: string; code: string; arrivedAt: string; status: string; note?: string; spec?: string; updatedAt: string; productId: string; sku: string; productName: string; imageUrls: string[]; departmentId?: string; departmentName?: string; locationId?: string; locationName?: string; storeName?: string; price?: string; productUrl?: string; commission?: string; storeRating?: string; supplyChain?: string; cooperationMechanism?: string; categoryName?: string; businessContactName?: string; selectedDepartments?: string; tags?: string; notes?: string; productCreatedAt?: string; productUpdatedAt?: string };
type SampleDetailData = { sample: SampleRow & { productId: string; storeName?: string; productUrl?: string; price?: string; commission?: string; supplyChain?: string; categoryName?: string }; movements: Array<{ id: string; fromStatus?: string; toStatus: string; remark?: string; createdAt: string; fromDepartmentName?: string; fromLocationName?: string; toDepartmentName?: string; toLocationName?: string; operatorName?: string }>; barcode: string };

export function SampleDetailView({ id }: { id: string }) {
  const { lookups, can } = useAppData(); const router = useRouter(); const toast = useToast(); const { data, loading, error, reload } = useRemote<SampleDetailData>(`/api/samples/${encodeURIComponent(id)}`); const scanMoveOpenedRef = useRef(false); const [moveOpen, setMoveOpen] = useState(false);   const [form, setForm] = useState({ status: "active", departmentId: "", locationId: "", remark: "", note: "", spec: "" }); const [saving, setSaving] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => { if (data) setForm({ status: data.sample.status, departmentId: data.sample.departmentId || "", locationId: data.sample.locationId || "", remark: "", note: data.sample.note || "", spec: data.sample.spec || "" }); }, [data]);
  useEffect(() => { if (data && !scanMoveOpenedRef.current && can("samples:move") && new URLSearchParams(window.location.search).get("from") === "scan") { scanMoveOpenedRef.current = true; setMoveOpen(true); } }, [data, can]);
  if (loading) return <LoadingState />; if (error || !data) return <ErrorState message={error || "样品不存在"} retry={reload} />;
  const s = data.sample; const locations = lookups?.locations.filter((item) => item.departmentId === form.departmentId) || [];
  async function move(event: FormEvent) { event.preventDefault(); setSaving(true); try { await apiFetch(`/api/samples/${s.id}`, { method: "PATCH", body: JSON.stringify({ ...form, departmentId: form.status === "active" ? form.departmentId || null : null, locationId: form.status === "active" ? form.locationId || null : null }) }); toast("样品位置与状态已更新"); setMoveOpen(false); await reload(); } catch (reason) { toast(reason instanceof Error ? reason.message : "更新失败", "error"); } finally { setSaving(false); } }
  async function copyCode() { await copyToClipboard(s.code); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  async function archive() { if (!confirm("确定归档这件样品吗？归档后仍保留历史记录。")) return; try { await apiFetch(`/api/samples/${s.id}`, { method: "DELETE" }); toast("样品已归档"); router.push(`/products/${s.productId}`); } catch (reason) { toast(reason instanceof Error ? reason.message : "归档失败", "error"); } }
  return <>
    <PageHeader eyebrow={`实物编号 ${s.code}`} title={s.productName} description={`货号 ${s.sku} · 到样 ${formatDate(s.arrivedAt)}`} actions={<><Link className="button button-ghost" href={`/products/${s.productId}`}><ArrowLeft size={17} />返回商品</Link>{can("samples:move") && <button className="button button-primary" onClick={() => setMoveOpen(true)}><MoveRight size={17} />修改位置 / 状态</button>}</>} />
    <section className="sample-focus-grid"><article className="panel sample-identity"><div className="sample-image-area"><ProductImage urls={s.imageUrls} alt={s.productName} size="large" /><StatusBadge status={s.status} /></div><div className="sample-identity-copy"><p className="eyebrow">当前所在位置</p><h2><MapPin size={25} />{activeLocationLabel({ status: s.status, department_name: s.departmentName, location_name: s.locationName })}</h2><button className="copy-code" onClick={copyCode}><span>{s.code}</span>{copied ? <Check size={16} /> : <Clipboard size={16} />}</button><dl><div><dt>店铺</dt><dd>{s.storeName || "—"}</dd></div><div><dt>价格 / 佣金</dt><dd>{s.price ? `¥${s.price}` : "—"}{s.commission ? ` / ${s.commission}` : ""}</dd></div><div><dt>供应链 / 机构</dt><dd>{s.supplyChain || "—"}</dd></div><div><dt>样品规格</dt><dd>{s.spec || "—"}</dd></div><div><dt>样品备注</dt><dd>{s.note || "—"}</dd></div></dl><Link className="row-link" href={`/products/${s.productId}`}>查看商品档案</Link></div></article>
      <article className="panel barcode-card"><p className="eyebrow">扫码快速访问</p><h2>样品条形码</h2><img src={data.barcode} alt={`${s.code} Code 128 条形码`} /><p>条形码内容为实物编号，可用本系统手机扫码页识别并进入流转。</p></article></section>
    <section className="panel timeline-panel"><header className="panel-header padded"><div><p className="eyebrow">完整追踪</p><h2>位置与状态流转记录</h2></div><Link href="/api/export?type=movements" className="button button-secondary button-compact"><Download size={16} />导出记录</Link></header><div className="timeline">{data.movements.map((movement, index) => <div className="timeline-item" key={movement.id}><div className="timeline-rail"><span>{index === 0 ? <MapPin size={15} /> : <History size={15} />}</span><i /></div><div className="timeline-content"><div><StatusBadge status={movement.toStatus} /><b>{movement.toStatus === "active" ? [movement.toDepartmentName, movement.toLocationName].filter(Boolean).join(" · ") || "位置待确认" : statusLabel(movement.toStatus)}</b></div><p>{movement.fromStatus ? `从 ${movement.fromStatus === "active" ? [movement.fromDepartmentName, movement.fromLocationName].filter(Boolean).join(" · ") || "原位置" : statusLabel(movement.fromStatus)} 更新` : "首次到样登记"}</p>{movement.remark && <blockquote>{movement.remark}</blockquote>}<small>{movement.operatorName || "系统"} · {formatDate(movement.createdAt, true)}</small></div></div>)}</div>{can("samples:archive") && s.status !== "active" && <button className="danger-link timeline-archive" onClick={archive}><Archive size={16} />归档此样品</button>}</section>
    {moveOpen && <Modal title={`更新样品 ${s.code}`} onClose={() => setMoveOpen(false)} wide><form className="modal-form" onSubmit={move}><Field label="样品状态" required><div className="status-picker">{SAMPLE_STATUSES.map((item) => <label className={form.status === item.value ? "selected" : ""} key={item.value}><input type="radio" name="status" checked={form.status === item.value} onChange={() => setForm({ ...form, status: item.value, departmentId: item.value === "active" ? form.departmentId : "", locationId: "" })} /><StatusBadge status={item.value} /><small>{item.value === "active" ? "位于公司部门或直播间" : item.label}</small></label>)}</div></Field>{form.status === "active" && <div className="form-grid"><Field label="所在部门" required><select value={form.departmentId} onChange={(event) => setForm({ ...form, departmentId: event.target.value, locationId: "" })}><option value="">请选择部门</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="具体位置"><select value={form.locationId} onChange={(event) => setForm({ ...form, locationId: event.target.value })}><option value="">暂不细分</option>{locations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>}<Field label="样品规格" hint="例如颜色、尺码"><input value={form.spec} onChange={(event) => setForm({ ...form, spec: event.target.value })} placeholder="例如 白色" /></Field><div className="form-grid"><Field label="本次操作备注" hint="选填"><textarea rows={3} value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} placeholder="例如：A 直播间使用完，归还商务部" /></Field><Field label="样品长期备注" hint="选填"><textarea rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></Field></div><div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setMoveOpen(false)}>取消</button><button className="button button-primary" disabled={saving}>{saving ? "正在保存…" : "确认更新"}</button></div></form></Modal>}
  </>;
}

import { getBarcodeReader } from "../barcode-reader";

export function ScannerView() {
  const { can } = useAppData();
  const [mode, setMode] = useState<"choose" | "single" | "batch">("choose");
  if (mode === "single") return <SingleScanner onBack={() => setMode("choose")} />;
  if (mode === "batch") return <BatchScanner onBack={() => setMode("choose")} />;
  return <>
    <PageHeader eyebrow="手机快捷操作" title="扫码流转" description="单件扫码适合查看并处理一件样品；批量流转可先统一选择操作，再连续扫描整批样品。" />
    <section className="scan-mode-grid"><button className="panel scan-mode-card" onClick={() => setMode("single")}><span><ScanLine size={32} /></span><div><p className="eyebrow">单件操作</p><h2>扫描一件样品</h2><p>扫码后进入样品详情，查看当前位置并单独修改。</p></div><MoveRight size={22} /></button>{can("samples:move") && <button className="panel scan-mode-card featured" onClick={() => setMode("batch")}><span><Layers3 size={32} /></span><div><p className="eyebrow">推荐：连续处理</p><h2>批量扫码流转</h2><p>先选统一目标，再连续扫描最多 100 件，最后一次确认。</p></div><MoveRight size={22} /></button>}</section>
    <section className="panel" style={{ marginTop: 16, padding: 20, display: "flex", alignItems: "center", gap: 12 }}><History size={22} style={{ color: "var(--muted)" }} /><div><b>流转记录</b><p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>查看所有样品的完整流转历史，支持按样品、操作人筛选。</p></div><Link href="/movements" className="button button-secondary button-compact" style={{ marginLeft: "auto", flexShrink: 0 }}>查看记录</Link></section>
  </>;
}

function SingleScanner({ onBack }: { onBack: () => void }) {
  const router = useRouter(); const toast = useToast(); const videoRef = useRef<HTMLVideoElement>(null); const fileRef = useRef<HTMLInputElement>(null); const controlsRef = useRef<IScannerControls | null>(null); const scanAttemptRef = useRef(0); const [running, setRunning] = useState(false); const [starting, setStarting] = useState(false); const [readingImage, setReadingImage] = useState(false); const [cameraError, setCameraError] = useState(""); const [manual, setManual] = useState("");
  function stop() { scanAttemptRef.current += 1; controlsRef.current?.stop(); controlsRef.current = null; if (videoRef.current) videoRef.current.srcObject = null; setRunning(false); setStarting(false); setReadingImage(false); }
  useEffect(() => () => { scanAttemptRef.current += 1; controlsRef.current?.stop(); }, []);
  function openValue(value: string) { const code = extractSampleCode(value); if (!code) { toast("没有识别到有效的实物编号", "error"); return; } stop(); router.push(`/samples/${encodeURIComponent(code)}?from=scan`); }
  async function start() {
    stop();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setCameraError("当前页面无法调用摄像头，请确认使用 HTTPS 地址，或改用拍照识别。"); return; }
    const attempt = scanAttemptRef.current; setCameraError(""); setStarting(true);
    try {
      const controls = await getBarcodeReader().decodeFromConstraints({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }, videoRef.current || undefined, (result) => {
        if (result && attempt === scanAttemptRef.current) openValue(result.getText());
      });
      if (attempt !== scanAttemptRef.current) { controls.stop(); return; }
      controlsRef.current = controls; setRunning(true);
    } catch (reason) {
      if (attempt !== scanAttemptRef.current) return;
      const name = reason instanceof DOMException ? reason.name : "";
      const message = name === "NotAllowedError" ? "摄像头权限未开启，请在浏览器设置中允许访问，或改用拍照识别。" : name === "NotFoundError" ? "未找到可用摄像头，请改用拍照识别或输入编号。" : "摄像头启动失败，请重试或改用拍照识别。";
      setCameraError(message); toast(message, "error");
    } finally { if (attempt === scanAttemptRef.current) setStarting(false); }
  }
  async function scanImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; stop(); const attempt = scanAttemptRef.current; setCameraError(""); setReadingImage(true); const imageUrl = URL.createObjectURL(file);
    try { const result = await getBarcodeReader().decodeFromImageUrl(imageUrl); if (attempt === scanAttemptRef.current) openValue(result.getText()); }
    catch { if (attempt === scanAttemptRef.current) toast("照片中未识别到条形码，请保持条码横向、画面清晰后重试", "error"); }
    finally { URL.revokeObjectURL(imageUrl); if (attempt === scanAttemptRef.current) setReadingImage(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (manual.trim()) openValue(manual); }
  return <>
    <PageHeader eyebrow="单件扫码" title="扫描样品条形码" description="扫描标签上的 Code 128 条形码，即可查看当前位置并继续完成流转。" actions={<button className="button button-ghost" onClick={onBack}><ArrowLeft size={17} />返回扫码首页</button>} />
    <section className="scanner-layout"><div className="panel scanner-card"><div className={`camera-frame ${running ? "running" : ""}`}><video ref={videoRef} muted playsInline /><div className="scan-corners"><i /><i /><i /><i /></div>{!running && <div className="camera-placeholder"><ScanLine size={58} /><h2>将条形码横向放入框内</h2><p>保持标签平整、光线充足</p></div>}</div><div className="scanner-actions">{running ? <button className="button button-secondary" type="button" onClick={stop}><X size={18} />停止扫描</button> : <button className="button button-primary" type="button" onClick={start} disabled={starting}>{starting ? "正在启动…" : <><Camera size={18} />打开摄像头扫码</>}</button>}<input ref={fileRef} className="scan-file-input" type="file" accept="image/*" capture="environment" onChange={scanImage} /><button className="button button-secondary" type="button" disabled={readingImage} onClick={() => fileRef.current?.click()}><Camera size={18} />{readingImage ? "正在识别…" : "拍照识别"}</button>{cameraError && <p className="inline-hint scanner-error">{cameraError}</p>}</div></div><div className="panel scanner-manual"><div className="scanner-icon"><Keyboard size={25} /></div><p className="eyebrow">备用方式</p><h2>输入实物编号</h2><p>条形码磨损或摄像头不可用时，可直接输入标签上的独立编号；旧编号也可继续查询。</p><form onSubmit={submit}><div className="search-box"><Search size={18} /><input value={manual} onChange={(event) => setManual(event.target.value)} placeholder="例如 HZG-2026-0001-001" autoCapitalize="characters" /></div><button className="button button-primary" disabled={!manual.trim()}>查询样品</button></form><div className="mobile-tip"><Smartphone size={20} /><span>实时扫码需使用 HTTPS 地址；无法授权摄像头时，可直接使用拍照识别。</span></div></div></section>
  </>;
}
