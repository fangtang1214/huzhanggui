"use client";

import { BarcodeFormat, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ArrowLeft, Camera, CheckCircle2, Keyboard, MapPin, ScanLine, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { activeLocationLabel, SAMPLE_STATUSES, statusLabel } from "@/lib/constants";
import { extractSampleCode } from "@/lib/scan-code";
import { apiFetch, useAppData, useToast } from "../client-utils";
import { Field, PageHeader, ProductImage, StatusBadge } from "../ui";

type BatchSample = {
  id: string;
  code: string;
  status: string;
  arrivedAt: string;
  productId: string;
  sku: string;
  productName: string;
  imageUrls: string[];
  departmentId?: string;
  departmentName?: string;
  locationId?: string;
  locationName?: string;
  error?: string;
};

type BatchTarget = { status: string; departmentId: string; locationId: string; remark: string };
type Draft = { version: 1; batchId: string; target: BatchTarget; items: BatchSample[]; muted: boolean; savedAt: number };
type BatchResult = { batchId: string; updated: number; results: Array<{ sampleId: string; success: boolean; changed: boolean; message?: string }> };
type FeedbackKind = "success" | "duplicate" | "error";

const DRAFT_LIFETIME = 24 * 60 * 60 * 1000;
const initialTarget: BatchTarget = { status: "active", departmentId: "", locationId: "", remark: "" };

function createBarcodeReader() {
  const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 500 });
  reader.possibleFormats = [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE];
  return reader;
}

export function BatchScanner({ onBack }: { onBack: () => void }) {
  const { user, lookups } = useAppData();
  const toast = useToast();
  const draftKey = `huzhanggui:batch-scan:${user.id}`;
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const scanAttemptRef = useRef(0);
  const pendingCodesRef = useRef(new Set<string>());
  const detectedAtRef = useRef(new Map<string, number>());
  const itemsRef = useRef<BatchSample[]>([]);
  const mutedRef = useRef(false);
  const targetReadyRef = useRef(false);
  const audioRef = useRef<AudioContext | null>(null);
  const [target, setTarget] = useState<BatchTarget>(initialTarget);
  const [items, setItems] = useState<BatchSample[]>([]);
  const [batchId, setBatchId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const [muted, setMuted] = useState(false);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [manual, setManual] = useState("");
  const [feedback, setFeedback] = useState<{ kind: FeedbackKind; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [completed, setCompleted] = useState<{ total: number; updated: number } | null>(null);
  const targetReady = target.status !== "active" || Boolean(target.departmentId);
  const locations = lookups?.locations.filter((item) => item.departmentId === target.departmentId) || [];

  useEffect(() => {
    let draft: Draft | null = null;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) draft = JSON.parse(raw) as Draft;
    } catch {
      localStorage.removeItem(draftKey);
    }
    if (draft?.version === 1 && Date.now() - draft.savedAt < DRAFT_LIFETIME) {
      const restoredItems = Array.isArray(draft.items) ? draft.items.slice(0, 100) : [];
      setBatchId(draft.batchId || crypto.randomUUID());
      setTarget(draft.target || initialTarget);
      setItems(restoredItems);
      itemsRef.current = restoredItems;
      setMuted(Boolean(draft.muted));
      mutedRef.current = Boolean(draft.muted);
      setRestored(restoredItems.length > 0);
    } else {
      localStorage.removeItem(draftKey);
      setBatchId(crypto.randomUUID());
    }
    setHydrated(true);
  }, [draftKey]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    targetReadyRef.current = targetReady;
  }, [targetReady]);

  useEffect(() => {
    if (!hydrated || completed) return;
    const timer = window.setTimeout(() => {
      const draft: Draft = { version: 1, batchId, target, items, muted, savedAt: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draft));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [batchId, completed, draftKey, hydrated, items, muted, target]);

  function stopCamera() {
    scanAttemptRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setRunning(false);
    setStarting(false);
  }

  useEffect(() => () => {
    scanAttemptRef.current += 1;
    controlsRef.current?.stop();
    void audioRef.current?.close();
  }, []);

  function ensureAudio() {
    if (mutedRef.current) return null;
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return null;
      if (!audioRef.current || audioRef.current.state === "closed") audioRef.current = new AudioContextClass();
      if (audioRef.current.state === "suspended") void audioRef.current.resume();
      return audioRef.current;
    } catch {
      return null;
    }
  }

  function signal(kind: FeedbackKind, message: string) {
    setFeedback({ kind, message });
    if (kind === "error") toast(message, "error");
    if (mutedRef.current) return;
    navigator.vibrate?.(kind === "success" ? 45 : kind === "duplicate" ? [35, 45, 35] : [120, 60, 120]);
    try {
      const audio = ensureAudio();
      if (!audio) return;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.frequency.value = kind === "success" ? 880 : kind === "duplicate" ? 520 : 220;
      gain.gain.setValueAtTime(0.08, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.14);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + 0.14);
    } catch {
      // 部分手机会在静音或系统限制下拒绝播放提示音，震动与页面提示仍可用。
    }
  }

  async function addScannedValue(value: string) {
    if (!targetReadyRef.current) { signal("error", "请先完整选择本批统一操作"); return; }
    const code = extractSampleCode(value);
    if (!code) { signal("error", "没有识别到有效的实物编号"); return; }
    const normalized = code.toLowerCase();
    const detectedAt = detectedAtRef.current.get(normalized) || 0;
    if (Date.now() - detectedAt < 1800) return;
    detectedAtRef.current.set(normalized, Date.now());
    if (itemsRef.current.some((item) => item.code.toLowerCase() === normalized)) {
      signal("duplicate", `${code} 已在本批清单中`);
      return;
    }
    if (itemsRef.current.length >= 100) { signal("error", "本批已达到 100 件上限"); return; }
    if (pendingCodesRef.current.has(normalized)) return;
    pendingCodesRef.current.add(normalized);
    try {
      const { sample } = await apiFetch<{ sample: BatchSample }>(`/api/samples/scan?code=${encodeURIComponent(code)}`);
      if (itemsRef.current.some((item) => item.id === sample.id)) {
        signal("duplicate", `${sample.code} 已在本批清单中`);
        return;
      }
      if (itemsRef.current.length >= 100) { signal("error", "本批已达到 100 件上限"); return; }
      const next = [...itemsRef.current, { ...sample, error: undefined }];
      itemsRef.current = next;
      setItems(next);
      signal("success", `已加入 ${sample.code} · ${sample.productName}`);
    } catch (reason) {
      signal("error", reason instanceof Error ? reason.message : "样品识别失败");
    } finally {
      pendingCodesRef.current.delete(normalized);
    }
  }

  async function startCamera() {
    ensureAudio();
    stopCamera();
    if (!targetReady) { signal("error", "请先选择本批统一操作"); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("当前页面无法调用摄像头，请确认使用 HTTPS 地址，或改用拍照识别。");
      return;
    }
    const attempt = scanAttemptRef.current;
    setCameraError(""); setStarting(true);
    try {
      const controls = await createBarcodeReader().decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        videoRef.current || undefined,
        (result) => { if (result && attempt === scanAttemptRef.current) void addScannedValue(result.getText()); },
      );
      if (attempt !== scanAttemptRef.current) { controls.stop(); return; }
      controlsRef.current = controls; setRunning(true);
    } catch (reason) {
      if (attempt !== scanAttemptRef.current) return;
      const name = reason instanceof DOMException ? reason.name : "";
      const message = name === "NotAllowedError" ? "摄像头权限未开启，请在浏览器设置中允许访问，或改用拍照识别。" : name === "NotFoundError" ? "未找到可用摄像头，请改用拍照识别或输入编号。" : "摄像头启动失败，请重试或改用拍照识别。";
      setCameraError(message); signal("error", message);
    } finally {
      if (attempt === scanAttemptRef.current) setStarting(false);
    }
  }

  async function scanImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    ensureAudio();
    if (!targetReady) { signal("error", "请先选择本批统一操作"); return; }
    setReadingImage(true); setCameraError("");
    const imageUrl = URL.createObjectURL(file);
    try {
      const result = await createBarcodeReader().decodeFromImageUrl(imageUrl);
      await addScannedValue(result.getText());
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes("样品")) signal("error", reason.message);
      else signal("error", "照片中未识别到条形码，请保持条码横向、画面清晰后重试");
    } finally {
      URL.revokeObjectURL(imageUrl); setReadingImage(false);
    }
  }

  function submitManual(event: FormEvent) {
    event.preventDefault();
    const value = manual.trim();
    if (!value || !targetReady) return;
    ensureAudio();
    setManual(""); void addScannedValue(value);
  }

  function removeItem(id: string) {
    const next = itemsRef.current.filter((item) => item.id !== id);
    itemsRef.current = next; setItems(next);
  }

  async function submitBatch() {
    if (!targetReady) { signal("error", "请先完整选择本批统一操作"); return; }
    if (!items.length) { signal("error", "请先扫描需要流转的样品"); return; }
    const targetName = target.status === "active"
      ? [lookups?.departments.find((item) => item.id === target.departmentId)?.name, lookups?.locations.find((item) => item.id === target.locationId)?.name].filter(Boolean).join(" · ")
      : statusLabel(target.status);
    if (!confirm(`确认将清单内 ${items.length} 件样品统一流转为“${targetName}”吗？`)) return;
    setSaving(true);
    try {
      const result = await apiFetch<BatchResult>("/api/samples/batch", {
        method: "POST",
        body: JSON.stringify({ batchId, sampleIds: items.map((item) => item.id), ...target, departmentId: target.status === "active" ? target.departmentId : null, locationId: target.status === "active" ? target.locationId || null : null }),
      });
      const resultMap = new Map(result.results.map((item) => [item.sampleId, item]));
      const failed = items.filter((item) => !resultMap.get(item.id)?.success).map((item) => ({ ...item, error: resultMap.get(item.id)?.message || "未完成，请重试" }));
      itemsRef.current = failed; setItems(failed);
      if (failed.length === 0) {
        stopCamera(); localStorage.removeItem(draftKey); setHydrated(false);
        setCompleted({ total: result.results.length, updated: result.updated });
      } else {
        signal("error", `已完成 ${items.length - failed.length} 件，${failed.length} 件未完成并保留在清单中`);
      }
    } catch (reason) {
      signal("error", reason instanceof Error ? reason.message : "批量流转失败，请重试");
    } finally {
      setSaving(false);
    }
  }

  function cancelBatch() {
    if (items.length > 0 && !confirm("确定取消本批流转吗？已扫描清单和操作草稿将被清除。")) return;
    localStorage.removeItem(draftKey); stopCamera(); onBack();
  }

  if (completed) return <>
    <PageHeader eyebrow="批量扫码流转" title="本批流转已完成" description="本批操作与本地草稿均已结束，不会自动带入下一批。" actions={<button className="button button-ghost" onClick={onBack}><ArrowLeft size={17} />返回扫码首页</button>} />
    <section className="panel batch-complete"><CheckCircle2 size={64} /><h2>{completed.total} 件样品已确认完成</h2><p>其中 {completed.updated} 件的位置或状态发生了变化，其余样品已在目标位置或属于安全重试。</p><button className="button button-primary" onClick={onBack}>完成并返回</button></section>
  </>;

  return <>
    <PageHeader eyebrow="连续扫码" title="批量流转样品" description="先选择本批统一操作，再连续扫描每一件样品，最后整体确认。" actions={<><button className="button button-ghost" onClick={cancelBatch}><ArrowLeft size={17} />返回</button><button className="button button-secondary" onClick={() => setMuted((value) => !value)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}{muted ? "提示音已静音" : "声音与震动"}</button></>} />
    {restored && <div className="draft-restored"><CheckCircle2 size={18} /><span>已自动恢复上次未完成的批次，共 {items.length} 件样品。</span><button onClick={() => setRestored(false)}>知道了</button></div>}
    <section className="panel batch-target-panel">
      <div className="panel-header"><div><p className="eyebrow">第 1 步</p><h2>选择统一操作</h2></div>{items.length > 0 && <span className="batch-warning">修改这里会同时作用于清单内全部 {items.length} 件样品</span>}</div>
      <div className="batch-target-form"><Field label="流转后的状态" required><div className="status-picker compact-status-picker">{SAMPLE_STATUSES.map((item) => <label className={target.status === item.value ? "selected" : ""} key={item.value}><input type="radio" name="batchScanStatus" checked={target.status === item.value} onChange={() => setTarget({ ...target, status: item.value, departmentId: item.value === "active" ? target.departmentId : "", locationId: "" })} /><StatusBadge status={item.value} /></label>)}</div></Field>{target.status === "active" && <div className="form-grid"><Field label="目标部门" required><select value={target.departmentId} onChange={(event) => setTarget({ ...target, departmentId: event.target.value, locationId: "" })}><option value="">请选择部门</option>{lookups?.departments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="具体位置"><select value={target.locationId} onChange={(event) => setTarget({ ...target, locationId: event.target.value })}><option value="">暂不细分</option>{locations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>}<Field label="本批备注" hint="选填，将写入本批每一件样品的流转记录。"><textarea rows={2} value={target.remark} onChange={(event) => setTarget({ ...target, remark: event.target.value })} placeholder="例如：A 直播间使用完归还商务部" /></Field></div>
    </section>
    <section className="batch-scan-grid">
      <div className="panel scanner-card"><div className="panel-header"><div><p className="eyebrow">第 2 步</p><h2>连续扫描样品</h2></div><b className="batch-counter">{items.length}<small>/100</small></b></div><div className={`camera-frame batch-camera ${running ? "running" : ""}`}><video ref={videoRef} muted playsInline /><div className="scan-corners"><i /><i /><i /><i /></div>{!running && <div className="camera-placeholder"><ScanLine size={50} /><h2>{targetReady ? "将条形码依次放入框内" : "请先完成统一操作"}</h2><p>识别成功后无需停顿或保存，可继续扫下一件</p></div>}</div><div className="scanner-actions">{running ? <button className="button button-secondary" type="button" onClick={stopCamera}><X size={18} />停止扫描</button> : <button className="button button-primary" type="button" onClick={startCamera} disabled={starting || !targetReady}>{starting ? "正在启动…" : <><Camera size={18} />打开摄像头连续扫码</>}</button>}<input ref={fileRef} className="scan-file-input" type="file" accept="image/*" capture="environment" onChange={scanImage} /><button className="button button-secondary" type="button" disabled={readingImage || !targetReady} onClick={() => fileRef.current?.click()}><Camera size={18} />{readingImage ? "正在识别…" : "拍照识别"}</button></div>{cameraError && <p className="inline-hint scanner-error">{cameraError}</p>}{feedback && <div className={`scan-feedback scan-feedback-${feedback.kind}`}>{feedback.kind === "success" ? <CheckCircle2 size={18} /> : feedback.kind === "duplicate" ? <ScanLine size={18} /> : <X size={18} />}<span>{feedback.message}</span></div>}<form className="batch-manual-form" onSubmit={submitManual}><Keyboard size={19} /><input value={manual} disabled={!targetReady} onChange={(event) => setManual(event.target.value)} placeholder="扫码枪可直接输入；也可手动输入编号后回车" autoCapitalize="characters" autoComplete="off" /><button className="button button-secondary button-compact" disabled={!manual.trim() || !targetReady}>加入</button></form></div>
      <div className="panel batch-list-panel"><div className="panel-header"><div><p className="eyebrow">第 3 步</p><h2>核对本批清单</h2></div>{items.length > 0 && <button className="text-button" onClick={() => { if (confirm("清空已扫描的全部样品吗？")) { itemsRef.current = []; setItems([]); } }}>清空</button>}</div>{items.length === 0 ? <div className="batch-empty"><ScanLine size={42} /><b>还没有扫描样品</b><span>每次识别成功后会自动加入这里</span></div> : <div className="batch-items">{items.map((item, index) => <article className={`batch-item ${item.error ? "has-error" : ""}`} key={item.id}><span className="batch-item-index">{index + 1}</span><ProductImage urls={item.imageUrls} alt={item.productName} size="small" /><div className="batch-item-main"><div><b>{item.productName}</b><StatusBadge status={item.status} /></div><code>{item.code}</code><small><MapPin size={13} />{activeLocationLabel({ status: item.status, department_name: item.departmentName, location_name: item.locationName })}</small>{item.error && <p>{item.error}</p>}</div><button className="icon-button" aria-label={`移除 ${item.code}`} onClick={() => removeItem(item.id)}><Trash2 size={17} /></button></article>)}</div>}<div className="batch-submit"><p>确认后，有效样品会立即完成流转；失败项会保留并显示原因。</p><button className="button button-primary" disabled={saving || items.length === 0 || !targetReady} onClick={submitBatch}>{saving ? "正在确认…" : `确认流转 ${items.length} 件样品`}</button></div></div>
    </section>
  </>;
}
