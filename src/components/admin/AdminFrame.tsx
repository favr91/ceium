"use client";
// Marco del panel: barra superior (marca, búsqueda, usuario) + navegación lateral (cajón en móvil).
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { logoutAction } from "@/app/admin/auth-actions";
import { Icon } from "./Icon";

interface NavItem { href: string; label: string; icon: string; sub?: { href: string; label: string }[] }
const NAV: NavItem[] = [
  { href: "/admin", label: "Inicio", icon: "home" },
  { href: "/admin/orders", label: "Pedidos", icon: "order" },
  {
    href: "/admin/products",
    label: "Programas",
    icon: "product",
    sub: [
      { href: "/admin/collections", label: "Colecciones" },
      { href: "/admin/cohorts", label: "Cohortes" },
      { href: "/admin/sedes", label: "Sedes" },
    ],
  },
  { href: "/admin/customers", label: "Clientes", icon: "customer" },
  { href: "/admin/enrollments", label: "Matrículas", icon: "enroll" },
  { href: "/admin/certificates", label: "Certificados", icon: "certificate" },
];

function isActive(path: string, href: string) {
  return href === "/admin" ? path === "/admin" : path === href || path.startsWith(href + "/");
}

export function AdminFrame({ user, children }: { user: { name: string; email: string; role: string }; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const initials = user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "A";

  // Al navegar se cierra el cajón (ajuste de estado durante el render, sin efecto).
  const [lastPath, setLastPath] = useState(path);
  if (lastPath !== path) { setLastPath(path); setOpen(false); }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "Escape") { setMenu(false); setOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="adm-top">
        <button className="adm-hamburger" aria-label="Abrir menú" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name="menu" />
        </button>
        <Link href="/admin" className="adm-brand" aria-label="Panel CEIUM">
          <span className="adm-brand-mark">C</span>
          <span>CEIUM</span>
          <small>Panel</small>
        </Link>
        <form
          className="adm-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = searchRef.current?.value.trim() ?? "";
            router.push(q ? `/admin/products?q=${encodeURIComponent(q)}` : "/admin/products");
          }}
        >
          <Icon name="search" />
          <input ref={searchRef} type="search" placeholder="Buscar programas" aria-label="Buscar programas" />
          <kbd>Ctrl K</kbd>
        </form>
        <div className="adm-user">
          <button className="adm-user-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            <span className="nm">{user.name}</span>
            <span className="adm-avatar">{initials}</span>
          </button>
          {menu ? (
            <div className="adm-user-menu" role="menu">
              <div className="who">
                <b>{user.name}</b>
                <span>{user.email} · {user.role === "ADMIN" ? "Administrador" : "Personal"}</span>
              </div>
              <Link className="adm-menu-item" href="/admin/account" role="menuitem" onClick={() => setMenu(false)}><Icon name="shield" size={18} /> Mi cuenta y seguridad</Link>
              <a className="adm-menu-item" href="/" target="_blank" rel="noreferrer" role="menuitem"><Icon name="external" size={18} /> Ver tienda</a>
              <form action={logoutAction}>
                <button className="adm-menu-item" type="submit" role="menuitem"><Icon name="logout" size={18} /> Cerrar sesión</button>
              </form>
            </div>
          ) : null}
        </div>
      </header>
      <div className={`adm-scrim${open ? " open" : ""}`} onClick={() => setOpen(false)} />
      <nav className={`adm-nav${open ? " open" : ""}`} aria-label="Navegación del panel">
        <ul>
          {NAV.map((n) => {
            const act = isActive(path, n.href) && !(n.sub?.some((s) => isActive(path, s.href)));
            const groupOpen = isActive(path, n.href) || n.sub?.some((s) => isActive(path, s.href));
            return (
              <li key={n.href}>
                <Link href={n.href} className={`adm-nav-item${act ? " active" : ""}`} aria-current={act ? "page" : undefined}>
                  <Icon name={n.icon} />
                  {n.label}
                </Link>
                {n.sub && groupOpen ? (
                  <ul className="adm-nav-sub">
                    {n.sub.map((s) => (
                      <li key={s.href}>
                        <Link href={s.href} className={isActive(path, s.href) ? "active" : undefined}>{s.label}</Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="adm-nav-section">Canales de venta</div>
        <ul>
          <li>
            <a href="/" target="_blank" rel="noreferrer" className="adm-nav-item"><Icon name="globe" /> Tienda en línea</a>
          </li>
        </ul>
        <ul className="adm-nav-bottom">
          <li>
            <Link href="/admin/settings" className={`adm-nav-item${isActive(path, "/admin/settings") ? " active" : ""}`}><Icon name="settings" /> Configuración</Link>
          </li>
        </ul>
      </nav>
      <main className="adm-main">{children}</main>
    </>
  );
}
