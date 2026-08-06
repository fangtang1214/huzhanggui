"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { CurrentUser } from "@/lib/auth";
import { AppDataProvider, ToastProvider, apiFetch } from "./client-utils";
import { DashboardView } from "./views/dashboard-view";
import { ProductsView, ProductFormView, ProductDetailView } from "./views/products-view";
import { SamplesView, SampleDetailView, ScannerView } from "./views/samples-view";
import { MovementsView } from "./views/movements-view";
import { OrganizationView } from "./views/organization-view";
import { UsersView } from "./views/access-view";
import { AuditsView, BackupsView, ProfileView, SystemUpdateView } from "./views/system-view";
import { TalentAccountsView } from "./views/talent-accounts-view";
import { LeagueAccountsView } from "./views/league-accounts-view";
import { WindowProductsView } from "./views/window-products-view";
import { RecognitionView } from "./views/recognition-view";
import { LinkIssuesView } from "./views/link-issues-view";
import { Boxes, BrainCircuit, ChevronDown, CircleAlert, CircleGauge, ClipboardList, FolderKanban, History, LayoutGrid, LogOut, MapPin, Menu, PackagePlus, RefreshCw, ScanLine, Settings2, ShieldCheck, ShoppingBag, Store, Tags, UserCog, UsersRound, Warehouse, X } from "lucide-react";

const primaryNav = [
  { href: "/", key: "dashboard", label: "工作台", permission: "dashboard:view", icon: CircleGauge },
  { href: "/products", key: "products", label: "商品档案", permission: "products:view", icon: FolderKanban },
  { href: "/link-issues", key: "link-issues", label: "问题处理", permission: "", icon: CircleAlert },
  { href: "/samples", key: "samples", label: "实物样品", permission: "samples:view", icon: Boxes },
  { href: "/scan", key: "scan", label: "扫码流转", permission: "samples:view", icon: ScanLine },
  { href: "/movements", key: "movements", label: "流转记录", permission: "movements:view", icon: History },
];
const manageNav = [
  { href: "/departments", key: "departments", label: "部门管理", permission: "departments:view", icon: LayoutGrid },
  { href: "/locations", key: "locations", label: "位置管理", permission: "locations:view", icon: MapPin },
  { href: "/catalog", key: "catalog", label: "分类标签", permission: "catalog:manage", icon: Tags },
  { href: "/users", key: "users", label: "账号管理", permission: "users:view", icon: UserCog },
  { href: "/recognition", key: "recognition", label: "图片识别", permission: "image_matching:manage|products:correct_merge", icon: BrainCircuit },
  { href: "/audits", key: "audits", label: "操作日志", permission: "audits:view", icon: ClipboardList },
  { href: "/backups", key: "backups", label: "数据备份", permission: "backups:view", icon: Warehouse },
  { href: "/system-update", key: "system-update", label: "系统更新", permission: "*", icon: RefreshCw },
];
const wechatShopNav = [
  { href: "/window-products", key: "window-products", label: "橱窗管理", permission: "products:view", icon: ShoppingBag },
  { href: "/talent-accounts", key: "talent-accounts", label: "带货账号", permission: "*", icon: Store },
  { href: "/league-accounts", key: "league-accounts", label: "联盟机构", permission: "*", icon: ShieldCheck },
];

type NavEntry = (typeof primaryNav)[number] | (typeof manageNav)[number];

function NavGroup({ items, label, can, pathname, onNavigate, pendingIssueCount = 0 }: { items: readonly NavEntry[]; label?: string; can: (permission: string) => boolean; pathname: string; onNavigate: () => void; pendingIssueCount?: number }) {
  return <>{label && <p className="nav-label">{label}</p>}<nav>{items.filter((item) => !item.permission || item.permission.split("|").some(can)).map((item) => { const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href); const Icon = item.icon; return <Link className={active ? "active" : ""} href={item.href} key={item.key} onClick={onNavigate}><Icon size={19} /><span>{item.label}</span>{item.key === "link-issues" && pendingIssueCount > 0 && <b className="nav-count" aria-label={`${pendingIssueCount} 条待处理问题`}>{pendingIssueCount > 99 ? "99+" : pendingIssueCount}</b>}</Link>; })}</nav></>;
}

function viewTitle(path: string[]) {
  if (path[0] === "products" && path[1] === "new") return "登记新商品";
  if (path[0] === "products" && path[1]) return "商品详情";
  if (path[0] === "samples" && path[1]) return "样品详情";
  return [...primaryNav, ...manageNav].find((item) => item.key === (path[0] || "dashboard"))?.label || "狐掌柜";
}

function ViewRouter({ path }: { path: string[] }) {
  const view = path[0] || "dashboard";
  if (view === "dashboard") return <DashboardView />;
  if (view === "products" && path[1] === "new") return <ProductFormView />;
  if (view === "products" && path[1] && path[2] === "edit") return <ProductFormView id={path[1]} />;
  if (view === "products" && path[1]) return <ProductDetailView id={path[1]} />;
  if (view === "products") return <ProductsView />;
  if (view === "link-issues") return <LinkIssuesView />;
  if (view === "samples" && path[1]) return <SampleDetailView id={path[1]} />;
  if (view === "samples") return <SamplesView />;
  if (view === "scan") return <ScannerView />;
  if (view === "movements") return <MovementsView />;
  if (view === "departments" || view === "locations" || view === "catalog") return <OrganizationView section={view} />;
  if (view === "users") return <UsersView />;
  if (view === "recognition") return <RecognitionView />;
  if (view === "audits") return <AuditsView />;
  if (view === "backups") return <BackupsView />;
  if (view === "window-products") return <WindowProductsView />;
  if (view === "talent-accounts") return <TalentAccountsView />;
  if (view === "league-accounts") return <LeagueAccountsView />;
  if (view === "system-update") return <SystemUpdateView />;
  if (view === "profile") return <ProfileView />;
  return <DashboardView />;
}

export function HuZhangGuiApp({ initialUser, path }: { initialUser: CurrentUser; path: string[] }) {
  const [sidebarOpen, setSidebarOpen] = useState(false); const [userOpen, setUserOpen] = useState(false); const [sampleOpen, setSampleOpen] = useState(true); const [manageOpen, setManageOpen] = useState(false); const [windowOpen, setWindowOpen] = useState(false); const [pendingIssueCount, setPendingIssueCount] = useState(0); const pathname = usePathname();
  const can = (permission: string) => initialUser.isSuperAdmin || initialUser.permissions.includes(permission);
  const refreshPendingIssueCount = useCallback(async () => {
    try { const result = await apiFetch<{ count: number }>("/api/link-issues/count"); setPendingIssueCount(result.count); } catch { setPendingIssueCount(0); }
  }, []);
  useEffect(() => { void refreshPendingIssueCount(); }, [pathname, refreshPendingIssueCount]);
  useEffect(() => { const refresh = () => { void refreshPendingIssueCount(); }; window.addEventListener("link-issues:changed", refresh); return () => window.removeEventListener("link-issues:changed", refresh); }, [refreshPendingIssueCount]);
  async function logout() { await apiFetch("/api/auth/logout", { method: "POST" }); window.location.href = "/login"; }
  return <ToastProvider><AppDataProvider user={initialUser}>
    <div className="app-shell">
      {sidebarOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand"><div className="brand-mark"><Image src="/brand/huzhanggui-logo.png" alt="" width={42} height={42} priority /></div><div><b>狐掌柜</b><span>直播样品管理系统</span></div><button className="mobile-close icon-button" onClick={() => setSidebarOpen(false)}><X size={20} /></button></div>
        <div className="sidebar-nav">
          <button type="button" className={`nav-fold-header ${primaryNav.some((item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) ? "nav-fold-active" : ""}`} onClick={() => setSampleOpen((v) => !v)}><Boxes size={18} /><span style={{ flex: 1, textAlign: "left" }}>样品管理</span><ChevronDown size={15} style={{ transform: sampleOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} /></button>
          {sampleOpen && <NavGroup items={primaryNav} can={can} pathname={pathname} onNavigate={() => setSidebarOpen(false)} pendingIssueCount={pendingIssueCount} />}
          {(() => { const visible = manageNav.filter((item) => !item.permission || item.permission.split("|").some(can)); if (!visible.length) return null; const active = visible.some((item) => pathname.startsWith(item.href)); return <div><button type="button" className={`nav-fold-header ${active ? "nav-fold-active" : ""}`} onClick={() => setManageOpen((v) => !v)}><Settings2 size={18} /><span style={{ flex: 1, textAlign: "left" }}>系统管理</span><ChevronDown size={15} style={{ transform: manageOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} /></button>{manageOpen && <NavGroup items={manageNav} can={can} pathname={pathname} onNavigate={() => setSidebarOpen(false)} />}</div>; })()}
          {(() => { const visible = wechatShopNav.filter((item) => !item.permission || item.permission.split("|").some(can)); if (!visible.length) return null; const active = visible.some((item) => pathname.startsWith(item.href)); return <div><button type="button" className={`nav-fold-header ${active ? "nav-fold-active" : ""}`} onClick={() => setWindowOpen((v) => !v)}><Store size={18} /><span style={{ flex: 1, textAlign: "left" }}>橱窗数据</span><ChevronDown size={15} style={{ transform: windowOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} /></button>{windowOpen && <nav style={{ paddingLeft: 10 }}>{visible.map((item) => { const Icon = item.icon; return <Link className={pathname.startsWith(item.href) ? "active" : ""} href={item.href} key={item.key} onClick={() => setSidebarOpen(false)}><Icon size={17} /><span>{item.label}</span></Link>; })}</nav>}</div>; })()}
        </div>
        <div className="sidebar-foot"><div className="department-chip"><UsersRound size={16} /><span>{initialUser.departmentName}</span></div><small>数据持续自动保存</small></div>
      </aside>
      <div className="app-main">
        <header className="topbar"><div className="topbar-title"><button className="mobile-menu icon-button" onClick={() => setSidebarOpen(true)}><Menu size={21} /></button><h2>{viewTitle(path)}</h2></div><div className="topbar-actions">{can("products:create") && <Link href="/products/new" className="button button-primary button-compact"><PackagePlus size={17} /><span>登记到样</span></Link>}{can("samples:view") && <Link href="/scan" className="icon-button scan-shortcut" aria-label="扫码"><ScanLine size={20} /></Link>}<div className="user-menu"><button className="user-button" onClick={() => setUserOpen((value) => !value)}><span className="avatar">{initialUser.name.slice(0, 1)}</span><span className="user-copy"><b>{initialUser.name}</b><small>{initialUser.isSuperAdmin ? "超级管理员" : initialUser.departmentName}</small></span><ChevronDown size={16} /></button>{userOpen && <div className="user-dropdown"><Link href="/profile" onClick={() => setUserOpen(false)}><Settings2 size={17} />账号设置</Link><button onClick={logout}><LogOut size={17} />退出登录</button></div>}</div></div></header>
        <main className="page-content"><ViewRouter path={path} /></main>
      </div>
    </div>
  </AppDataProvider></ToastProvider>;
}
