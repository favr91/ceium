"use client";
// Detalle / alta de cohorte (réplica del patrón de detalle del admin de Shopify): el cupo arriba con
// confirmados / reservados / libres, fechas y cronograma de sesiones, reservas de la cohorte; a la derecha
// estado, sede, precio, notas e historial. Barra de guardado contextual cuando hay cambios.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deleteCohortAction, saveCohort } from "@/app/admin/(panel)/cohorts/actions";
import { Icon } from "../Icon";
import { ExportButton } from "../ExportButton";
import { Modal, useToast } from "../ui";
import { SeatBar, occupancyPct } from "./SeatBar";
import { StatusPill } from "./CohortsIndex";
import "./cohorts.css";
import {
  COHORT_STATUSES, ORDER_STATUS_LABEL, RELEASE_LABEL, STATUS_HELP, STATUS_LABEL, fmtDay, relDays,
  type CohortContext, type CohortForm, type ReservationRow, type SessionItem,
} from "./types";

const ACTION_LABEL: Record<string, string> = {
  "cohort.create": "Cohorte creada",
  "cohort.update": "Cohorte actualizada",
  "cohort.status": "Estado cambiado",
  "cohort.delete": "Cohorte eliminada",
};
const FIELD_LABEL: Record<string, string> = { capacity: "cupo", startDate: "inicio", endDate: "fin", enrollmentDeadline: "cierre", sessions: "sesiones", status: "estado", name: "nombre", notes: "notas", scheduleUrl: "cronograma" };

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleString("es-VE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Caracas" });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const todayVz = () => new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const blank: SessionItem = { date: "", title: "", startTime: "", endTime: "", courseSlug: "" };

export function CohortEditor({ initial, ctx, canEdit }: { initial: CohortForm; ctx: CohortContext; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [base, setBase] = useState(initial);
  const [saving, start] = useTransition();
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resTab, setResTab] = useState<"live" | "released">("live");
  const isNew = !form.id;
  const ro = !canEdit;
  const today = todayVz();

  const initialJson = JSON.stringify(initial);
  const last = useRef(initialJson);
  useEffect(() => {
    if (last.current === initialJson) return;
    last.current = initialJson;
    setForm(initial);
    setBase(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJson]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(base), [form, base]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const set = <K extends keyof CohortForm>(k: K, v: CohortForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const program = ctx.programs.find((p) => p.id === form.productId) ?? null;
  const sede = ctx.sedes.find((s) => s.id === form.sedeId) ?? null;
  const price = program && sede ? program.prices[sede.id] : undefined;
  const seats = ctx.seats;
  const used = seats ? seats.confirmed + seats.held : 0;
  const capNum = /^\d+$/.test(form.capacity.trim()) ? Number(form.capacity) : NaN;
  // Vista previa con el cupo que se está escribiendo.
  const preview = seats && !Number.isNaN(capNum) ? { ...seats, capacity: capNum, free: Math.max(0, capNum - used) } : seats;

  const errors = {
    product: isNew && !form.productId ? "Elige el programa." : null,
    sede: isNew && !form.sedeId ? "Elige la sede." : null,
    name: !form.name.trim() ? "El nombre es obligatorio." : null,
    startDate: !form.startDate ? "Indica la fecha de inicio." : null,
    endDate: !form.endDate ? "Indica la fecha de fin." : form.startDate && form.endDate < form.startDate ? "El fin no puede ser anterior al inicio." : null,
    deadline: form.enrollmentDeadline && form.endDate && form.enrollmentDeadline > form.endDate ? "El cierre no puede ser posterior al fin." : null,
    capacity: Number.isNaN(capNum) ? "El cupo debe ser un número entero." : capNum < used ? `No puede ser menor que ${used === 1 ? "el cupo ocupado" : `los ${used} cupos ocupados`}.` : capNum > 10000 ? "Máximo 10 000." : null,
    status: form.status === "CANCELLED" && base.status !== "CANCELLED" && used > 0 ? "No se puede cancelar con cupos ocupados: reasigna o reembolsa esos pedidos primero." : null,
    sessions: form.sessions.some((s) => (s.date || s.title.trim()) && (!s.date || !s.title.trim())) ? "Cada sesión necesita fecha y título." : null,
  };
  const firstError = Object.values(errors).find(Boolean);
  const err = (k: keyof typeof errors) => (tried && errors[k] ? <span className="field-err"><Icon name="alert" size={18} />{errors[k]}</span> : null);

  const save = () => {
    setTried(true);
    if (firstError) { setError(firstError); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    setError(null);
    start(async () => {
      const r = await saveCohort(form);
      if (r.ok) {
        toast.show(isNew ? "Cohorte creada" : "Cohorte guardada");
        setTried(false);
        if (isNew && r.id) { setBase(form); router.replace(`/admin/cohorts/${r.id}`); }
        else router.refresh();
      } else {
        setError(r.error);
        toast.show(r.error, true);
        router.refresh();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  };

  const setProgram = (id: string) => {
    const p = ctx.programs.find((x) => x.id === id);
    setForm((f) => ({ ...f, productId: id, ...(p && !f.name.trim() ? { name: suggestName(f.startDate) } : {}) }));
  };
  // «Cohorte octubre 2026», como las cohortes existentes (los meses van en minúscula).
  const suggestName = (startDate: string) => {
    if (!startDate) return "";
    const d = new Date(`${startDate}T12:00:00Z`);
    return `Cohorte ${d.toLocaleString("es-VE", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
  };

  // Sesiones
  const setSession = (i: number, patch: Partial<SessionItem>) => set("sessions", form.sessions.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addSession = () => {
    const lastDate = form.sessions.map((s) => s.date).filter(Boolean).sort().at(-1);
    set("sessions", [...form.sessions, { ...blank, date: lastDate ? addDays(lastDate, 7) : form.startDate }]);
  };
  const generate = () => {
    if (!program || !form.startDate) return;
    if (program.type === "DIPLOMA" && program.courses.length) {
      // Un curso por mes: cada 4 semanas desde el inicio, en el orden del diplomado.
      const ss = program.courses.map((c, i) => ({ ...blank, date: addDays(form.startDate, i * 28), title: c.title, courseSlug: c.slug }));
      const end = addDays(ss.at(-1)!.date, 27);
      setForm((f) => ({ ...f, sessions: ss, endDate: f.endDate && f.endDate >= end ? f.endDate : end }));
    } else {
      const days: string[] = [];
      for (let d = form.startDate; d <= (form.endDate || form.startDate) && days.length < 60; d = addDays(d, 1)) days.push(d);
      set("sessions", days.map((d, i) => ({ ...blank, date: d, title: days.length > 1 ? `Día ${i + 1}: ${program.title}` : program.title })));
    }
  };
  const sortedIdx = form.sessions.map((s, i) => ({ s, i }));

  const live = ctx.reservations.filter((r) => r.live);
  const released = ctx.reservations.filter((r) => !r.live);
  const resRows = resTab === "live" ? live : released;
  const storeUrl = program ? `/products/${program.slug}` : null;
  const occ = preview ? occupancyPct(preview) : 0;

  return (
    <>
      {dirty && canEdit ? (
        <div className="savebar" role="region" aria-label="Cambios sin guardar">
          <div className="savebar-in">
            <div className="msg"><Icon name="alert" size={18} /> <span>{isNew ? "Cohorte sin guardar" : "Cambios sin guardar"}</span></div>
            <button type="button" className="btn btn-dark" disabled={saving} onClick={() => (isNew ? router.push("/admin/cohorts") : (setForm(base), setTried(false), setError(null)))}>Descartar</button>
            <button type="button" className="btn btn-save" disabled={saving} onClick={save}>{saving ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      ) : null}

      <div className="adm-page">
        <div className="adm-ph">
          <Link href="/admin/cohorts" className="adm-back" aria-label="Cohortes"><Icon name="back" /></Link>
          <div className="grow">
            <h1>{isNew ? "Crear cohorte" : base.name}</h1>
            {!isNew ? <StatusPill status={base.status} /> : null}
            {ctx.isSample ? <span className="badge" title="Dato de ejemplo del seed">Ejemplo</span> : null}
            {!isNew && program ? <div className="meta">{program.title} · {sede?.name}</div> : null}
          </div>
          {!isNew ? (
            <div className="adm-ph-actions">
              {canEdit ? <Link className="btn btn-gray" href={`/admin/cohorts/new?from=${form.id}`}>Duplicar</Link> : null}
              {storeUrl && program?.published ? <a className="btn btn-gray hide-sm" href={storeUrl} target="_blank" rel="noreferrer">Ver en la tienda</a> : null}
              <span className="adm-pager">
                {ctx.prevId ? <Link href={`/admin/cohorts/${ctx.prevId}`} aria-label="Cohorte anterior"><Icon name="prev" size={16} /></Link> : <span aria-hidden><Icon name="prev" size={16} /></span>}
                {ctx.nextId ? <Link href={`/admin/cohorts/${ctx.nextId}`} aria-label="Cohorte siguiente"><Icon name="next" size={16} /></Link> : <span aria-hidden><Icon name="next" size={16} /></span>}
              </span>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="banner critical" role="alert">
            <Icon name="alert" />
            <div><b>No se pudo guardar</b><div>{error}</div></div>
            <button className="x" aria-label="Cerrar" onClick={() => setError(null)}><Icon name="x" size={16} /></button>
          </div>
        ) : null}
        {ctx.isSample ? (
          <div className="banner attention" role="note"><Icon name="info" /><span>Cohorte de <b>ejemplo</b> creada por el seed: confirma fechas, cupo y sesiones reales antes de venderla.</span></div>
        ) : null}

        <div className="layout">
          <div className="col">
            {/* Cupo */}
            <section className="card" aria-labelledby="h-cupo" id="sec-cupo">
              <div className="card-h">
                <h2 id="h-cupo">Cupo</h2>
                {preview ? <span className="small muted">{occ} % ocupado</span> : null}
              </div>
              {preview ? (
                <>
                  <div className="seat-hero" data-testid="seat-hero">
                    <div>
                      <div className="k"><span className="sw c" /> Confirmados</div>
                      <div className="v" data-testid="seats-confirmed">{preview.confirmed}</div>
                      <div className="s">Primer pago confirmado</div>
                    </div>
                    <div>
                      <div className="k"><span className="sw h" /> Reservados</div>
                      <div className="v" data-testid="seats-held">{preview.held}</div>
                      <div className="s">{preview.stale ? `+${preview.stale} ${preview.stale === 1 ? "vencida" : "vencidas"} por liberar` : "En checkout o verificación"}</div>
                    </div>
                    <div>
                      <div className="k"><span className="sw f" /> Libres</div>
                      <div className={`v${preview.free === 0 ? " crit" : ""}`} data-testid="seats-free">{preview.free}</div>
                      <div className="s">{preview.free === 0 ? "Cohorte llena" : "Disponibles para vender"}</div>
                    </div>
                    <div>
                      <div className="k">Cupo total</div>
                      <div className="v" data-testid="seats-capacity">{preview.capacity}</div>
                      <div className="s">{capNum !== seats!.capacity && !Number.isNaN(capNum) ? `Antes: ${seats!.capacity}` : "Máximo de alumnos"}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <SeatBar seats={preview} size="lg" />
                    <div className="seat-scale"><span>0</span><span>{preview.capacity}</span></div>
                  </div>
                </>
              ) : null}
              <div className="cap-row" style={{ marginTop: preview ? 14 : 0 }}>
                <label className="field" style={{ margin: 0 }}>
                  <span>{isNew ? "Cupo máximo" : "Cambiar cupo"}</span>
                  <div className="stepper">
                    <button type="button" className="btn" aria-label="Quitar un cupo" disabled={ro || Number.isNaN(capNum) || capNum <= used} onClick={() => set("capacity", String(Math.max(used, capNum - 1)))}>−</button>
                    <input className="inp" name="capacity" inputMode="numeric" aria-label="Cupo máximo" value={form.capacity} readOnly={ro} aria-invalid={(tried || !isNew) && !!errors.capacity} placeholder="25" onChange={(e) => set("capacity", e.target.value.replace(/[^\d]/g, "").slice(0, 5))} />
                    <button type="button" className="btn" aria-label="Agregar un cupo" disabled={ro} onClick={() => set("capacity", String((Number.isNaN(capNum) ? 0 : capNum) + 1))}>+</button>
                  </div>
                </label>
                <p className="muted" style={{ flex: 1, minWidth: 200, paddingBottom: 6 }}>
                  {isNew ? "Alumnos que caben en la sede. La tienda deja de vender al llenarse." : used ? <>Mínimo <b>{used}</b>: {seats!.confirmed} {seats!.confirmed === 1 ? "confirmado" : "confirmados"} + {seats!.held} {seats!.held === 1 ? "reservado" : "reservados"}. Nunca se vende por encima del cupo.</> : "Sin cupos ocupados: puedes ajustarlo libremente."}
                </p>
              </div>
              {errors.capacity && (tried || !isNew) ? <span className="field-err" role="alert"><Icon name="alert" size={18} />{errors.capacity}</span> : null}
              {ctx.purchasable ? (
                <div className={`sell-state ${ctx.purchasable.ok ? "ok" : "no"}`} data-testid="sell-state">
                  <Icon name={ctx.purchasable.ok ? "check" : "info"} size={18} />
                  <span>{ctx.purchasable.reason}</span>
                </div>
              ) : null}
            </section>

            {/* Detalles */}
            <section className="card" aria-labelledby="h-det">
              <div className="card-h"><h2 id="h-det">Programa, sede y fechas</h2></div>
              <div className="grid2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
                <label className="field">
                  <span>Programa</span>
                  {isNew ? (
                    <select className="inp" aria-label="Programa" value={form.productId} aria-invalid={tried && !!errors.product} onChange={(e) => setProgram(e.target.value)}>
                      <option value="">Elige un programa semipresencial</option>
                      {(["DIPLOMA", "COURSE"] as const).map((t) => (
                        <optgroup key={t} label={t === "DIPLOMA" ? "Diplomados" : "Cursos y talleres"}>
                          {ctx.programs.filter((p) => p.type === t).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  ) : (
                    <Link className="inp" href={`/admin/products/${form.productId}`} style={{ color: "var(--p-link)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{program?.title ?? "—"}</Link>
                  )}
                  {err("product")}
                </label>
                <label className="field">
                  <span>Sede</span>
                  {isNew ? (
                    <select className="inp" aria-label="Sede" value={form.sedeId} aria-invalid={tried && !!errors.sede} onChange={(e) => set("sedeId", e.target.value)}>
                      <option value="">Elige una sede</option>
                      {ctx.sedes.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? "" : " (inactiva)"}</option>)}
                    </select>
                  ) : (
                    <input className="inp" value={sede?.name ?? "—"} readOnly aria-label="Sede" />
                  )}
                  {err("sede")}
                </label>
              </div>
              {!isNew ? <p className="help" style={{ marginTop: -4, marginBottom: 12 }}>Programa y sede se fijan al crear la cohorte. Para mover a un alumno, reasígnalo desde su pedido.</p> : null}
              <label className="field">
                <span>Nombre</span>
                <input className="inp" name="name" aria-label="Nombre" value={form.name} readOnly={ro} placeholder="Cohorte I - 2027" aria-invalid={tried && !!errors.name} onChange={(e) => set("name", e.target.value)} />
                {err("name") ?? <span className="help">Lo ve el alumno al elegir fecha en la tienda.</span>}
              </label>
              <div className="grid3">
                <label className="field">
                  <span>Inicio</span>
                  <input className="inp" type="date" aria-label="Fecha de inicio" value={form.startDate} readOnly={ro} aria-invalid={tried && !!errors.startDate} onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value, ...(isNew && !f.name.trim() && program ? { name: suggestName(e.target.value) } : {}) }))} />
                  {err("startDate")}
                </label>
                <label className="field">
                  <span>Fin</span>
                  <input className="inp" type="date" aria-label="Fecha de fin" value={form.endDate} min={form.startDate || undefined} readOnly={ro} aria-invalid={tried && !!errors.endDate} onChange={(e) => set("endDate", e.target.value)} />
                  {err("endDate")}
                </label>
                <label className="field">
                  <span>Cierre de inscripciones</span>
                  <input className="inp" type="date" aria-label="Cierre de inscripciones" value={form.enrollmentDeadline} max={form.endDate || undefined} readOnly={ro} aria-invalid={tried && !!errors.deadline} onChange={(e) => set("enrollmentDeadline", e.target.value)} />
                  {err("deadline")}
                </label>
              </div>
              <p className="help">
                {form.startDate && form.endDate ? `${relDays(today, form.startDate, form.endDate)} · ` : ""}
                {form.enrollmentDeadline ? `Se vende hasta el ${fmtDay(form.enrollmentDeadline)} inclusive.` : "Sin cierre: se vende mientras esté abierta y haya cupo."}
              </p>
            </section>

            {/* Sesiones */}
            <section className="card card-flush" aria-labelledby="h-ses" id="sec-sessions">
              <div className="card-h">
                <h2 id="h-ses">Cronograma <span className="sub">· {form.sessions.length} {form.sessions.length === 1 ? "sesión" : "sesiones"}</span></h2>
                {!ro && program && form.startDate ? (
                  <button type="button" className="btn btn-plain" onClick={generate}>{program.type === "DIPLOMA" && program.courses.length ? `Generar ${program.courses.length} ${program.courses.length === 1 ? "curso" : "cursos"} (1 por mes)` : "Generar un día por fecha"}</button>
                ) : null}
              </div>
              <p className="muted" style={{ padding: "0 16px 12px" }}>Reemplaza el PDF de cronograma: el alumno ve estas fechas en su pedido y en los correos de la sede.</p>
              {form.sessions.length ? (
                <table className="sess" aria-label="Sesiones">
                  <thead><tr><th>#</th><th>Fecha</th><th>Título</th><th>Desde</th><th>Hasta</th><th><span className="sr-only">Quitar</span></th></tr></thead>
                  <tbody>
                    {sortedIdx.map(({ s, i }) => (
                      <tr key={i} className={s.date && s.date < today ? "past" : undefined}>
                        <td className="t-n"><span className="n">{i + 1}</span></td>
                        <td className="t-date w-date"><input className="inp" type="date" aria-label={`Fecha de la sesión ${i + 1}`} value={s.date} readOnly={ro} onChange={(e) => setSession(i, { date: e.target.value })} /></td>
                        <td className="t-title"><input className="inp" aria-label={`Título de la sesión ${i + 1}`} value={s.title} readOnly={ro} placeholder="Curso o tema" onChange={(e) => setSession(i, { title: e.target.value })} /></td>
                        <td className="t-start w-time"><input className="inp" type="time" aria-label={`Hora de inicio de la sesión ${i + 1}`} value={s.startTime} readOnly={ro} onChange={(e) => setSession(i, { startTime: e.target.value })} /></td>
                        <td className="t-end w-time"><input className="inp" type="time" aria-label={`Hora de fin de la sesión ${i + 1}`} value={s.endTime} readOnly={ro} onChange={(e) => setSession(i, { endTime: e.target.value })} /></td>
                        <td className="t-del">{!ro ? <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Quitar sesión ${i + 1}`} onClick={() => set("sessions", form.sessions.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="sess-empty">Sin sesiones cargadas.</div>
              )}
              {err("sessions") ? <div style={{ padding: "0 16px" }}>{err("sessions")}</div> : null}
              <div className="card-foot">
                {!ro ? <button type="button" className="btn" onClick={addSession}><Icon name="plus" size={16} /> Agregar sesión</button> : <span />}
                <span>Se ordenan por fecha al guardar</span>
              </div>
            </section>

            {/* Reservas */}
            {!isNew ? (
              <section className="card card-flush" aria-labelledby="h-res">
                <div className="card-h">
                  <h2 id="h-res">Alumnos y reservas</h2>
                  <span className="small muted" style={{ marginLeft: "auto" }}>{live.length} {live.length === 1 ? "ocupa cupo" : "ocupan cupo"}</span>
                  {ctx.reservations.length ? (
                    <ExportButton
                      title="Exportar lista de alumnos"
                      endpoint={`/admin/cohorts/${form.id}/export`}
                      className="btn btn-plain"
                      initial={resTab === "released" ? "all" : "live"}
                      options={[
                        { key: "live", label: `Quienes ocupan cupo (${live.length})`, query: "" },
                        { key: "all", label: `Todas las reservas, también las liberadas y vencidas (${ctx.reservations.length})`, query: "all=1" },
                      ]}
                      note="Incluye cédula, correo, teléfono, pedido, cupo y saldo de cada médico: sirve como lista de asistencia de la sede."
                    >
                      Exportar
                    </ExportButton>
                  ) : null}
                </div>
                <div className="res-tabs" role="tablist" aria-label="Reservas">
                  <button type="button" role="tab" aria-selected={resTab === "live"} className={`ix-tab${resTab === "live" ? " active" : ""}`} onClick={() => setResTab("live")}>Ocupan cupo <span className="n">{live.length}</span></button>
                  <button type="button" role="tab" aria-selected={resTab === "released"} className={`ix-tab${resTab === "released" ? " active" : ""}`} onClick={() => setResTab("released")}>Liberadas y vencidas <span className="n">{released.length}</span></button>
                </div>
                {resRows.length ? (
                  <table className="res-table" aria-label={resTab === "live" ? "Reservas que ocupan cupo" : "Reservas liberadas"}>
                    <thead><tr><th>Pedido</th><th>Alumno</th><th>Cupo</th><th>Estado del pedido</th><th>Fecha</th></tr></thead>
                    <tbody>{resRows.map((r) => <ResRow key={r.id} r={r} />)}</tbody>
                  </table>
                ) : (
                  <div className="sess-empty">{resTab === "live" ? "Nadie ocupa cupo todavía. Aparecerán aquí al iniciar un checkout." : "Sin reservas liberadas."}</div>
                )}
              </section>
            ) : null}
          </div>

          {/* ───────── Lateral ───────── */}
          <div className="col">
            <section className="card">
              <label className="field">
                <span className="strong">Estado</span>
                <select className="inp" aria-label="Estado" value={form.status} disabled={ro} aria-invalid={!!errors.status} onChange={(e) => set("status", e.target.value as CohortForm["status"])}>
                  {COHORT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                </select>
                {errors.status ? <span className="field-err" role="alert"><Icon name="alert" size={18} />{errors.status}</span> : <span className="help">{STATUS_HELP[form.status]}</span>}
              </label>
            </section>

            <section className="card">
              <div className="card-h"><h2>Sede</h2>{sede ? <Link className="btn btn-plain" href="/admin/sedes">Administrar</Link> : null}</div>
              {sede ? (
                <>
                  <div className="row"><Icon name="location" size={18} /><b>{sede.name}</b>{!sede.active ? <span className="badge sm">Inactiva</span> : null}</div>
                  {sede.address ? <p className="muted" style={{ marginTop: 6 }}>{sede.address}</p> : null}
                </>
              ) : <p className="muted">Elige una sede.</p>}
            </section>

            <section className="card">
              <div className="card-h"><h2>Precio semipresencial</h2></div>
              {program && sede ? (
                price != null ? (
                  <>
                    <div style={{ fontSize: 20, lineHeight: "28px", fontWeight: 700 }} className="mono">{usd(price)}</div>
                    <p className="muted small">Precio de lista en {sede.name}. Se edita en la matriz del programa.</p>
                  </>
                ) : (
                  <p className="field-err" style={{ marginTop: 0 }}>Sin precio en {sede.name}: la cohorte no se podrá comprar.</p>
                )
              ) : <p className="muted">Elige programa y sede.</p>}
              {program ? <Link className="btn btn-plain" style={{ paddingLeft: 0, marginTop: 4 }} href={`/admin/products/${program.id}#sec-prices`}>Ver precios del programa</Link> : null}
            </section>

            <section className="card">
              <div className="card-h"><h2>Notas internas</h2></div>
              <textarea className="inp" aria-label="Notas internas" value={form.notes} readOnly={ro} placeholder="Aula, docente, logística…" onChange={(e) => set("notes", e.target.value)} />
              <label className="field" style={{ marginTop: 12 }}>
                <span>Cronograma en PDF (opcional)</span>
                <input className="inp" aria-label="Cronograma en PDF" value={form.scheduleUrl} readOnly={ro} placeholder="https://" onChange={(e) => set("scheduleUrl", e.target.value)} />
              </label>
            </section>

            {!isNew ? (
              <section className="card">
                <div className="card-h"><h2>Historial</h2></div>
                {ctx.audit.length ? (
                  <ul className="tl">
                    {ctx.audit.map((a) => (
                      <li key={a.id}>
                        <div>{ACTION_LABEL[a.action] ?? a.action}{a.fields.length && a.action !== "cohort.create" ? <span className="muted"> · {a.fields.slice(0, 3).map((f) => FIELD_LABEL[f] ?? f).join(", ")}{a.fields.length > 3 ? "…" : ""}</span> : null}</div>
                        {a.note ? <div className="small muted">{a.note}</div> : null}
                        <div className="small muted">{fmtWhen(a.when)}{a.who ? ` · ${a.who}` : ""}</div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="muted">{ctx.isSample ? "Creada por el seed." : "Sin cambios registrados."}</p>}
              </section>
            ) : null}
          </div>
        </div>

        {canEdit ? (
          <div className="page-foot">
            <div className="btn-group">
              {!isNew ? <button type="button" className="btn btn-critical" onClick={() => setConfirmDelete(true)}>Eliminar cohorte</button> : null}
            </div>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || (!dirty && !isNew)}>{saving ? "Guardando…" : isNew ? "Crear cohorte" : "Guardar"}</button>
          </div>
        ) : null}
      </div>

      {confirmDelete ? (
        <Modal
          title={`¿Eliminar «${base.name}»?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>{ctx.hasSales ? "Entendido" : "Cancelar"}</button>
              {!ctx.hasSales ? (
                <button type="button" className="btn btn-critical" disabled={saving} onClick={() => start(async () => {
                  const r = await deleteCohortAction(form.id!);
                  if (r.ok) { setBase(form); toast.show("Cohorte eliminada"); router.push("/admin/cohorts"); }
                  else { setConfirmDelete(false); toast.show(r.error, true); }
                })}>Eliminar cohorte</button>
              ) : null}
            </>
          }
        >
          {ctx.hasSales ? (
            <p>Esta cohorte ya tuvo pedidos o reservas, así que no se puede borrar. Ciérrala (deja de venderse) o, si no se dicta, cancélala después de reasignar o reembolsar a sus alumnos.</p>
          ) : (
            <p>Se borra la cohorte con sus fechas y sesiones. Nunca tuvo ventas. No se puede deshacer.</p>
          )}
        </Modal>
      ) : null}
      {toast.node}
    </>
  );
}

function ResRow({ r }: { r: ReservationRow }) {
  const state =
    r.status === "CONFIRMED" ? <span className="badge success sm"><span className="sw c" style={{ marginRight: 4 }} />Confirmado</span>
    : r.status === "HELD" && r.live ? <span className="badge attention sm"><span className="sw h" style={{ marginRight: 4 }} />Reservado</span>
    : r.status === "HELD" ? <span className="badge sm">Vencido</span>
    : <span className="badge sm">Liberado</span>;
  const when =
    r.status === "CONFIRMED" && r.confirmedAt ? `Confirmado ${fmtWhen(r.confirmedAt)}`
    : r.status === "HELD" && r.live ? `Vence ${fmtWhen(r.expiresAt)}`
    : r.status === "HELD" ? `Venció ${fmtWhen(r.expiresAt)}`
    : `Liberado ${r.releasedAt ? fmtWhen(r.releasedAt) : ""}${r.releasedReason ? ` · ${RELEASE_LABEL[r.releasedReason] ?? r.releasedReason}` : ""}`;
  return (
    <tr data-reservation={r.status}>
      <td className="r-num"><Link className="lnk" href={`/admin/orders/${r.orderId}`}>#{r.orderNumber}</Link></td>
      <td className="r-who"><div>{r.customer || "—"}</div><div className="small muted">{r.email}</div></td>
      <td className="r-state">{state}</td>
      <td className="r-order"><span className="small">{ORDER_STATUS_LABEL[r.orderStatus] ?? r.orderStatus}</span>{r.plan ? <div className="small muted ell" title={r.plan}>{r.plan}</div> : null}</td>
      <td className="r-when small muted">{when}</td>
    </tr>
  );
}
