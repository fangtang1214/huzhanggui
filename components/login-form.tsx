"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, Boxes, Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "登录失败");
      window.location.href = returnTo.startsWith("/") ? returnTo : "/";
    } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setLoading(false); }
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-mark brand-mark-large"><Boxes size={29} /></div>
        <div>
          <p className="eyebrow">SIYUAN LIVE COMMERCE</p>
          <h1>每一件样品，<br />现在都清楚在哪里。</h1>
          <p className="login-intro">从商务部到直播间，从到样到退样，完整记录每一次流转。</p>
        </div>
        <div className="login-flow" aria-hidden="true">
          <span>到样登记</span><i /><span>直播间</span><i /><span>归还 / 退样</span>
        </div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="mobile-login-logo"><div className="brand-mark"><Boxes size={22} /></div><b>斯源直播</b></div>
          <p className="eyebrow">欢迎回来</p>
          <h2>登录样品管理系统</h2>
          <p className="muted">请输入管理员为你创建的账号和密码</p>
          <label className="field-label" htmlFor="username">账号</label>
          <div className="input-icon"><UserRound size={18} /><input id="username" autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} placeholder="请输入账号" /></div>
          <label className="field-label" htmlFor="password">密码</label>
          <div className="input-icon"><LockKeyhole size={18} /><input id="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /><button type="button" className="icon-plain" onClick={() => setShowPassword((value) => !value)} aria-label="显示或隐藏密码">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="button button-primary login-submit" disabled={loading}>{loading ? "正在登录…" : <>进入系统 <ArrowRight size={18} /></>}</button>
          <p className="login-help">忘记密码请联系系统管理员重置</p>
        </form>
      </section>
    </main>
  );
}

