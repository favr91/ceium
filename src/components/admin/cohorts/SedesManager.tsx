"use client";
// Sedes (réplica de Configuración › Ubicaciones de Shopify): lista de sedes con dirección y estado, orden,
// alta/edición en un modal y el «inventario por ubicación»: cupos de las cohortes abiertas de cada sede.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reorderSedes, saveSede, type SedeInput } from "@/app/admin/(panel)/cohorts/actions";
import type { SedeRow } from "@/app/admin/(panel)/cohorts/data";
import { Icon } from "../Icon";
import { Modal, useToast } from "../ui";
import { SeatBar, occupancyPct } from "./SeatBar";
import "./cohorts.css";
import { fmtDay, type Seats } from "./types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugify = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const EMPTY: SedeInput = { slug: "", name: "", city: "", address: "", phone: "", mapUrl: "", active: true };

export function SedesManager({ sedes, canEdit }: { sedes: SedeRow[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [edit, setEdit] = useState<(SedeInput & { openCohorts?: number; seatsUsed?: number }) | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const open = (s?: SedeRow) => {
    setErr(null);
    setTried(false);
    setSlugTouched(!!s);
    setEdit(s ? { id: s.id, slug: s.slug, name: s.name, city: s.city, address: s.address, phone: s.phone, mapUrl: s.mapUrl, active: s.active, openCohorts: s.openCohorts, seatsUsed: s.seats.confirmed + s.seats.held } : { ...EMPTY });
  };
  const errors = edit
    ? {
        name: !edit.name.trim() ? "El nombre es obligatorio." : null,
        slug: !edit.slug.trim() ? "El identificador es obligatorio." : !SLUG_RE.test(edit.slug.trim()) ? "Solo minúsculas, números y guiones." : sedes.some((s) => s.slug === edit.slug.trim() && s.id !== edit.id) ? "Ya existe una sede con ese identificador." : null,
        mapUrl: edit.mapUrl.trim() && !/^https?:\/\//i.test(edit.mapUrl.trim()) ? "Debe empezar con https://" : null,
      }
    : { name: null, slug: null, mapUrl: null };
  const firstErr = Object.values(errors).find(Boolean);

  const submit = () => {
    if (!edit) return;
    setTried(true);
    if (firstErr) return;
    start(async () => {
      const { openCohorts: _o, seatsUsed: _u, ...input } = edit;
      void _o; void _u;
      const r = await saveSede(input);
      if (r.ok) { toast.show(edit.id ? "Sede guardada" : "Sede agregada"); setEdit(null); router.refresh(); }
      else setErr(r.error);
    });
  };

  const move = (i: number, d: -1 | 1) => {
    const ids = sedes.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    start(async () => {
      const r = await reorderSedes(ids);
      if (!r.ok) toast.show(r.error, true);
      router.refresh();
    });
  };

  const total: Seats = sedes.reduce((a, s) => ({ capacity: a.capacity + s.seats.capacity, confirmed: a.confirmed + s.seats.confirmed, held: a.held + s.seats.held, stale: a.stale + s.seats.stale, free: a.free + s.seats.free }), { capacity: 0, confirmed: 0, held: 0, stale: 0, free: 0 });
  const active = sedes.filter((s) => s.active).length;

  return (
    <>
      <div className="adm-ph">
        <div className="grow">
          <h1>Sedes</h1>
          <div className="meta">{active} {active === 1 ? "sede activa" : "sedes activas"} de {sedes.length} · donde se dictan las cohortes semipresenciales</div>
        </div>
        <div className="adm-ph-actions">
          <Link className="btn btn-gray hide-sm" href="/admin/cohorts">Cohortes</Link>
          {canEdit ? <button type="button" className="btn btn-primary" onClick={() => open()}>Agregar sede</button> : null}
        </div>
      </div>
      {!canEdit ? <div className="banner info" role="status"><Icon name="info" /><span>Tu rol (personal) puede ver las sedes y sus cupos; solo un administrador puede editarlas.</span></div> : null}

      <section className="card card-flush" aria-labelledby="h-sedes">
        <div className="card-h">
          <h2 id="h-sedes">Sedes</h2>
          <span className="small muted">El orden se usa en la tienda, el checkout y la matriz de precios</span>
        </div>
        <ul className="loc-list" style={{ marginTop: 8 }}>
          {sedes.map((s, i) => {
            const pct = occupancyPct(s.seats);
            return (
              <li key={s.id} className={s.active ? undefined : "off"} data-sede={s.slug}>
                <div className="loc-ico"><Icon name="location" /></div>
                <div style={{ minWidth: 0 }}>
                  <div className="loc-name">
                    <span>{s.name}</span>
                    {i === 0 ? <span className="badge sm info" title="Aparece primero en la tienda y el checkout">Predeterminada</span> : null}
                    {!s.active ? <span className="badge sm">Inactiva</span> : null}
                  </div>
                  <div className="loc-addr">{s.address || <span className="subdued">Sin dirección</span>}</div>
                  <div className="small muted" style={{ marginTop: 2 }}>
                    {[s.city, s.phone].filter(Boolean).join(" · ")}
                    {s.mapUrl ? <>{s.city || s.phone ? " · " : ""}<a className="lnk" href={s.mapUrl} target="_blank" rel="noreferrer">Ver mapa</a></> : null}
                  </div>
                </div>
                <div className="loc-stock">
                  <SeatBar seats={s.seats} />
                  <div className="l">
                    <span><span className="sw c" /> <b>{s.seats.confirmed}</b> conf.</span>
                    <span><span className="sw h" /> <b>{s.seats.held}</b> res.</span>
                    <span><span className="sw f" /> <b>{s.seats.free}</b> libres</span>
                    <span>{pct} % de {s.seats.capacity}</span>
                  </div>
                  <Link className="small lnk" href={`/admin/cohorts?sede=${s.slug}&view=OPEN`}>{s.openCohorts} {s.openCohorts === 1 ? "cohorte abierta" : "cohortes abiertas"}{s.inProgress ? ` · ${s.inProgress} en curso` : ""}</Link>
                </div>
                <div className="loc-acts">
                  {canEdit ? (
                    <>
                      <button type="button" className="btn btn-tertiary btn-icon hide-sm" aria-label={`Subir ${s.name}`} disabled={pending || i === 0} onClick={() => move(i, -1)}><Icon name="chevronUp" size={18} /></button>
                      <button type="button" className="btn btn-tertiary btn-icon hide-sm" aria-label={`Bajar ${s.name}`} disabled={pending || i === sedes.length - 1} onClick={() => move(i, 1)}><Icon name="chevronDown" size={18} /></button>
                      <button type="button" className="btn" aria-label={`Editar ${s.name}`} onClick={() => open(s)}>Editar</button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {!sedes.length ? <div className="ix-empty"><Icon name="location" size={40} /><h3>Sin sedes</h3><p className="muted">Agrega la primera sede para crear cohortes semipresenciales.</p></div> : null}
      </section>

      <section className="card card-flush" aria-labelledby="h-inv" style={{ marginTop: 16 }}>
        <div className="card-h">
          <h2 id="h-inv">Cupos por sede</h2>
          <span className="small muted">Cohortes con inscripciones abiertas</span>
        </div>
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table className="inv" aria-label="Cupos por sede">
            <thead>
              <tr>
                <th>Sede</th>
                <th className="num">Abiertas</th>
                <th className="num"><span className="sw c" style={{ marginRight: 6 }} />Confirmados</th>
                <th className="num"><span className="sw h" style={{ marginRight: 6 }} />Reservados</th>
                <th className="num"><span className="sw f" style={{ marginRight: 6 }} />Libres</th>
                <th className="num">Cupo</th>
                <th className="h-sm">Próxima cohorte</th>
              </tr>
            </thead>
            <tbody>
              {sedes.map((s) => (
                <tr key={s.id} data-inv={s.slug}>
                  <td><Link className="lnk" href={`/admin/cohorts?sede=${s.slug}`}>{s.name}</Link></td>
                  <td className="num">{s.openCohorts}</td>
                  <td className="num">{s.seats.confirmed}</td>
                  <td className="num">{s.seats.held}</td>
                  <td className="num"><b>{s.seats.free}</b></td>
                  <td className="num">{s.seats.capacity}</td>
                  <td className="h-sm">{s.next ? <Link className="lnk" href={`/admin/cohorts/${s.next.id}`}>{fmtDay(s.next.startDate)}</Link> : <span className="subdued">—</span>}{s.next ? <div className="small muted" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.next.program}</div> : null}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{sedes.reduce((a, s) => a + s.openCohorts, 0)}</td>
                <td className="num">{total.confirmed}</td>
                <td className="num">{total.held}</td>
                <td className="num">{total.free}</td>
                <td className="num">{total.capacity}</td>
                <td className="h-sm" />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
      <p className="muted" style={{ textAlign: "center", marginTop: 20 }}>Una sede inactiva deja de mostrarse en el pie de la tienda; sus cohortes y pedidos no cambian.</p>

      {edit ? (
        <Modal
          title={edit.id ? `Editar ${edit.name || "sede"}` : "Agregar sede"}
          onClose={() => setEdit(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" disabled={pending} onClick={submit}>{pending ? "Guardando…" : edit.id ? "Guardar" : "Agregar sede"}</button>
            </>
          }
        >
          {err ? <div className="banner critical" role="alert"><Icon name="alert" /><span>{err}</span></div> : null}
          <div className="grid2">
            <label className="field">
              <span>Nombre</span>
              <input className="inp" aria-label="Nombre de la sede" value={edit.name} autoFocus aria-invalid={tried && !!errors.name} onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, name: v, ...(!slugTouched ? { slug: slugify(v) } : {}) }); }} />
              {tried && errors.name ? <span className="field-err">{errors.name}</span> : null}
            </label>
            <label className="field">
              <span>Identificador</span>
              <input className="inp" aria-label="Identificador" value={edit.slug} aria-invalid={tried && !!errors.slug} onChange={(e) => { setSlugTouched(true); const v = e.target.value; setEdit((x) => x && { ...x, slug: v }); }} />
              {tried && errors.slug ? <span className="field-err">{errors.slug}</span> : <span className="help">Para filtros y enlaces: {edit.slug || "…"}</span>}
            </label>
          </div>
          <label className="field">
            <span>Dirección</span>
            <textarea className="inp" aria-label="Dirección" value={edit.address} rows={2} onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, address: v }); }} />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Ciudad y estado</span>
              <input className="inp" aria-label="Ciudad" value={edit.city} placeholder="Barquisimeto, Lara" onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, city: v }); }} />
            </label>
            <label className="field">
              <span>Teléfono</span>
              <input className="inp" aria-label="Teléfono" value={edit.phone} placeholder="0251-000 0000" onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, phone: v }); }} />
            </label>
          </div>
          <label className="field">
            <span>Enlace del mapa</span>
            <input className="inp" aria-label="Enlace del mapa" value={edit.mapUrl} placeholder="https://maps.google.com/…" aria-invalid={tried && !!errors.mapUrl} onChange={(e) => { const v = e.target.value; setEdit((x) => x && { ...x, mapUrl: v }); }} />
            {tried && errors.mapUrl ? <span className="field-err">{errors.mapUrl}</span> : null}
          </label>
          <div className="divider" />
          <label className="check">
            <input type="checkbox" aria-label="Sede activa" checked={edit.active} onChange={(e) => { const v = e.target.checked; setEdit((x) => x && { ...x, active: v }); }} />
            <span className="t">Sede activa<span className="d">Se muestra en la tienda y se ofrece al crear cohortes y precios.</span></span>
          </label>
          {edit.id && !edit.active && (edit.openCohorts ?? 0) > 0 ? (
            <div className="banner attention" style={{ marginTop: 12, marginBottom: 0 }} role="note">
              <Icon name="alert" />
              <span>Tiene {edit.openCohorts} {edit.openCohorts === 1 ? "cohorte abierta" : "cohortes abiertas"}{edit.seatsUsed ? ` con ${edit.seatsUsed} cupos ocupados` : ""}. Siguen vendiéndose hasta que las cierres.</span>
            </div>
          ) : null}
        </Modal>
      ) : null}
      {toast.node}
    </>
  );
}
