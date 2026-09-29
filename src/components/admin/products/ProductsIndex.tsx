"use client";
/* eslint-disable @next/next/no-img-element -- miniaturas del catálogo (CDN de ceium.net y /uploads): sin optimización de next/image */
// Índice de Programas (réplica del listado de Productos de Shopify): vistas por estado, búsqueda, filtro de
// categoría, orden, selección con acciones masivas y filas clicables. En móvil pasa a lista de recursos.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { setProductsPublished } from "@/app/admin/(panel)/products/actions";
import { Icon } from "../Icon";
import { ExportButton } from "../ExportButton";
import { exportOptions } from "../export-options";
import { StatusBadge, useOutside, useToast } from "../ui";
import { usd } from "./money";
import { CATEGORY_LABEL, CATEGORY_ORDER, type Category, type ProductRow, type Status } from "./types";

type Q = { q: string; status: Status | "ALL"; category: Category | "ALL"; sort: string };

const TABS: { key: Status | "ALL"; label: string }[] = [
  { key: "ALL", label: "Todos" },
  { key: "ACTIVE", label: "Activos" },
  { key: "DRAFT", label: "Borradores" },
  { key: "ARCHIVED", label: "Archivados" },
];
const SORTS: { key: string; label: string }[] = [
  { key: "position", label: "Orden del catálogo" },
  { key: "title-asc", label: "Título A–Z" },
  { key: "title-desc", label: "Título Z–A" },
  { key: "updated-desc", label: "Actualizado recientemente" },
  { key: "price-asc", label: "Precio: menor a mayor" },
  { key: "price-desc", label: "Precio: mayor a menor" },
];

function href(path: string, q: Q, patch: Partial<Q>) {
  const n = { ...q, ...patch };
  const p = new URLSearchParams();
  if (n.q) p.set("q", n.q);
  if (n.status !== "ALL") p.set("status", n.status);
  if (n.category !== "ALL") p.set("category", n.category);
  if (n.sort && n.sort !== "position") p.set("sort", n.sort);
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

function priceText(r: ProductRow) {
  if (r.priceMinCents == null) return <span className="subdued">Sin precios</span>;
  const range = r.priceMinCents === r.priceMaxCents ? usd(r.priceMinCents) : `${usd(r.priceMinCents)} – ${usd(r.priceMaxCents!)}`;
  return (
    <>
      <span className="mono">{range}</span>
      <div className="sub">{r.priceCount} {r.priceCount === 1 ? "precio" : "precios"}</div>
    </>
  );
}

function modalities(r: ProductRow) {
  return [r.online ? "Online" : null, r.semi ? "Semipresencial" : null].filter(Boolean).join(" · ");
}

function detail(r: ProductRow) {
  if (r.type === "DIPLOMA") return `${r.courseCount} ${r.courseCount === 1 ? "curso" : "cursos"}`;
  return r.moodleCourseId != null ? `Moodle #${r.moodleCourseId}` : "Sin curso de Moodle";
}

export function ProductsIndex({ rows, counts, total, query, canEdit }: { rows: ProductRow[]; counts: Record<Status | "ALL", number>; total: number; query: Q; canEdit: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [search, setSearch] = useState(query.q);
  const [rawSel, setSel] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const toast = useToast();
  const [catRef, catOpen, setCatOpen] = useOutside<HTMLDivElement>();
  const [sortRef, sortOpen, setSortOpen] = useOutside<HTMLDivElement>();

  // Búsqueda en vivo (con pausa) sin perder foco: reemplaza la URL.
  useEffect(() => {
    if (search.trim() === query.q.trim()) return;
    const t = setTimeout(() => router.replace(href(path, query, { q: search.trim() }), { scroll: false }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  // La URL cambió desde fuera (Borrar todo, barra superior): reflejarla en el campo.
  const [lastQ, setLastQ] = useState(query.q);
  if (lastQ !== query.q) { setLastQ(query.q); setSearch(query.q); }

  // Solo cuentan los seleccionados que siguen visibles con los filtros actuales.
  const sel = useMemo(() => new Set([...rawSel].filter((id) => rows.some((r) => r.id === id))), [rawSel, rows]);

  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const someSel = sel.size > 0 && !allSel;
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headRef.current) headRef.current.indeterminate = someSel; }, [someSel]);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)));

  const bulk = (published: boolean) => {
    const ids = [...sel];
    start(async () => {
      const r = await setProductsPublished(ids, published);
      if (r.ok) {
        toast.show(published ? `${ids.length} ${ids.length === 1 ? "programa publicado" : "programas publicados"}` : `${ids.length} ${ids.length === 1 ? "programa archivado" : "programas archivados"}`);
        setSel(new Set());
      } else toast.show(r.error, true);
      router.refresh();
    });
  };

  const selRows = useMemo(() => rows.filter((r) => sel.has(r.id)), [rows, sel]);
  const filtered = query.q || query.category !== "ALL";

  return (
    <>
      <div className="card card-flush">
        <div className="ix-tabs" role="tablist" aria-label="Vistas">
          {TABS.map((t) => (
            <Link key={t.key} role="tab" aria-selected={query.status === t.key} className={`ix-tab${query.status === t.key ? " active" : ""}`} href={href(path, query, { status: t.key })} scroll={false}>
              {t.label} <span className="n">{counts[t.key]}</span>
            </Link>
          ))}
        </div>
        <div className="ix-filters">
          <div className="ix-search">
            <Icon name="search" />
            <input className="inp" type="search" placeholder="Buscar por título, slug, colección o ID de Moodle" aria-label="Buscar programas" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="pill-wrap" ref={catRef}>
            <button type="button" className={`pill${query.category !== "ALL" ? " on" : ""}`} aria-haspopup="listbox" aria-expanded={catOpen} onClick={() => setCatOpen(!catOpen)}>
              {query.category === "ALL" ? "Categoría" : `Categoría: ${CATEGORY_LABEL[query.category]}`}
              <Icon name="chevronDown" size={14} />
            </button>
            {catOpen ? (
              <div className="popover" role="listbox" aria-label="Categoría">
                {(["ALL", ...CATEGORY_ORDER] as const).map((c) => (
                  <Link key={c} role="option" aria-selected={query.category === c} className={`opt${query.category === c ? " sel" : ""}`} href={href(path, query, { category: c })} onClick={() => setCatOpen(false)} scroll={false}>
                    {c === "ALL" ? "Todas las categorías" : CATEGORY_LABEL[c]}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
          {filtered ? (
            <Link className="btn btn-plain" href={href(path, query, { q: "", category: "ALL" })} scroll={false}>Borrar todo</Link>
          ) : null}
          <div className="pill-wrap" ref={sortRef}>
            <button type="button" className="btn btn-icon" aria-label="Ordenar" title="Ordenar" aria-expanded={sortOpen} onClick={() => setSortOpen(!sortOpen)}>
              <Icon name="sort" />
            </button>
            {sortOpen ? (
              <div className="popover right" role="listbox" aria-label="Ordenar por">
                <div className="ttl">Ordenar por</div>
                {SORTS.map((s) => (
                  <Link key={s.key} role="option" aria-selected={query.sort === s.key} className={`opt${query.sort === s.key ? " sel" : ""}`} href={href(path, query, { sort: s.key })} onClick={() => setSortOpen(false)} scroll={false}>
                    {s.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {sel.size > 0 && canEdit ? (
          <div className="ix-bulk" role="toolbar" aria-label="Acciones masivas">
            <input ref={headRef} className="cb" type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Seleccionar todos" />
            <span className="n">{sel.size} {sel.size === 1 ? "seleccionado" : "seleccionados"}</span>
            <button className="btn" disabled={pending || selRows.every((r) => r.status === "ACTIVE")} onClick={() => bulk(true)}>Publicar</button>
            <button className="btn" disabled={pending || selRows.every((r) => r.status !== "ACTIVE")} onClick={() => bulk(false)}>Archivar</button>
            <ExportButton title="Exportar programas" endpoint="/admin/products/export" className="btn" {...exportOptions({ noun: ["programas", "programa"], filters: "", filtered: false, total: 0, selected: [...sel] })}>
              Exportar selección
            </ExportButton>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <div className="ix-empty">
            <Icon name="search" size={40} />
            <h3>No se encontraron programas</h3>
            <p className="muted">Prueba cambiando los filtros o el término de búsqueda.</p>
          </div>
        ) : (
          <>
            <table className="ix" aria-label="Programas">
              {sel.size === 0 || !canEdit ? (
                <thead>
                  <tr>
                    {canEdit ? <th className="c-check"><input ref={headRef} className="cb" type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Seleccionar todos" /></th> : null}
                    <th className="c-thumb"><span className="sr-only">Imagen</span></th>
                    <th>Programa</th>
                    <th>Estado</th>
                    <th>Precio de lista</th>
                    <th className="h-md">Modalidad</th>
                    <th>Categoría</th>
                    <th className="h-md">Contenido</th>
                    <th className="num h-md">Cohortes abiertas</th>
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={sel.has(r.id) ? "sel" : undefined} onClick={(e) => { if ((e.target as HTMLElement).closest("a,input,button")) return; router.push(`/admin/products/${r.id}`); }} data-product-id={r.id}>
                    {canEdit ? (
                      <td className="c-check"><input className="cb" type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.title}`} /></td>
                    ) : null}
                    <td className="c-thumb">
                      <div className="thumb">{r.image ? <img src={r.image} alt="" loading="lazy" /> : <Icon name="image" />}</div>
                    </td>
                    <td className="c-title"><Link className="title" href={`/admin/products/${r.id}`}>{r.title}</Link></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{priceText(r)}</td>
                    <td className="h-md">{modalities(r)}</td>
                    <td>{CATEGORY_LABEL[r.category]}</td>
                    <td className="h-md muted">{detail(r)}</td>
                    <td className="num h-md mono">{r.semi ? r.cohortsOpen : <span className="subdued">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="ix-list" aria-label="Programas">
              {rows.map((r) => (
                <li key={r.id}>
                  {canEdit ? <input className="cb" type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.title}`} /> : null}
                  <div className="thumb">{r.image ? <img src={r.image} alt="" loading="lazy" /> : <Icon name="image" />}</div>
                  <Link href={`/admin/products/${r.id}`} style={{ flex: 1, minWidth: 0 }}>
                    <span className="t">{r.title}</span>
                    <span className="s">{CATEGORY_LABEL[r.category]} · {detail(r)}</span>
                    <span className="s mono">{r.priceMinCents == null ? "Sin precios" : r.priceMinCents === r.priceMaxCents ? usd(r.priceMinCents) : `${usd(r.priceMinCents)} – ${usd(r.priceMaxCents!)}`}</span>
                    <span className="b"><StatusBadge status={r.status} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="card-foot">
          <span>{rows.length === total ? `${total} programas` : `${rows.length} de ${total} programas`}</span>
          <span>Precio de lista = pago total sin descuento del plan</span>
        </div>
      </div>
      <p className="muted" style={{ textAlign: "center", marginTop: 20 }}>
        Los cambios de precios aplican a compras nuevas; cada pedido conserva el precio con el que se compró.
      </p>
      {toast.node}
    </>
  );
}
