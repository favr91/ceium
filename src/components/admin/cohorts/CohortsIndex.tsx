"use client";
// Índice de Cohortes (réplica del inventario por ubicación de Shopify): selector de sede, vistas por estado y
// ocupación, filtros, y por fila los cupos confirmados / reservados / libres con su barra y el cupo editable
// en línea (barra de guardado contextual). En móvil pasa a lista de recursos.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { saveCapacities, setCohortsStatus } from "@/app/admin/(panel)/cohorts/actions";
import { Icon } from "../Icon";
import { ExportButton } from "../ExportButton";
import { exportOptions } from "../export-options";
import { useOutside, useToast } from "../ui";
import { occupancyPct, SeatBar } from "./SeatBar";
import "./cohorts.css";
import { fillOf, fmtRange, relDays, daysFrom, STATUS_SHORT, STATUS_TONE, VIEWS, type CohortRow, type CohortStatus, type Seats, type View } from "./types";

type Q = { view: View; sede: string; product: string; q: string; sort: string; period: string; page: number };
interface Summary { open: number; low: number; full: number; inProgress: number; seats: Seats; sample: boolean }

const SORTS: { key: string; label: string }[] = [
  { key: "start-asc", label: "Fecha de inicio (próximas primero)" },
  { key: "start-desc", label: "Fecha de inicio (recientes primero)" },
  { key: "free-asc", label: "Cupos libres (menos primero)" },
  { key: "occ-desc", label: "Ocupación (mayor primero)" },
  { key: "program", label: "Programa A–Z" },
  { key: "sede", label: "Sede A–Z" },
];
const PERIODS: { key: string; label: string }[] = [
  { key: "", label: "Todas las fechas" },
  { key: "upcoming", label: "Por empezar" },
  { key: "past", label: "Terminadas" },
];

function href(path: string, q: Q, patch: Partial<Q>) {
  const n = { ...q, page: 1, ...patch };
  const p = new URLSearchParams();
  if (n.view !== "ALL") p.set("view", n.view);
  if (n.sede) p.set("sede", n.sede);
  if (n.product) p.set("product", n.product);
  if (n.period) p.set("period", n.period);
  if (n.q) p.set("q", n.q);
  if (n.sort && n.sort !== "start-asc") p.set("sort", n.sort);
  if (n.page > 1) p.set("page", String(n.page));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

export function StatusPill({ status }: { status: CohortStatus }) {
  return <span className={`badge ${STATUS_TONE[status]}`} data-status={status}><span className={`dot${status === "OPEN" || status === "IN_PROGRESS" ? " full" : ""}`} />{STATUS_SHORT[status]}</span>;
}

export function FillBadge({ seats, status }: { seats: Seats; status: CohortStatus }) {
  if (status !== "OPEN") return null;
  const f = fillOf(seats);
  if (f === "full") return <span className="badge critical sm">Llena</span>;
  if (f === "low") return <span className="badge attention sm" title="Últimos cupos">{seats.free === 1 ? "Queda 1" : `Quedan ${seats.free}`}</span>;
  return null;
}

const n = (v: number, cls = "") => <span className={`seat-n${v === 0 ? " zero" : ""}${cls ? ` ${cls}` : ""}`}>{v}</span>;

export function CohortsIndex({
  rows, total, allTotal, counts, summary, sedes, programs, query, pages, today, canEdit,
}: {
  rows: CohortRow[];
  total: number;
  allTotal: number;
  counts: Record<View, number>;
  summary: Summary;
  sedes: { slug: string; name: string; active: boolean; open: number }[];
  programs: { id: string; title: string }[];
  query: Q;
  pages: number;
  today: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const path = usePathname();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [search, setSearch] = useState(query.q);
  const [caps, setCaps] = useState<Record<string, string>>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [rawSel, setSel] = useState<Set<string>>(new Set());
  const [locRef, locOpen, setLocOpen] = useOutside<HTMLDivElement>();
  const [progRef, progOpen, setProgOpen] = useOutside<HTMLDivElement>();
  const [perRef, perOpen, setPerOpen] = useOutside<HTMLDivElement>();
  const [sortRef, sortOpen, setSortOpen] = useOutside<HTMLDivElement>();
  const [progQ, setProgQ] = useState("");

  useEffect(() => {
    if (search.trim() === query.q.trim()) return;
    const t = setTimeout(() => router.replace(href(path, query, { q: search.trim() }), { scroll: false }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const [lastQ, setLastQ] = useState(query.q);
  if (lastQ !== query.q) { setLastQ(query.q); setSearch(query.q); }

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  // Cambios de cupo pendientes (solo los que difieren del valor guardado y siguen visibles).
  const changes = useMemo(
    () => Object.entries(caps).filter(([id, v]) => byId.has(id) && v.trim() !== String(byId.get(id)!.seats.capacity)).map(([id, v]) => ({ id, raw: v.trim() })),
    [caps, byId],
  );
  const invalid = (id: string, raw: string): string | null => {
    const r = byId.get(id);
    if (!r) return null;
    if (!/^\d+$/.test(raw)) return "Número entero";
    const used = r.seats.confirmed + r.seats.held;
    if (Number(raw) < used) return `Mínimo ${used} (ocupados)`;
    if (Number(raw) > 10000) return "Máximo 10 000";
    return null;
  };
  const dirty = changes.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const saveCaps = () => {
    const bad = changes.map((c) => [c.id, invalid(c.id, c.raw)] as const).filter(([, e]) => e);
    if (bad.length) { setRowErr(Object.fromEntries(bad as [string, string][])); toast.show("Revisa los cupos marcados.", true); return; }
    start(async () => {
      const r = await saveCapacities(changes.map((c) => ({ id: c.id, capacity: Number(c.raw) })));
      const errs = Object.fromEntries(r.errors.map((e) => [e.id, e.error]));
      setRowErr(errs);
      setCaps((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => errs[id])));
      if (r.saved.length) toast.show(`${r.saved.length === 1 ? "Cupo actualizado" : `${r.saved.length} cupos actualizados`}${r.errors.length ? ` · ${r.errors.length} con error` : ""}`, r.errors.length > 0);
      else if (r.errors.length) toast.show(r.errors[0].error, true);
      router.refresh();
    });
  };

  const sel = useMemo(() => new Set([...rawSel].filter((id) => byId.has(id))), [rawSel, byId]);
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const headRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (headRef.current) headRef.current.indeterminate = sel.size > 0 && !allSel; }, [sel, allSel]);
  const toggle = (id: string) => setSel((s) => { const x = new Set(s); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const toggleAll = () => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)));
  const bulk = (status: CohortStatus, verb: string) => {
    const ids = [...sel];
    start(async () => {
      const r = await setCohortsStatus(ids, status);
      if (r.changed) toast.show(`${r.changed} ${r.changed === 1 ? "cohorte" : "cohortes"}: ${verb}${r.errors.length ? ` · ${r.errors.length} sin cambios` : ""}`, !r.ok);
      else toast.show(r.errors[0] ?? "Sin cambios", true);
      if (r.ok) setSel(new Set());
      router.refresh();
    });
  };

  const sedeName = sedes.find((s) => s.slug === query.sede)?.name;
  const progName = programs.find((p) => p.id === query.product)?.title;
  const filtered = !!(query.q || query.product || query.period);
  const s = summary.seats;
  const occPct = occupancyPct(s);
  const progList = programs.filter((p) => p.title.toLowerCase().includes(progQ.trim().toLowerCase()));

  const capInput = (r: CohortRow, cls = "") => {
    const v = caps[r.id] ?? String(r.seats.capacity);
    const changed = v.trim() !== String(r.seats.capacity);
    return (
      <input
        className={`inp num cap-inp${changed ? " changed" : ""}${cls ? ` ${cls}` : ""}`}
        inputMode="numeric"
        aria-label={`Cupo de ${r.name} · ${r.productTitle} · ${r.sedeName}`}
        aria-invalid={!!rowErr[r.id] || undefined}
        value={v}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const val = e.target.value.replace(/[^\d]/g, "").slice(0, 5);
          setCaps((c) => ({ ...c, [r.id]: val }));
          setRowErr((x) => { if (!x[r.id]) return x; const y = { ...x }; delete y[r.id]; return y; });
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const cur = Number(v) || 0;
            setCaps((c) => ({ ...c, [r.id]: String(Math.max(0, cur + (e.key === "ArrowUp" ? 1 : -1))) }));
          }
          if (e.key === "Enter" && dirty) saveCaps();
          if (e.key === "Escape") setCaps((c) => { const y = { ...c }; delete y[r.id]; return y; });
        }}
      />
    );
  };

  return (
    <>
      {dirty && canEdit ? (
        <div className="savebar" role="region" aria-label="Cambios sin guardar">
          <div className="savebar-in" style={{ maxWidth: 1400 }}>
            <div className="msg"><Icon name="alert" size={18} /> <span>{changes.length === 1 ? "1 cupo sin guardar" : `${changes.length} cupos sin guardar`}</span></div>
            <button type="button" className="btn btn-dark" disabled={pending} onClick={() => { setCaps({}); setRowErr({}); }}>Descartar</button>
            <button type="button" className="btn btn-save" disabled={pending} onClick={saveCaps}>{pending ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      ) : null}

      {summary.sample ? (
        <div className="banner attention" role="note">
          <Icon name="info" />
          <span>Las cohortes sembradas son <b>datos de ejemplo</b> (fechas y cupos ficticios, marcadas «Ejemplo»). Ajústalas o reemplázalas por las reales antes de abrir la venta.</span>
        </div>
      ) : null}

      {/* Resumen de cupos del conjunto filtrado */}
      <section className="card seat-sum" aria-label="Resumen de cupos">
        <div>
          <div className="k"><Icon name="location" size={16} /> {sedeName ?? "Todas las sedes"}{progName ? " · 1 programa" : ""}</div>
          <div className="v" data-testid="sum-open">{summary.open}<small>{summary.open === 1 ? "cohorte abierta" : "cohortes abiertas"}</small></div>
          <div className="s">{summary.low} con últimos cupos · {summary.full} {summary.full === 1 ? "llena" : "llenas"} · {summary.inProgress} en curso</div>
        </div>
        <div>
          <div className="k"><span className="sw c" /> Confirmados</div>
          <div className="v" data-testid="sum-confirmed">{s.confirmed}</div>
          <div className="s">Primer pago confirmado</div>
        </div>
        <div>
          <div className="k"><span className="sw h" /> Reservados</div>
          <div className="v" data-testid="sum-held">{s.held}</div>
          <div className="s">Checkout o pago en verificación</div>
        </div>
        <div>
          <div className="k"><span className="sw f" /> Libres</div>
          <div className="v" data-testid="sum-free">{s.free}</div>
          <div className="s">Se pueden vender hoy</div>
        </div>
        <div>
          <div className="k">Cupo total</div>
          <div className="v" data-testid="sum-capacity">{s.capacity}</div>
          <div className="s">En cohortes abiertas</div>
        </div>
        <div className="seat-sum-bar">
          <SeatBar seats={s} size="lg" />
          <span className="pct">{occPct} % ocupado</span>
        </div>
      </section>

      <div className="card card-flush" style={{ marginTop: 16 }}>
        <div className="ix-tabs" role="tablist" aria-label="Vistas">
          {VIEWS.map((t) => (
            <Link key={t.key} role="tab" aria-selected={query.view === t.key} className={`ix-tab${query.view === t.key ? " active" : ""}`} href={href(path, query, { view: t.key })} scroll={false}>
              {t.label} <span className="n">{counts[t.key]}</span>
            </Link>
          ))}
        </div>
        <div className="ix-filters">
          <div className="pill-wrap" ref={locRef}>
            <button type="button" className="btn loc-btn" aria-haspopup="listbox" aria-expanded={locOpen} onClick={() => setLocOpen(!locOpen)}>
              <Icon name="location" size={16} /> {sedeName ?? "Todas las sedes"} <Icon name="chevronDown" size={14} />
            </button>
            {locOpen ? (
              <div className="popover" role="listbox" aria-label="Sede">
                {[{ slug: "", name: "Todas las sedes", active: true, open: sedes.reduce((a, x) => a + x.open, 0) }, ...sedes].map((x) => (
                  <Link key={x.slug || "all"} role="option" aria-selected={query.sede === x.slug} className={`opt${query.sede === x.slug ? " sel" : ""}`} href={href(path, query, { sede: x.slug })} onClick={() => setLocOpen(false)} scroll={false}>
                    <span className="ck">{query.sede === x.slug ? <Icon name="check" size={16} /> : null}</span>
                    {x.name}{!x.active ? <span className="badge sm">Inactiva</span> : null}
                    <span className="cnt" title="Cohortes abiertas">{x.open}</span>
                  </Link>
                ))}
                <div className="divider" style={{ margin: "6px 0" }} />
                <Link className="opt" href="/admin/sedes"><span className="ck" /><span className="lnk">Administrar sedes</span></Link>
              </div>
            ) : null}
          </div>
          <div className="ix-search">
            <Icon name="search" />
            <input className="inp" type="search" placeholder="Buscar por cohorte, programa o sede" aria-label="Buscar cohortes" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="pill-wrap" ref={progRef}>
            <button type="button" className={`pill${query.product ? " on" : ""}`} aria-haspopup="listbox" aria-expanded={progOpen} onClick={() => setProgOpen(!progOpen)}>
              {progName ? `Programa: ${progName.length > 34 ? `${progName.slice(0, 33)}…` : progName}` : "Programa"} <Icon name="chevronDown" size={14} />
            </button>
            {progOpen ? (
              <div className="popover" role="listbox" aria-label="Programa" style={{ width: 360, maxHeight: 360, overflow: "auto" }}>
                <input className="inp" placeholder="Buscar programa" aria-label="Filtrar programas" value={progQ} autoFocus onChange={(e) => setProgQ(e.target.value)} style={{ marginBottom: 6 }} />
                <Link role="option" aria-selected={!query.product} className={`opt${!query.product ? " sel" : ""}`} href={href(path, query, { product: "" })} onClick={() => setProgOpen(false)} scroll={false}>Todos los programas</Link>
                {progList.map((p) => (
                  <Link key={p.id} role="option" aria-selected={query.product === p.id} className={`opt${query.product === p.id ? " sel" : ""}`} href={href(path, query, { product: p.id })} onClick={() => setProgOpen(false)} scroll={false}>{p.title}</Link>
                ))}
              </div>
            ) : null}
          </div>
          <div className="pill-wrap" ref={perRef}>
            <button type="button" className={`pill${query.period ? " on" : ""}`} aria-haspopup="listbox" aria-expanded={perOpen} onClick={() => setPerOpen(!perOpen)}>
              {query.period ? `Fechas: ${PERIODS.find((p) => p.key === query.period)!.label}` : "Fechas"} <Icon name="chevronDown" size={14} />
            </button>
            {perOpen ? (
              <div className="popover" role="listbox" aria-label="Fechas">
                {PERIODS.map((p) => (
                  <Link key={p.key || "all"} role="option" aria-selected={query.period === p.key} className={`opt${query.period === p.key ? " sel" : ""}`} href={href(path, query, { period: p.key })} onClick={() => setPerOpen(false)} scroll={false}>{p.label}</Link>
                ))}
              </div>
            ) : null}
          </div>
          {filtered ? <Link className="btn btn-plain" href={href(path, query, { q: "", product: "", period: "" })} scroll={false}>Borrar todo</Link> : null}
          <div className="pill-wrap" ref={sortRef}>
            <button type="button" className="btn btn-icon" aria-label="Ordenar" title="Ordenar" aria-expanded={sortOpen} onClick={() => setSortOpen(!sortOpen)}><Icon name="sort" /></button>
            {sortOpen ? (
              <div className="popover right" role="listbox" aria-label="Ordenar por">
                <div className="ttl">Ordenar por</div>
                {SORTS.map((x) => (
                  <Link key={x.key} role="option" aria-selected={query.sort === x.key} className={`opt${query.sort === x.key ? " sel" : ""}`} href={href(path, query, { sort: x.key })} onClick={() => setSortOpen(false)} scroll={false}>{x.label}</Link>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {sel.size > 0 && canEdit ? (
          <div className="ix-bulk" role="toolbar" aria-label="Acciones masivas">
            <input ref={headRef} className="cb" type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Seleccionar todas" />
            <span className="n">{sel.size} {sel.size === 1 ? "seleccionada" : "seleccionadas"}</span>
            <button className="btn" disabled={pending} onClick={() => bulk("OPEN", "inscripciones abiertas")}>Abrir inscripciones</button>
            <button className="btn" disabled={pending} onClick={() => bulk("CLOSED", "inscripciones cerradas")}>Cerrar inscripciones</button>
            <button className="btn hide-sm" disabled={pending} onClick={() => bulk("IN_PROGRESS", "en curso")}>Marcar en curso</button>
            <ExportButton title="Exportar cohortes" endpoint="/admin/cohorts/export" className="btn" {...exportOptions({ noun: ["cohortes", "cohorte"], fem: true, filters: "", filtered: false, total: 0, selected: [...sel] })}>
              Exportar selección
            </ExportButton>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <div className="ix-empty">
            <Icon name="cohort" size={40} />
            <h3>{allTotal === 0 ? "Aún no hay cohortes" : "No se encontraron cohortes"}</h3>
            <p className="muted">{allTotal === 0 ? "Crea la primera cohorte semipresencial: programa, sede, fechas y cupo." : "Prueba cambiando la sede, la vista o los filtros."}</p>
            {allTotal === 0 ? <Link className="btn btn-primary" style={{ marginTop: 12 }} href="/admin/cohorts/new">Crear cohorte</Link> : null}
          </div>
        ) : (
          <>
            <div className="ix-scroll"><table className="ix ix-cohorts" aria-label="Cohortes">
              {sel.size === 0 || !canEdit ? (
                <thead>
                  <tr>
                    {canEdit ? <th className="c-check"><input ref={headRef} className="cb" type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Seleccionar todas" /></th> : null}
                    <th>Cohorte</th>
                    <th>Sede</th>
                    <th>Fechas</th>
                    <th>Estado</th>
                    <th>Ocupación</th>
                    <th className="num"><span className="th-in"><span className="sw c" />Confirmados</span></th>
                    <th className="num"><span className="th-in"><span className="sw h" />Reservados</span></th>
                    <th className="num"><span className="th-in"><span className="sw f" />Libres</span></th>
                    <th className="num" style={{ paddingRight: 16 }}>Cupo</th>
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {rows.map((r) => {
                  const f = fillOf(r.seats);
                  const soon = r.status === "OPEN" && daysFrom(today, r.startDate) >= 0 && daysFrom(today, r.startDate) <= 14;
                  return (
                    <tr
                      key={r.id}
                      data-cohort-id={r.id}
                      className={[sel.has(r.id) ? "sel" : "", rowErr[r.id] ? "bad" : ""].filter(Boolean).join(" ") || undefined}
                      onClick={(e) => { if ((e.target as HTMLElement).closest("a,input,button,label")) return; router.push(`/admin/cohorts/${r.id}`); }}
                    >
                      {canEdit ? <td className="c-check"><input className="cb" type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.name} · ${r.productTitle} · ${r.sedeName}`} /></td> : null}
                      <td className="c-cohort">
                        <Link className="title" href={`/admin/cohorts/${r.id}`}>{r.name}</Link>
                        <div className="sub ell" title={r.productTitle}>{r.productTitle}</div>
                      </td>
                      <td>{r.sedeName}</td>
                      <td className="dates">
                        <div className="mono">{fmtRange(r.startDate, r.endDate)}</div>
                        <div className={`sub${soon ? " soon" : ""}`}>{relDays(today, r.startDate, r.endDate)}</div>
                      </td>
                      <td>
                        <StatusPill status={r.status} />
                      </td>
                      <td>
                        <div className="occ">
                          <SeatBar seats={r.seats} />
                          <div className="l"><span><b>{r.seats.confirmed + r.seats.held}</b> de {r.seats.capacity}</span><FillBadge seats={r.seats} status={r.status} /></div>
                        </div>
                      </td>
                      <td className="num">{n(r.seats.confirmed)}</td>
                      <td className="num">{n(r.seats.held)}{r.seats.stale ? <div className="sub" title="Reservas vencidas: el barrido las libera">+{r.seats.stale} {r.seats.stale === 1 ? "vencida" : "vencidas"}</div> : null}</td>
                      <td className="num">{n(r.seats.free, f === "full" ? "free-none" : f === "low" ? "free-low" : "")}</td>
                      <td className="num cap-cell" style={{ paddingRight: 16 }}>
                        {canEdit ? capInput(r) : <span className="mono">{r.seats.capacity}</span>}
                        {rowErr[r.id] ? <span className="cap-err" role="alert">{rowErr[r.id]}</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <ul className="ix-list" aria-label="Cohortes">
              {rows.map((r) => (
                <li key={r.id} data-cohort-id={r.id}>
                  {canEdit ? <input className="cb" type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.name} · ${r.productTitle} · ${r.sedeName}`} /> : null}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link href={`/admin/cohorts/${r.id}`}>
                      <span className="t">{r.name}</span>
                      <span className="s">{r.productTitle}</span>
                      <span className="s">{r.sedeName} · {fmtRange(r.startDate, r.endDate)}</span>
                    </Link>
                    <span className="b"><StatusPill status={r.status} /><FillBadge seats={r.seats} status={r.status} /></span>
                    <div className="occ"><SeatBar seats={r.seats} /></div>
                    <div className="seat-line">
                      <span><span className="sw c" /> <b>{r.seats.confirmed}</b> {r.seats.confirmed === 1 ? "confirmado" : "confirmados"}</span>
                      <span><span className="sw h" /> <b>{r.seats.held}</b> {r.seats.held === 1 ? "reservado" : "reservados"}</span>
                      <span><span className="sw f" /> <b>{r.seats.free}</b> {r.seats.free === 1 ? "libre" : "libres"}</span>
                    </div>
                  </div>
                  <div className="cap-cell" style={{ textAlign: "right" }}>
                    <div className="small muted">Cupo</div>
                    {canEdit ? capInput(r) : <b className="mono">{r.seats.capacity}</b>}
                    {rowErr[r.id] ? <div className="field-err small" role="alert">{rowErr[r.id]}</div> : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="card-foot">
          <span>{total === allTotal ? `${total} ${total === 1 ? "cohorte" : "cohortes"}` : `${total} de ${allTotal} cohortes`}{pages > 1 ? ` · página ${query.page} de ${pages}` : ""}</span>
          {pages > 1 ? (
            <span className="adm-pager">
              {query.page > 1 ? <Link href={href(path, query, { page: query.page - 1 })} aria-label="Página anterior"><Icon name="prev" size={16} /></Link> : <span aria-hidden><Icon name="prev" size={16} /></span>}
              {query.page < pages ? <Link href={href(path, query, { page: query.page + 1 })} aria-label="Página siguiente"><Icon name="next" size={16} /></Link> : <span aria-hidden><Icon name="next" size={16} /></span>}
            </span>
          ) : (
            <span>Cupo = confirmados + reservados + libres</span>
          )}
        </div>
      </div>
      <p className="muted" style={{ textAlign: "center", marginTop: 20 }}>
        Una reserva nace en el checkout (PayPal: 30 min · pago manual: hasta su verificación) y pasa a confirmada con el primer pago. El cupo nunca puede quedar por debajo de lo ocupado.
      </p>
      {toast.node}
    </>
  );
}
