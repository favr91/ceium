"use client";
// Índice de Matrículas (réplica de un índice de recursos de Shopify): pestañas con conteo, búsqueda, filtro por
// programa, orden, selección con acciones masivas (consultar progreso en Moodle, reintentar matrícula),
// paginación y lista compacta en móvil. El estado vive en la URL.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { EnrollmentRow } from "@/server/admin-learning";
import { refreshProgressAction, retryEnrollmentsAction } from "@/app/admin/(panel)/enrollments/actions";
import { Icon } from "../Icon";
import { Spinner, useDismiss } from "../orders/bits";
import { listDate } from "../orders/format";
import { Avatar, StateBadge, ago, dm, useRun } from "./shared";

export interface EnrollState {
  view: string;
  q: string;
  program: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
}

export function enrollQuery(s: EnrollState, patch: Partial<EnrollState> = {}) {
  const n = { ...s, ...patch };
  const p = new URLSearchParams();
  if (n.view !== "ALL") p.set("view", n.view);
  if (n.q) p.set("q", n.q);
  if (n.program) p.set("program", n.program);
  if (n.sort !== "recent" || n.dir !== "desc") {
    p.set("sort", n.sort);
    p.set("dir", n.dir);
  }
  if (n.page > 1) p.set("page", String(n.page));
  const q = p.toString();
  return q ? `?${q}` : "";
}

interface Props {
  rows: EnrollmentRow[];
  counts: Record<string, number>;
  views: { key: string; label: string }[];
  sorts: { key: string; label: string }[];
  programs: { id: string; title: string; type: string }[];
  total: number;
  page: number;
  pages: number;
  perPage: number;
  state: EnrollState;
  now: string;
  canManage: boolean;
}

export function EnrollmentsIndex({ rows, counts, views, sorts, programs, total, page, pages, perPage, state, now, canManage }: Props) {
  const router = useRouter();
  const path = usePathname();
  const [pendingNav, startNav] = useTransition();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState(state.q);
  const [searchOpen, setSearchOpen] = useState(!!state.q || !!state.program);
  const [sortRef, sortOpen, setSortOpen] = useDismiss<HTMLDivElement>();
  const inputRef = useRef<HTMLInputElement>(null);
  const hdrCb = useRef<HTMLInputElement>(null);
  const { run, busy, toastNode } = useRun();
  // La búsqueda con pausa navega con el estado ACTUAL de la URL (no con el del render en que se escribió).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Al cambiar de vista/página se limpia la selección (ajuste durante el render).
  const key = enrollQuery(state);
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setSel(new Set());
  }
  // Búsqueda mientras se escribe (con pausa).
  useEffect(() => {
    if (q.trim() === state.q) return;
    const t = setTimeout(() => go({ q: q.trim(), page: 1 }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  useEffect(() => {
    if (hdrCb.current) hdrCb.current.indeterminate = sel.size > 0 && !allSel;
  }, [sel, allSel]);

  function go(patch: Partial<EnrollState>) {
    setSortOpen(false);
    startNav(() => router.push(`${path}${enrollQuery(stateRef.current, { page: 1, ...patch })}`, { scroll: false }));
  }
  const selected = rows.filter((r) => sel.has(r.id));
  const activeSel = selected.filter((r) => r.status === "ENROLLED");
  const retrySel = selected.filter((r) => r.status === "FAILED" || r.status === "PENDING");
  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const filtered = !!state.q || !!state.program;
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);

  const progressCell = (r: EnrollmentRow) =>
    r.state === "COMPLETED" ? (
      <span>Completado el {dm(r.completedAt!)}</span>
    ) : r.state === "IN_PROGRESS" ? (
      <span className="muted">Matriculado el {dm(r.enrolledAt ?? r.createdAt)}</span>
    ) : r.state === "FAILED" ? (
      <span className="lp-err" title={r.lastError ?? undefined}>
        {r.attempts} {r.attempts === 1 ? "intento" : "intentos"}
        {r.lastError ? ` · ${r.lastError.slice(0, 70)}` : ""}
      </span>
    ) : r.state === "PENDING" ? (
      <span className="muted">{r.nextAttemptAt ? `Reintento ${listDate(r.nextAttemptAt, now).toLowerCase()}` : "En cola"}</span>
    ) : (
      <span className="muted">Sin acceso al curso</span>
    );

  return (
    <div className="oi-card" aria-busy={pendingNav}>
      <div className="oi-top">
        <nav className="ix-tabs" aria-label="Vistas de matrículas" role="tablist">
          {views.map((v) => {
            const active = v.key === state.view;
            const n = counts[v.key] ?? 0;
            return (
              <Link key={v.key} role="tab" aria-selected={active} href={`${path}${enrollQuery(state, { view: v.key, page: 1 })}`} className={`ix-tab${active ? " active" : ""}`} scroll={false}>
                {v.label}
                {v.key !== "ALL" && n > 0 ? <span className={`n${v.key === "FAILED" ? " hot" : ""}`}>{n}</span> : null}
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
                    <Icon name="chevronUp" size={16} /> {state.sort === "student" || state.sort === "course" ? "A–Z" : "Más antiguas primero"}
                  </button>
                  <button type="button" className={`opt${state.dir === "desc" ? " sel" : ""}`} onClick={() => go({ dir: "desc" })} aria-pressed={state.dir === "desc"}>
                    <Icon name="chevronDown" size={16} /> {state.sort === "student" || state.sort === "course" ? "Z–A" : "Más recientes primero"}
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
            <form className="ix-search" role="search" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() }); }}>
              <Icon name="search" />
              <input ref={inputRef} className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por médico, correo, cédula, curso, nº de pedido o id de Moodle" aria-label="Buscar matrículas" />
            </form>
            <button
              type="button"
              className="btn btn-tertiary"
              onClick={() => {
                setSearchOpen(false);
                setQ("");
                if (filtered) go({ q: "", program: "" });
              }}
            >
              Cancelar
            </button>
          </div>
          <div className="oi-filters">
            <label className="lx-select">
              <span className="sr-only">Programa</span>
              <select className="inp" value={state.program} onChange={(e) => go({ program: e.target.value })} aria-label="Programa">
                <option value="">Todos los programas</option>
                <optgroup label="Diplomados">
                  {programs.filter((p) => p.type === "DIPLOMA").map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </optgroup>
                <optgroup label="Cursos">
                  {programs.filter((p) => p.type !== "DIPLOMA").map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </optgroup>
              </select>
            </label>
            {filtered ? <button type="button" className="btn btn-plain clear" onClick={() => { setQ(""); go({ q: "", program: "" }); }}>Borrar todo</button> : null}
          </div>
        </>
      ) : null}

      {sel.size > 0 ? (
        <div className="oi-bulk lx-bulk" role="region" aria-label="Acciones masivas">
          <input ref={hdrCb} type="checkbox" className="cb" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Seleccionar todas las matrículas de la página" />
          <span className="n">{sel.size} {sel.size === 1 ? "seleccionada" : "seleccionadas"}</span>
          {canManage ? (
            <>
              <button type="button" className="btn" disabled={!activeSel.length || !!busy} onClick={() => run("refresh", () => refreshProgressAction(activeSel.map((r) => r.id)))}>
                {busy === "refresh" ? <Spinner /> : null} Consultar progreso en Moodle
              </button>
              <button type="button" className="btn" disabled={!retrySel.length || !!busy} onClick={() => run("retry", () => retryEnrollmentsAction(retrySel.map((r) => r.id)))}>
                {busy === "retry" ? <Spinner /> : null} Reintentar matrícula
              </button>
            </>
          ) : null}
          <button type="button" className="btn btn-tertiary" onClick={() => setSel(new Set())}>Deseleccionar</button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="ix-empty">
          <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">
            <circle cx="30" cy="30" r="28" fill="#f1f1f1" />
            <path d="M14 25 30 17l16 8-16 8-16-8Zm7 4v8c2.5 2.5 5.6 3.5 9 3.5s6.5-1 9-3.5v-8M46 25v10" fill="none" stroke="#8a8a8a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <h3>{filtered ? "Ninguna matrícula coincide con la búsqueda" : "No hay matrículas en esta vista"}</h3>
          <p className="muted">{filtered ? "Prueba con otro programa o con otras palabras." : "Cuando se confirme un pago, cada curso habilitado en Moodle aparecerá aquí."}</p>
        </div>
      ) : (
        <>
          <div className="oi-table" style={{ opacity: pendingNav ? 0.6 : 1 }}>
            <table className="ix" data-testid="enrollments-table">
              <thead>
                <tr>
                  <th className="c-check">
                    {sel.size === 0 ? <input type="checkbox" className="cb" checked={false} onChange={() => setSel(new Set(rows.map((r) => r.id)))} aria-label="Seleccionar todas las matrículas de la página" /> : null}
                  </th>
                  <th>Médico</th>
                  <th>Curso</th>
                  <th>Estado</th>
                  <th>Progreso en Moodle</th>
                  <th className="h-md">Pedido</th>
                  <th>Última consulta</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    data-enrollment={r.id}
                    data-state={r.state}
                    className={sel.has(r.id) ? "sel" : undefined}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a,button,input,label")) return;
                      router.push(`/admin/customers/${r.customer.id}`);
                    }}
                  >
                    <td className="c-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="cb" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.course.title} de ${r.customer.name}`} />
                    </td>
                    <td className="lx-user">
                      <div className="lx-cell-user">
                        <Avatar name={r.customer.name} />
                        <span className="nm">
                          <Link href={`/admin/customers/${r.customer.id}`}>{r.customer.name}</Link>
                          <small>{r.customer.email}</small>
                        </span>
                      </div>
                    </td>
                    <td className="lx-course">
                      <span className="t">{r.course.title}</span>
                      <span className="s">
                        Moodle #{r.moodleCourseId}
                        {r.program ? ` · ${r.program.title}${r.program.monthly ? " (mes a mes)" : ""}` : " · Curso suelto"}
                      </span>
                    </td>
                    <td><StateBadge state={r.state} testId="enrollment-state" /></td>
                    <td className="lx-progress">{progressCell(r)}</td>
                    <td className="h-md">{r.order ? <Link className="lk" href={`/admin/orders/${r.order.id}`}>#{r.order.number}</Link> : "—"}</td>
                    <td className="lx-when" title={r.completionCheckedAt ? listDate(r.completionCheckedAt, now) : undefined}>{r.status === "ENROLLED" ? ago(r.completionCheckedAt, now) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="oi-list" data-testid="enrollments-list">
            {rows.map((r) => (
              <li key={r.id} data-state={r.state}>
                <div className="lx-l">
                  <input type="checkbox" className="cb" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar ${r.course.title} de ${r.customer.name}`} />
                  <Link className="m" href={`/admin/customers/${r.customer.id}`}>
                    <span className="t">{r.customer.name}</span>
                    <span className="c">{r.course.title}</span>
                    <span className="p">{r.program ? r.program.title : "Curso suelto"} · Moodle #{r.moodleCourseId}{r.order ? ` · #${r.order.number}` : ""}</span>
                    <span className="b"><StateBadge state={r.state} />{progressCell(r)}</span>
                  </Link>
                  <span className="r">{r.status === "ENROLLED" ? ago(r.completionCheckedAt, now) : ""}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="oi-foot">
        <span>{total === 0 ? "Sin matrículas" : `${from}–${to} de ${total} ${total === 1 ? "matrícula" : "matrículas"}`}</span>
        <nav className="adm-pager" aria-label="Paginación">
          {page > 1 ? <Link href={`${path}${enrollQuery(state, { page: page - 1 })}`} aria-label="Página anterior" scroll={false}><Icon name="prev" size={16} /></Link> : <span aria-hidden="true"><Icon name="prev" size={16} /></span>}
          {page < pages ? <Link href={`${path}${enrollQuery(state, { page: page + 1 })}`} aria-label="Página siguiente" scroll={false}><Icon name="next" size={16} /></Link> : <span aria-hidden="true"><Icon name="next" size={16} /></span>}
        </nav>
      </div>
      {toastNode}
    </div>
  );
}
