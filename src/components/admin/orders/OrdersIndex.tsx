"use client";
// Índice de pedidos (réplica del índice de Pedidos de Shopify): pestañas con conteo, búsqueda, filtros
// (estado, método, modalidad), orden, selección con exportación, tabla (escritorio) y lista (móvil),
// paginación. El estado vive en la URL: todo se puede compartir y volver atrás.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "../Icon";
import { ExportButton } from "../ExportButton";
import { exportOptions } from "../export-options";
import { Badge, useDismiss } from "./bits";
import { METHOD_SHORT, ORDER_STATUS, enrollmentBadge, listDate, paymentBadge, usd } from "./format";
import type { OrderRow } from "@/server/admin-order-views";
import { toQuery, type IndexState } from "./query";

interface Props {
  rows: OrderRow[];
  counts: Record<string, number>;
  views: { key: string; label: string }[];
  sorts: { key: string; label: string }[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  state: IndexState;
  now: string;
}

const STATUS_OPTS = Object.entries(ORDER_STATUS).map(([k, v]) => ({ key: k, label: v.label }));
const METHOD_OPTS = Object.entries(METHOD_SHORT).map(([k, v]) => ({ key: k, label: v }));
const MODALITY_OPTS = [
  { key: "ONLINE", label: "Online" },
  { key: "SEMIPRESENCIAL", label: "Semipresencial" },
];

function FilterPill({ label, options, value, onChange }: { label: string; options: { key: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [ref, open, setOpen] = useDismiss<HTMLDivElement>();
  const on = value.length > 0;
  const shown = on ? `${label}: ${value.map((v) => options.find((o) => o.key === v)?.label ?? v).join(", ")}` : label;
  return (
    <div className="pill-wrap" ref={ref}>
      <button type="button" className={`pill${on ? " on" : ""}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((v) => !v)}>
        {shown}
        {on ? (
          <span
            className="x"
            role="button"
            tabIndex={0}
            aria-label={`Quitar filtro ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                onChange([]);
              }
            }}
          >
            <Icon name="x" size={14} />
          </span>
        ) : (
          <Icon name="chevronDown" size={14} />
        )}
      </button>
      {open ? (
        <div className="popover" role="group" aria-label={label}>
          {options.map((o) => {
            const sel = value.includes(o.key);
            return (
              <label key={o.key} className="opt">
                <input type="checkbox" className="cb" checked={sel} onChange={() => onChange(sel ? value.filter((v) => v !== o.key) : [...value, o.key])} />
                {o.label}
              </label>
            );
          })}
          {on ? (
            <>
              <div className="sep" />
              <button type="button" className="btn btn-plain" onClick={() => onChange([])}>Borrar</button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ItemsPopover({ row }: { row: OrderRow }) {
  const [ref, open, setOpen] = useDismiss<HTMLDivElement>();
  const n = row.items.length;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="itm-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {n} {n === 1 ? "programa" : "programas"} <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      {open ? (
        <div className="itm-pop" role="dialog" aria-label={`Programas del pedido #${row.number}`}>
          {row.items.map((i, k) => (
            <div key={k} className="it">
              <span className="thumb" style={{ width: 36, height: 36 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN del catálogo */}
                {i.image ? <img src={i.image} alt="" /> : <Icon name="product" />}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="t">{i.title}</div>
                <div className="s">{[i.modality === "ONLINE" ? "Online" : "Semipresencial", i.sede, i.cohort, i.plan].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="p">{usd(i.totalCents)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OrdersIndex({ rows, counts, views, sorts, total, page, pages, perPage, state, now }: Props) {
  const router = useRouter();
  const path = usePathname();
  const [pending, start] = useTransition();
  const [searchOpen, setSearchOpen] = useState(!!state.q || state.status.length + state.method.length + state.modality.length > 0);
  const [q, setQ] = useState(state.q);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sortRef, sortOpen, setSortOpen] = useDismiss<HTMLDivElement>();
  const inputRef = useRef<HTMLInputElement>(null);

  // Temporizador de la búsqueda con espera: toda navegación explícita (Enter, filtros, abrir un pedido) lo cancela, y
  // también desmontar el índice; si no, al vencer haría router.replace('/admin/orders?q=…') y devolvería al admin al
  // listado después de abrir un pedido.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSearch = () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = null;
  };
  // Estado PEDIDO más reciente (no solo el de la URL ya confirmada): si el admin pulsa una pestaña y enseguida un
  // filtro u orden, el filtro se aplica sobre la pestaña nueva aunque su página aún no haya llegado (antes volvía a
  // la vista anterior con el filtro). Cada navegación propia queda pendiente hasta que la URL la confirma; una
  // navegación ajena (atrás/adelante, enlace externo) descarta lo pendiente y manda la URL.
  const intent = useRef(state);
  const pendingKeys = useRef<string[]>([]);
  const committedKey = toQuery(state);
  useEffect(() => {
    const i = pendingKeys.current.indexOf(committedKey);
    if (i >= 0) pendingKeys.current = pendingKeys.current.slice(i + 1);
    else pendingKeys.current = [];
    if (pendingKeys.current.length === 0) intent.current = state;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedKey]);
  const request = (patch: Partial<IndexState>) => {
    const next = { ...intent.current, ...patch };
    intent.current = next;
    const k = toQuery(next);
    if (k !== committedKey || pendingKeys.current.length) pendingKeys.current.push(k);
    return k;
  };
  const go = (patch: Partial<IndexState>) => {
    cancelSearch();
    const k = request({ page: 1, ...patch });
    start(() => router.replace(`${path}${k}`, { scroll: false }));
  };
  /** Clic simple en un enlace del índice (pestaña, página): registra el estado pedido; los clics con modificador abren otra pestaña. */
  const onNavClick = (e: React.MouseEvent, patch: Partial<IndexState>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    request(patch);
  };

  // Búsqueda con espera (como el índice de Shopify: filtra mientras escribes).
  const [lastQ, setLastQ] = useState(state.q);
  if (lastQ !== state.q) {
    setLastQ(state.q);
    setQ(state.q);
  }
  // La espera navega con el estado de la URL VIGENTE al vencer (no el de cuando se tecleó): si entretanto se
  // pulsó «Cancelar», una pestaña o un filtro, una navegación rezagada no debe deshacerlos.
  const latest = useRef({ path });
  useEffect(() => {
    latest.current = { path };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = null;
    };
  }, []);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = null;
    if (q.trim() === state.q) return;
    const t = setTimeout(() => {
      if (searchTimer.current !== t) return;
      searchTimer.current = null;
      const cur = latest.current;
      // Solo si el admin sigue en el listado: nunca navegar desde un pedido abierto ni desde otra página.
      if (!mounted.current || window.location.pathname !== cur.path) return;
      if (q.trim() === intent.current.q) return;
      const k = request({ page: 1, q: q.trim() });
      start(() => router.replace(`${cur.path}${k}`, { scroll: false }));
    }, 350);
    searchTimer.current = t;
    return () => {
      clearTimeout(t);
      if (searchTimer.current === t) searchTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // La selección se limpia al cambiar de página o de filtros.
  const key = toQuery(state);
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setSel(new Set());
  }

  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const someSel = sel.size > 0 && !allSel;
  const hdrCb = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (hdrCb.current) hdrCb.current.indeterminate = someSel;
  }, [someSel]);
  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const filtersOn = state.status.length + state.method.length + state.modality.length > 0;
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);

  return (
    <div className="oi-card" aria-busy={pending}>
      <div className="oi-top">
        <nav className="ix-tabs" aria-label="Vistas de pedidos" role="tablist">
          {views.map((v) => {
            const active = v.key === state.view;
            const n = counts[v.key] ?? 0;
            return (
              <Link
                key={v.key}
                role="tab"
                aria-selected={active}
                href={`${path}${toQuery(state, { view: v.key, page: 1 })}`}
                onClick={(e) => onNavClick(e, { view: v.key, page: 1 })}
                className={`ix-tab${active ? " active" : ""}`}
                scroll={false}
              >
                {v.label}
                {v.key !== "ALL" && n > 0 ? <span className={`n${v.key === "AWAITING_VERIFICATION" ? " hot" : ""}`}>{n}</span> : null}
              </Link>
            );
          })}
        </nav>
        <div className="oi-tools">
          <button
            type="button"
            className={`oi-tool${searchOpen ? " on" : ""}`}
            aria-label="Buscar y filtrar"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((v) => !v);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            <Icon name="search" size={16} />
            <Icon name="filter" size={16} />
          </button>
          <div className="pill-wrap" ref={sortRef}>
            <button type="button" className={`oi-tool${sortOpen ? " on" : ""}`} aria-label="Ordenar" aria-expanded={sortOpen} onClick={() => setSortOpen((v) => !v)}>
              <Icon name="sort" size={16} />
            </button>
            {sortOpen ? (
              <div className="popover right" role="group" aria-label="Ordenar por">
                <div className="ttl">Ordenar por</div>
                {sorts.map((s) => (
                  <button key={s.key} type="button" className={`opt${state.sort === s.key ? " sel" : ""}`} onClick={() => go({ sort: s.key })} aria-pressed={state.sort === s.key}>
                    <span className="radio" />
                    {s.label}
                  </button>
                ))}
                <div className="sep" />
                <div className="dir">
                  <button type="button" className={`opt${state.dir === "asc" ? " sel" : ""}`} onClick={() => go({ dir: "asc" })} aria-pressed={state.dir === "asc"}>
                    <Icon name="chevronUp" size={16} /> {state.sort === "date" || state.sort === "number" ? "Más antiguos primero" : state.sort === "customer" ? "A–Z" : "Menor a mayor"}
                  </button>
                  <button type="button" className={`opt${state.dir === "desc" ? " sel" : ""}`} onClick={() => go({ dir: "desc" })} aria-pressed={state.dir === "desc"}>
                    <Icon name="chevronDown" size={16} /> {state.sort === "date" || state.sort === "number" ? "Más recientes primero" : state.sort === "customer" ? "Z–A" : "Mayor a menor"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {searchOpen ? (
        <>
          <div className="oi-search">
            <form
              className="ix-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                go({ q: q.trim() });
              }}
            >
              <Icon name="search" />
              <input ref={inputRef} className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por n.º de pedido, cliente, cédula, referencia o programa" aria-label="Buscar pedidos" />
            </form>
            <button
              type="button"
              className="btn btn-tertiary"
              onClick={() => {
                setSearchOpen(false);
                setQ("");
                if (state.q || filtersOn) go({ q: "", status: [], method: [], modality: [] });
              }}
            >
              Cancelar
            </button>
          </div>
          <div className="oi-filters">
            <FilterPill label="Estado del pedido" options={STATUS_OPTS} value={state.status} onChange={(v) => go({ status: v })} />
            <FilterPill label="Método de pago" options={METHOD_OPTS} value={state.method} onChange={(v) => go({ method: v })} />
            <FilterPill label="Modalidad" options={MODALITY_OPTS} value={state.modality} onChange={(v) => go({ modality: v })} />
            {filtersOn ? (
              <button type="button" className="btn btn-plain clear" onClick={() => go({ status: [], method: [], modality: [] })}>
                Borrar todo
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {sel.size > 0 ? (
        <div className="oi-bulk" role="region" aria-label="Acciones masivas">
          <input ref={hdrCb} type="checkbox" className="cb" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Seleccionar todos los pedidos de la página" />
          <span className="n">{sel.size} {sel.size === 1 ? "seleccionado" : "seleccionados"}</span>
          <ExportButton title="Exportar pedidos" endpoint="/admin/orders/export" className="btn" {...exportOptions({ noun: ["pedidos", "pedido"], filters: "", filtered: false, total: 0, selected: [...sel] })}>
            Exportar selección
          </ExportButton>
          <button type="button" className="btn btn-tertiary" onClick={() => setSel(new Set())}>Deseleccionar</button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="ix-empty">
          <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
            <circle cx="30" cy="30" r="28" fill="#f1f1f1" />
            <path d="M19 20h22a2 2 0 0 1 2 2v18a2 2 0 0 1-2 2H19a2 2 0 0 1-2-2V22a2 2 0 0 1 2-2Zm-2 12h7l2 3h8l2-3h7" fill="none" stroke="#8a8a8a" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <h3>{state.q || filtersOn ? "Ningún pedido coincide con la búsqueda" : "No hay pedidos en esta vista"}</h3>
          <p className="muted">{state.q || filtersOn ? "Prueba con otros filtros o palabras." : "Cuando un médico compre un programa, su pedido aparecerá aquí."}</p>
        </div>
      ) : (
        <>
          <div className="oi-table" style={{ opacity: pending ? 0.6 : 1 }}>
            <table className="ix" data-testid="orders-table">
              <thead>
                <tr>
                  <th className="c-check">
                    {sel.size === 0 ? <input type="checkbox" className="cb" checked={false} onChange={() => setSel(new Set(rows.map((r) => r.id)))} aria-label="Seleccionar todos los pedidos de la página" /> : null}
                  </th>
                  <th>Pedido</th>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th className="num">Total</th>
                  <th>Estado del pago</th>
                  <th>Matrícula</th>
                  <th>Programas</th>
                  <th className="h-md">Método</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pay = paymentBadge(r);
                  const enr = enrollmentBadge(r.status, r.enrollment, r.items.some((i) => i.planKind === "MONTHLY") ? { courses: r.installments.total } : null);
                  const href = `/admin/orders/${r.id}`;
                  return (
                    <tr
                      key={r.id}
                      data-order-number={r.number}
                      className={sel.has(r.id) ? "sel" : undefined}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("a,button,input,label,.itm-pop")) return;
                        cancelSearch();
                        router.push(href);
                      }}
                    >
                      <td className="c-check" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="cb" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar pedido #${r.number}`} />
                      </td>
                      <td className="c-num">
                        <Link href={href} onClick={cancelSearch}>#{r.number}</Link>
                        {r.awaitingVerification ? <span className="dot-attn" title="Pago por verificar" /> : null}
                      </td>
                      <td className="c-date">{listDate(r.placedAt, now)}</td>
                      <td className="c-cust">{r.customer.name}</td>
                      <td className="num mono">{usd(r.totalCents)}</td>
                      <td><Badge spec={pay} /></td>
                      <td>{enr ? <Badge spec={enr} /> : <span className="subdued">—</span>}</td>
                      <td><ItemsPopover row={r} /></td>
                      <td className="h-md">{r.paymentMethod ? METHOD_SHORT[r.paymentMethod] : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="oi-list" data-testid="orders-list">
            {rows.map((r) => {
              const pay = paymentBadge(r);
              const enr = enrollmentBadge(r.status, r.enrollment, r.items.some((i) => i.planKind === "MONTHLY") ? { courses: r.installments.total } : null);
              return (
                <li key={r.id}>
                  <Link href={`/admin/orders/${r.id}`} onClick={cancelSearch} aria-label={`Pedido #${r.number} de ${r.customer.name}`}>
                    <span className="n">
                      #{r.number}
                      {r.awaitingVerification ? <span className="dot-attn" /> : null}
                    </span>
                    <span className="t">{usd(r.totalCents)}</span>
                    <span className="c">{r.customer.name}</span>
                    <span className="d">{listDate(r.placedAt, now)}</span>
                    <span className="p">{r.items.map((i) => i.title).join(" · ")}</span>
                    <span className="b">
                      <Badge spec={pay} />
                      {enr ? <Badge spec={enr} /> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="oi-foot">
        <span>{total === 0 ? "0 pedidos" : `${from}–${to} de ${total} ${total === 1 ? "pedido" : "pedidos"}`}</span>
        {pages > 1 ? (
          <nav className="adm-pager" aria-label="Paginación">
            {page > 1 ? (
              <Link href={`${path}${toQuery(state, { page: page - 1 })}`} onClick={(e) => onNavClick(e, { page: page - 1 })} aria-label="Página anterior"><Icon name="prev" size={16} /></Link>
            ) : (
              <span aria-disabled="true"><Icon name="prev" size={16} /></span>
            )}
            {page < pages ? (
              <Link href={`${path}${toQuery(state, { page: page + 1 })}`} onClick={(e) => onNavClick(e, { page: page + 1 })} aria-label="Página siguiente"><Icon name="next" size={16} /></Link>
            ) : (
              <span aria-disabled="true"><Icon name="next" size={16} /></span>
            )}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
