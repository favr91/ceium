"use client";
// Header de la tienda (réplica del header Dawn de ceium.net): logo, menú de escritorio con desplegables
// (Educación 2026), cajón de menú móvil con submenús deslizantes, buscador predictivo, cuenta y carrito.
// Comportamiento "sticky al subir": se oculta al bajar y reaparece al subir, como en ceium.net.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { NavItem, SocialLink } from "./chrome-data";
import { IconAccount, IconArrow, IconCaret, IconCart, IconCartEmpty, IconClose, IconHamburger, IconSearch, SOCIAL_ICONS, SOCIAL_LABELS } from "./icons";
import { PredictiveSearch } from "./PredictiveSearch";
import { readCartCount } from "./cart-count-action";

export const CART_COUNT_EVENT = "ceium:cart-count";
const noopSubscribe = () => () => {};

export interface StoreHeaderProps {
  menu: NavItem[];
  campusUrl: string;
  social: SocialLink[];
  cartCount: number;
}

function isActive(item: NavItem, pathname: string) {
  return !!item.href && !item.external && item.href === pathname;
}

function MenuLink({ item, className, children, onNavigate, id }: { item: NavItem; className: string; children: React.ReactNode; onNavigate?: () => void; id?: string }) {
  const pathname = usePathname();
  const active = isActive(item, pathname);
  if (item.external) {
    return (
      <a id={id} href={item.href} className={className} onClick={onNavigate}>
        {children}
      </a>
    );
  }
  return (
    <Link id={id} href={item.href ?? "#"} className={className} aria-current={active ? "page" : undefined} onClick={onNavigate}>
      {children}
    </Link>
  );
}

// ───────────────────────────── Menú de escritorio ─────────────────────────────

function DesktopMenu({ menu }: { menu: NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);
  const [nested, setNested] = useState<Set<string>>(new Set());
  const navRef = useRef<HTMLElement>(null);

  const close = useCallback(() => {
    setOpen(null);
    setNested(new Set());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const summary = navRef.current?.querySelector<HTMLElement>(`[data-dropdown="${open}"] > summary`);
      close();
      summary?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("ceium:close-menus", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("ceium:close-menus", close);
    };
  }, [open, close]);

  // Al navegar se cierra (ajuste de estado durante el render, patrón recomendado por React).
  const [menuPath, setMenuPath] = useState(pathname);
  if (menuPath !== pathname) {
    setMenuPath(pathname);
    setOpen(null);
    setNested(new Set());
  }

  const toggleNested = (id: string) =>
    setNested((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <nav className="header__inline-menu" ref={navRef} aria-label="Menú principal">
      <ul className="list-menu list-menu--inline" role="list">
        {menu.map((item) =>
          item.children ? (
            <li key={item.id}>
              <details data-dropdown={item.id} open={open === item.id}>
                <summary
                  className="header__menu-item list-menu__item link"
                  aria-expanded={open === item.id}
                  aria-controls={`HeaderMenu-${item.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    if (open === item.id) close();
                    else {
                      setNested(new Set());
                      setOpen(item.id);
                    }
                  }}
                >
                  <span>{item.title}</span>
                  <IconCaret />
                </summary>
                <ul id={`HeaderMenu-${item.id}`} className="header__submenu list-menu list-menu--disclosure global-settings-popup" role="list">
                  {item.children.map((child) =>
                    child.children ? (
                      <li key={child.id}>
                        <details open={nested.has(child.id)}>
                          <summary
                            className="header__menu-item link link--text list-menu__item"
                            aria-expanded={nested.has(child.id)}
                            aria-controls={`HeaderMenu-${child.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              toggleNested(child.id);
                            }}
                          >
                            <span>{child.title}</span>
                            <IconCaret />
                          </summary>
                          <ul id={`HeaderMenu-${child.id}`} className="header__submenu list-menu" role="list">
                            {child.children.map((leaf) => (
                              <li key={leaf.id}>
                                <MenuLink item={leaf} className="header__menu-item list-menu__item link link--text" onNavigate={close}>
                                  {leaf.title}
                                </MenuLink>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </li>
                    ) : (
                      <li key={child.id}>
                        <MenuLink item={child} className="header__menu-item list-menu__item link link--text" onNavigate={close}>
                          {child.title}
                        </MenuLink>
                      </li>
                    ),
                  )}
                </ul>
              </details>
            </li>
          ) : (
            <li key={item.id}>
              <MenuLink item={item} className="header__menu-item list-menu__item link link--text">
                <span className={isActive(item, pathname) ? "header__active-menu-item" : undefined}>{item.title}</span>
              </MenuLink>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

// ───────────────────────────── Cajón de menú (móvil / tablet) ─────────────────────────────

function DrawerList({
  items,
  path,
  depth,
  onOpenSub,
  onBack,
  onNavigate,
}: {
  items: NavItem[];
  path: string[];
  depth: number;
  onOpenSub: (id: string, depth: number) => void;
  onBack: (depth: number) => void;
  onNavigate: () => void;
}) {
  const pathname = usePathname();
  return (
    <ul className="menu-drawer__menu list-menu" role="list">
      {items.map((item) => {
        if (!item.children) {
          const active = isActive(item, pathname);
          return (
            <li key={item.id}>
              <MenuLink item={item} className={`menu-drawer__menu-item list-menu__item link link--text${active ? " menu-drawer__menu-item--active" : ""}`} onNavigate={onNavigate}>
                {item.title}
              </MenuLink>
            </li>
          );
        }
        const isOpen = path[depth] === item.id;
        return (
          <li key={item.id}>
            <button
              type="button"
              className="menu-drawer__menu-item list-menu__item link link--text menu-drawer__menu-item--parent"
              aria-expanded={isOpen}
              aria-controls={`Drawer-${item.id}`}
              onClick={() => onOpenSub(item.id, depth)}
              tabIndex={path.length > depth ? -1 : undefined}
            >
              {item.title}
              <span className="svg-wrapper">
                <IconArrow />
              </span>
            </button>
            <div id={`Drawer-${item.id}`} className={`menu-drawer__submenu${isOpen ? " is-open" : ""}`} aria-hidden={!isOpen} inert={!isOpen}>
              <div className="menu-drawer__inner-submenu">
                <button type="button" className="menu-drawer__close-button link link--text" data-back-for={item.id} onClick={() => onBack(depth)}>
                  <span className="svg-wrapper">
                    <IconArrow />
                  </span>
                  {item.title}
                </button>
                <DrawerList items={item.children} path={path} depth={depth + 1} onOpenSub={onOpenSub} onBack={onBack} onNavigate={onNavigate} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function MenuDrawer({
  menu,
  campusUrl,
  social,
  open,
  onClose,
}: {
  menu: NavItem[];
  campusUrl: string;
  social: SocialLink[];
  open: boolean;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => setPath([]), 250);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Como Dawn: al abrir un submenú el foco pasa a su botón «volver»; al volver, al elemento que lo abrió.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const sel = pendingFocus.current;
    pendingFocus.current = null;
    if (sel) ref.current?.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
  }, [path]);

  const openSub = (id: string, depth: number) => {
    pendingFocus.current = `[data-back-for="${id}"]`;
    setPath((p) => [...p.slice(0, depth), id]);
  };
  const back = (depth: number) => {
    const closing = path[depth];
    if (closing) pendingFocus.current = `[aria-controls="Drawer-${closing}"]`;
    setPath((p) => p.slice(0, depth));
  };

  return (
    <div id="menu-drawer" ref={ref} className={`menu-drawer${open ? " is-open" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="menu-drawer__inner-container">
        <div className="menu-drawer__navigation-container">
          <nav className={`menu-drawer__navigation${path.length ? " submenu-open" : ""}`} aria-label="Menú">
            <DrawerList items={menu} path={path} depth={0} onOpenSub={openSub} onBack={back} onNavigate={onClose} />
          </nav>
          <div className="menu-drawer__utility-links">
            <a href={campusUrl} className="menu-drawer__account link focus-inset">
              <span className="svg-wrapper">
                <IconAccount />
              </span>
              Iniciar sesión
            </a>
            <p className="menu-drawer__localization">Venezuela | USD $</p>
            <ul className="list list-social list-unstyled" role="list">
              {social.map((s) => {
                const Icon = SOCIAL_ICONS[s.network];
                return (
                  <li key={s.network} className="list-social__item">
                    <a href={s.url} className="list-social__link link" target="_blank" rel="noopener noreferrer">
                      <span className="svg-wrapper">
                        <Icon />
                      </span>
                      <span className="visually-hidden">{SOCIAL_LABELS[s.network]}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── Header ─────────────────────────────

export function StoreHeader({ menu, campusUrl, social, cartCount: initialCartCount }: StoreHeaderProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [cartCount, setCartCount] = useState(initialCartCount);
  const [sticky, setSticky] = useState<"top" | "visible" | "hidden">("top");
  const stickyRef = useRef<"top" | "visible" | "hidden">("top");
  // true solo en el cliente ya hidratado (los tests e2e esperan `data-ready` antes de interactuar).
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerId = useId();

  const [prevInitialCount, setPrevInitialCount] = useState(initialCartCount);
  if (prevInitialCount !== initialCartCount) {
    setPrevInitialCount(initialCartCount);
    setCartCount(initialCartCount);
  }
  useEffect(() => {
    const onCount = (e: Event) => {
      const n = Number((e as CustomEvent<{ count?: number }>).detail?.count);
      if (Number.isFinite(n)) setCartCount(Math.max(0, n));
    };
    window.addEventListener(CART_COUNT_EVENT, onCount);
    return () => window.removeEventListener(CART_COUNT_EVENT, onCount);
  }, []);

  // Al navegar: cierra menús y refresca la burbuja del carrito (el layout compartido no se vuelve a renderizar).
  const [headerPath, setHeaderPath] = useState(pathname);
  if (headerPath !== pathname) {
    setHeaderPath(pathname);
    setDrawerOpen(false);
    setSearchOpen(false);
  }
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    let alive = true;
    readCartCount()
      .then((n) => alive && setCartCount(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pathname]);

  // Altura del header para el cajón (ocupa el resto de la ventana) y para ocultarlo al bajar.
  const measure = useCallback(() => {
    const w = wrapperRef.current;
    if (!w) return;
    const r = w.getBoundingClientRect();
    document.documentElement.style.setProperty("--header-bottom-position", `${Math.round(r.bottom)}px`);
    document.documentElement.style.setProperty("--header-height", `${Math.round(r.height)}px`);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Sticky "al subir" (Dawn: on-scroll-up).
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const section = sectionRef.current;
      if (!section) return;
      const y = window.scrollY;
      // offsetTop de un elemento sticky incluye el desplazamiento "pegado": se mide la posición natural
      // a partir de lo que tiene encima (la barra de anuncio).
      const prev = section.previousElementSibling as HTMLElement | null;
      const top = prev ? prev.offsetTop + prev.offsetHeight : 0;
      const bottom = top + section.offsetHeight;
      let next = stickyRef.current;
      if (y > last && y > bottom) next = "hidden";
      else if (y < last && y > bottom) next = "visible";
      else if (y <= top) next = "top";
      if (next !== stickyRef.current) {
        // Como Dawn: al ocultarse el header se cierran sus desplegables.
        if (next === "hidden") window.dispatchEvent(new Event("ceium:close-menus"));
        stickyRef.current = next;
        setSticky(next);
      }
      last = Math.max(0, y);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Cajón abierto: bloquea el scroll del documento (móvil/tablet) y Escape lo cierra.
  useEffect(() => {
    if (!drawerOpen) return;
    measure();
    document.body.classList.add("overflow-hidden-tablet");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    const onResize = () => {
      if (window.matchMedia("(min-width: 990px)").matches) setDrawerOpen(false);
      else measure();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.classList.remove("overflow-hidden-tablet");
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [drawerOpen, measure]);

  
  return (
    <div
      ref={sectionRef}
      data-ready={ready ? "" : undefined}
      className={`section-header${sticky === "hidden" && !drawerOpen && !searchOpen ? " section-header--hidden" : ""}${sticky !== "top" ? " section-header--animate" : ""}${drawerOpen ? " menu-open" : ""}`}
    >
      <div ref={wrapperRef} className="header-wrapper header-wrapper--border-bottom">
        <header className="header page-width">
          <div className="header__drawer">
            <button
              ref={menuButtonRef}
              type="button"
              className={`header__icon header__icon--menu link${drawerOpen ? " is-open" : ""}`}
              aria-label={drawerOpen ? "Cerrar menú" : "Menú"}
              aria-expanded={drawerOpen}
              aria-controls="menu-drawer"
              data-drawer={drawerId}
              onClick={() => {
                setSearchOpen(false);
                setDrawerOpen((o) => !o);
              }}
            >
              <span>
                <IconHamburger />
                <IconClose />
              </span>
            </button>
            <MenuDrawer menu={menu} campusUrl={campusUrl} social={social} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
          </div>

          <div className="header__heading">
            <Link href="/" className="header__heading-link link link--text">
              <span className="header__heading-logo-wrapper">
                {/* eslint-disable-next-line @next/next/no-img-element -- logo SVG vectorial, sin optimización */}
                <img src="/store/logo-ceium.svg" alt="CEIUM" width={150} height={54} className="header__heading-logo" />
              </span>
            </Link>
          </div>

          <DesktopMenu menu={menu} />

          <div className="header__icons">
            <button
              ref={searchButtonRef}
              type="button"
              className="header__icon header__icon--search link"
              aria-label="Búsqueda"
              aria-expanded={searchOpen}
              aria-haspopup="dialog"
              onClick={() => {
                setDrawerOpen(false);
                setSearchOpen(true);
              }}
            >
              <span className="svg-wrapper">
                <IconSearch />
              </span>
            </button>
            <a href={campusUrl} className="header__icon header__icon--account link" aria-label="Iniciar sesión" rel="nofollow">
              <span className="svg-wrapper">
                <IconAccount />
              </span>
            </a>
            <Link href="/cart" className="header__icon header__icon--cart link" id="cart-icon-bubble" aria-label={cartCount > 0 ? `Carrito, ${cartCount} ${cartCount === 1 ? "artículo" : "artículos"}` : "Carrito"}>
              {cartCount > 0 ? <IconCart /> : <IconCartEmpty />}
              {cartCount > 0 ? (
                <span className="cart-count-bubble" aria-hidden="true">
                  {cartCount < 100 ? cartCount : ""}
                </span>
              ) : null}
            </Link>
          </div>
        </header>

        {searchOpen ? (
          <PredictiveSearch
            onClose={() => {
              setSearchOpen(false);
              searchButtonRef.current?.focus();
            }}
          />
        ) : null}
      </div>
      {drawerOpen ? <div className="menu-drawer-overlay" aria-hidden="true" onClick={() => setDrawerOpen(false)} /> : null}
    </div>
  );
}
