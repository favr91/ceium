"use client";
// Ficha del cliente (réplica de la página de cliente de Shopify): cabecera con nombre, «Más acciones» y cliente
// anterior/siguiente; resumen (pagado, pedidos, cliente desde, saldo); a la izquierda el último pedido, los
// programas con su avance en Moodle curso a curso (y el certificado) y la cronología de todos sus pedidos; a la
// derecha contacto, datos del médico, aula virtual, certificados, pedidos y nota interna editable.
import Link from "next/link";
import { useState } from "react";
import type { CustomerDetail } from "@/server/admin-learning";
import { refreshProgressAction, retryEnrollmentsAction } from "@/app/admin/(panel)/enrollments/actions";
import { checkCertificateAction, resendCertificateAction } from "@/app/admin/(panel)/certificates/actions";
import { linkMoodleAccountAction, saveCustomerNoteAction } from "@/app/admin/(panel)/customers/actions";
import { Icon } from "../Icon";
import { Badge, Copy, Spinner, useDismiss } from "../orders/bits";
import { EMAIL_TEMPLATE, ORDER_STATUS, PLAN, calDate, dayKey, dayLabel, eventDetails, eventKind, eventMessage, listDate, time, usd } from "../orders/format";
import { Avatar, Bar, StateBadge, ago, dm, useRun } from "./shared";

type C = CustomerDetail;
interface Perms { manage: boolean; resend: boolean; note: boolean }

const F_MONTH = new Intl.DateTimeFormat("es-VE", { month: "long", year: "numeric", timeZone: "America/Caracas" });

export function CustomerView({ c, perms }: { c: C; perms: Perms }) {
  const { run, busy, toastNode } = useRun();
  const [menuRef, menuOpen, setMenuOpen] = useDismiss<HTMLDivElement>();
  const cu = c.customer;
  const active = c.programs.flatMap((p) => p.courses).filter((x) => x.state === "IN_PROGRESS" || x.state === "COMPLETED").map((x) => x.enrollmentId!).filter(Boolean);
  const failed = [...c.programs.flatMap((p) => p.courses), ...c.otherEnrollments].filter((x) => x.state === "FAILED" || x.state === "PENDING");
  const failedIds = failed.map((x) => ("enrollmentId" in x ? x.enrollmentId : x.id)).filter((x): x is string => !!x);
  const loc = [cu.city, cu.country === "VE" ? "Venezuela" : cu.country].filter(Boolean).join(", ");

  return (
    <div className="adm-page">
      <div className="od-head cu-head">
        <Link href="/admin/enrollments" className="adm-back" aria-label="Matrículas">
          <Icon name="back" />
        </Link>
        <div className="od-title">
          <div className="l1">
            <h1>{cu.name}</h1>
            {cu.moodleUserId ? <Badge spec={{ label: "Con aula virtual", tone: "success", progress: null }} /> : <Badge spec={{ label: "Sin cuenta de Moodle", tone: "neutral", progress: null }} />}
          </div>
          <div className="meta">
            {loc ? `${loc} · ` : ""}Cliente desde {F_MONTH.format(new Date(cu.createdAt))}
          </div>
        </div>
        <div className="od-actions">
          <div className="od-menu" ref={menuRef}>
            <button type="button" className="btn btn-gray" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              Más acciones <Icon name="chevronDown" size={16} />
            </button>
            {menuOpen ? (
              <>
              <div className="menu-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />
              <div className="menu" role="menu">
                <button type="button" className="mi" role="menuitem" disabled={!perms.manage || !active.length} onClick={() => { setMenuOpen(false); void run("refresh", () => refreshProgressAction(active)); }}>
                  <Icon name="enroll" size={18} /> Consultar progreso en Moodle
                </button>
                <button type="button" className="mi" role="menuitem" disabled={!perms.manage || !failedIds.length} onClick={() => { setMenuOpen(false); void run("retry", () => retryEnrollmentsAction(failedIds)); }}>
                  <Icon name="enroll" size={18} /> Reintentar matrícula
                </button>
                <div className="sep" />
                <Link className="mi" role="menuitem" href={`/admin/orders?q=${encodeURIComponent(cu.email)}`}>
                  <Icon name="order" size={18} /> Ver pedidos
                </Link>
                <a className="mi" role="menuitem" href={`mailto:${cu.email}`}>
                  <Icon name="mail" size={18} /> Escribir por correo
                </a>
              </div>
              </>
            ) : null}
          </div>
          <nav className="adm-pager" aria-label="Clientes">
            {c.prev ? <Link href={`/admin/customers/${c.prev}`} aria-label="Cliente anterior"><Icon name="prev" size={16} /></Link> : <span aria-hidden="true"><Icon name="prev" size={16} /></span>}
            {c.next ? <Link href={`/admin/customers/${c.next}`} aria-label="Cliente siguiente"><Icon name="next" size={16} /></Link> : <span aria-hidden="true"><Icon name="next" size={16} /></span>}
          </nav>
        </div>
      </div>

      <div className="layout">
        <div className="col">
          <section className="cu-stats" aria-label="Resumen del cliente">
            <div>
              <span className="l">Monto pagado</span>
              <span className="v" data-testid="stat-paid">{usd(c.stats.paidCents)}</span>
            </div>
            <div>
              <span className="l">Pedidos</span>
              <span className="v">{c.stats.orders}</span>
            </div>
            <div>
              <span className="l">Completados</span>
              <span className="v" data-testid="stat-completed">{c.stats.coursesCompleted} <small className="lp-count" style={{ fontSize: 12, fontWeight: 450 }}>de {c.stats.coursesActive}</small></span>
            </div>
            <div>
              <span className="l">Saldo pendiente</span>
              <span className={`v${c.stats.balanceCents > 0 ? " attn" : ""}`} data-testid="stat-balance">{usd(c.stats.balanceCents)}</span>
            </div>
          </section>

          {c.lastOrder ? (
            <section className="card cu-last" aria-labelledby="h-last">
              <div className="cu-card-h"><h2 id="h-last">Último pedido</h2></div>
              <div className="top">
                <Link className="n" href={`/admin/orders/${c.lastOrder.id}`}>Pedido #{c.lastOrder.number}</Link>
                <Badge spec={{ ...(ORDER_STATUS[c.lastOrder.status] ?? { label: c.lastOrder.status, tone: "neutral" as const }), progress: null }} />
                {c.lastOrder.balanceCents > 0 && c.lastOrder.status !== "REFUNDED" ? <Badge spec={{ label: `Saldo ${usd(c.lastOrder.balanceCents)}`, tone: "attention", progress: "partial" }} /> : null}
                <span className="amt">{usd(c.lastOrder.totalCents)}</span>
              </div>
              <div className="when">{listDate(c.lastOrder.placedAt, c.now)} · Tienda en línea</div>
              <ul className="items">
                {c.lastOrder.items.map((it) => (
                  <li key={it.id}>
                    <span className="thumb" style={{ width: 40, height: 40 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN del catálogo */}
                      {it.image ? <img src={it.image.url} alt="" /> : <Icon name="product" />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{it.title}</div>
                      <div className="s">{[it.modality === "ONLINE" ? "Online" : "Semipresencial", it.sede, it.planLabel].filter(Boolean).join(" · ")}</div>
                    </div>
                    <span className="p">{usd(it.totalCents)}</span>
                  </li>
                ))}
              </ul>
              <div className="cu-foot">
                {c.orders.length > 1 ? <Link className="btn" href={`/admin/orders?q=${encodeURIComponent(cu.email)}`}>Ver los {c.orders.length} pedidos</Link> : null}
                <Link className="btn" href={`/admin/orders/${c.lastOrder.id}`}>Ver pedido</Link>
              </div>
            </section>
          ) : null}

          <section className="card" aria-labelledby="h-progs" data-testid="programs">
            <div className="cu-card-h">
              <h2 id="h-progs">Programas y avance en Moodle</h2>
              {perms.manage && active.length ? (
                <button type="button" className="btn btn-plain" disabled={!!busy} onClick={() => run("refresh", () => refreshProgressAction(active))}>
                  {busy === "refresh" ? <Spinner /> : null} Consultar progreso
                </button>
              ) : null}
            </div>
            {c.programs.length === 0 ? <p className="muted">Este cliente no tiene programas vigentes. Aparecen aquí cuando se confirma un pago.</p> : null}
            {c.programs.map((p) => {
              const isDiploma = p.product.type === "DIPLOMA";
              const lastCheck = p.courses.reduce<Date | null>((a, x) => (x.completionCheckedAt && (!a || new Date(x.completionCheckedAt) > a) ? new Date(x.completionCheckedAt) : a), null);
              const allDone = p.courses.length > 0 && p.completed === p.courses.length;
              return (
                <div key={p.orderItemId} className="cu-prog" data-program={p.product.title}>
                  <div className="hd">
                    <span className="thumb" style={{ width: 40, height: 40 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN del catálogo */}
                      {p.product.image ? <img src={p.product.image.url} alt="" /> : <Icon name="product" />}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{p.product.title}</div>
                      <div className="s">
                        {[p.modality === "ONLINE" ? "Online" : "Semipresencial", p.sede, p.cohort ? `${p.cohort.name} (${calDate(p.cohort.startDate)})` : null, p.choice, p.planLabel ?? PLAN[p.planKind]].filter(Boolean).join(" · ")} ·{" "}
                        <Link href={`/admin/orders/${p.order.id}`}>#{p.order.number}</Link>
                      </div>
                    </div>
                    {isDiploma ? <Badge spec={allDone ? { label: "Completado", tone: "success", progress: "complete" } : p.completed > 0 ? { label: "En curso", tone: "info", progress: "partial" } : { label: "Sin iniciar", tone: "neutral", progress: "incomplete" }} /> : null}
                  </div>
                  {isDiploma ? (
                    <div className="pr">
                      <Bar value={p.completed} max={p.courses.length} tone="success" label={`Avance en ${p.product.title}`} />
                      <span className="n" data-testid="program-progress">{p.completed} de {p.courses.length} cursos</span>
                    </div>
                  ) : <div style={{ height: 12 }} />}
                  <ul className="cu-courses">
                    {p.courses.map((x) => (
                      <li key={x.id} data-state={x.state}>
                        <span className="pos">{x.state === "COMPLETED" ? <Icon name="check" size={12} /> : x.position}</span>
                        <span className="nm">
                          {x.title}
                          <small>
                            {x.moodleCourseId ? `Moodle #${x.moodleCourseId}` : "Sin curso de Moodle"}
                            {x.state === "COMPLETED" && x.completedAt ? ` · completado el ${dm(x.completedAt, c.now)}` : ""}
                            {x.state === "IN_PROGRESS" && x.enrolledAt ? ` · matriculado el ${dm(x.enrolledAt, c.now)}` : ""}
                            {x.state === "LOCKED" && x.installment ? ` · cuota ${x.installment.sequence} ${x.installment.status === "OVERDUE" ? "vencida" : "pendiente"} (${usd(x.installment.amountCents)})` : ""}
                            {x.state === "FAILED" && x.lastError ? ` · ${x.lastError.slice(0, 90)}` : ""}
                          </small>
                        </span>
                        <StateBadge state={x.state} />
                      </li>
                    ))}
                  </ul>
                  {isDiploma ? <CertificateStrip p={p} c={c} perms={perms} run={run} busy={busy} /> : null}
                  <div className="small muted" style={{ marginTop: 8 }}>Última consulta a Moodle: {ago(lastCheck, c.now).toLowerCase()}</div>
                </div>
              );
            })}
            {c.otherEnrollments.length ? (
              <div className="cu-prog">
                <div className="small muted" style={{ marginBottom: 8 }}>Otras matrículas (pedidos reembolsados o cancelados)</div>
                <ul className="cu-courses">
                  {c.otherEnrollments.map((x) => (
                    <li key={x.id} data-state={x.state}>
                      <span className="pos">·</span>
                      <span className="nm">{x.title}<small>Moodle #{x.moodleCourseId}</small></span>
                      <StateBadge state={x.state} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {perms.manage && failedIds.length ? (
              <div className="cu-acts">
                <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => run("retry", () => retryEnrollmentsAction(failedIds))}>
                  {busy === "retry" ? <Spinner /> : null} Reintentar matrícula
                </button>
              </div>
            ) : null}
          </section>

          <CustomerTimeline c={c} />
        </div>

        <div className="col">
          <NoteCard c={c} canEdit={perms.note} run={run} busy={busy} />

          <section className="card" aria-labelledby="h-cust">
            <div className="side-sec">
              <h3 id="h-cust">Información de contacto</h3>
              <p className="ln email" title={cu.email}>
                <Copy text={cu.email} label="Copiar correo">
                  <a className="lk" href={`mailto:${cu.email}`}>{cu.email}</a>
                </Copy>
              </p>
              {cu.phone ? (
                <p className="ln">
                  <Copy text={cu.phone} label="Copiar teléfono">
                    <a className="lk" href={`https://wa.me/58${cu.phone.replace(/\D/g, "").replace(/^0/, "")}`} target="_blank" rel="noreferrer">{cu.phone}</a>
                  </Copy>
                </p>
              ) : <p className="muted">Sin teléfono</p>}
            </div>
            <div className="side-sec">
              <h3>Datos del médico</h3>
              {cu.cedula ? <p>Cédula {cu.cedula}</p> : null}
              <p>{cu.specialty ?? <span className="muted">Sin especialidad</span>}</p>
              <p className="muted">{loc || "Sin ciudad"}</p>
            </div>
            <div className="side-sec">
              <h3>Aula virtual</h3>
              {cu.moodleUserId ? (
                <>
                  <p>Usuario <span className="mono">{cu.moodleUsername}</span></p>
                  <p className="muted small">Moodle #{cu.moodleUserId}</p>
                  {cu.moodleProfileUrl ? <p><a className="lk" href={cu.moodleProfileUrl} target="_blank" rel="noreferrer">Ver perfil en Moodle <Icon name="external" size={14} /></a></p> : null}
                </>
              ) : (
                <>
                  <p className="muted">Se crea con el primer pago confirmado.</p>
                  {perms.manage ? <MoodleLinkForm customerId={cu.id} run={run} busy={busy} /> : null}
                </>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="h-certs">
            <div className="cu-card-h"><h2 id="h-certs">Certificados</h2><span className="lp-count small">{c.certificates.length}</span></div>
            {c.certificates.length === 0 ? <p className="muted small">Aún sin certificados. Se emiten al completar todos los cursos del diplomado con saldo cero.</p> : null}
            <ul className="cu-certs">
              {c.certificates.map((x) => (
                <li key={x.id} data-code={x.code}>
                  <Icon name="certificate" size={18} />
                  <div className="i">
                    <div className="t">{x.diploma.title}</div>
                    <div className="s">
                      <a className="lk lp-mono" href={`/certificados/${encodeURIComponent(x.code)}`} target="_blank" rel="noreferrer">{x.code}</a> · {dm(x.issuedAt, c.now)}
                    </div>
                    {x.status === "REVOKED" ? <div className="lp-err">Revocado: {x.revokeReason}</div> : null}
                  </div>
                  {x.status === "ISSUED" ? (
                    <a className="btn btn-tertiary btn-icon" href={`/admin/certificates/${x.id}/pdf?download=1`} aria-label={`Descargar PDF de ${x.code}`} title="Descargar PDF"><Icon name="download" size={18} /></a>
                  ) : <Badge spec={{ label: "Revocado", tone: "critical", progress: null }} />}
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="h-orders">
            <div className="cu-card-h"><h2 id="h-orders">Pedidos</h2><span className="lp-count small">{c.orders.length}</span></div>
            <ul className="cu-orders">
              {c.orders.slice(0, 6).map((o) => (
                <li key={o.id}>
                  <Link href={`/admin/orders/${o.id}`}>
                    <span className="n">#{o.number}</span>
                    <span className="d">{dm(o.placedAt, c.now)} · {ORDER_STATUS[o.status]?.label ?? o.status}</span>
                    <span className="p">{usd(o.totalCents)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            {c.orders.length > 6 ? <Link className="lk small" href={`/admin/orders?q=${encodeURIComponent(cu.email)}`}>Ver todos</Link> : null}
          </section>

          {c.emails.length ? (
            <section className="card" aria-labelledby="h-mail">
              <div className="cu-card-h"><h2 id="h-mail">Correos recientes</h2></div>
              <ul className="mail-list">
                {c.emails.slice(0, 5).map((m) => (
                  <li key={m.id}>
                    <div className="i">
                      <div className="t">
                        {EMAIL_TEMPLATE[m.template] ?? m.template}
                        <Badge spec={{ label: m.status === "SENT" ? "Enviado" : m.status === "FAILED" ? "Falló" : "En cola", tone: m.status === "SENT" ? "success" : m.status === "FAILED" ? "critical" : "attention", progress: null }} />
                      </div>
                      <div className="s">{listDate(m.sentAt ?? m.createdAt, c.now)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
      {toastNode}
    </div>
  );
}

type Run = ReturnType<typeof useRun>["run"];

function CertificateStrip({ p, c, perms, run, busy }: { p: C["programs"][number]; c: C; perms: Perms; run: Run; busy: string | null }) {
  const cert = p.certificate;
  const allDone = p.courses.length > 0 && p.completed === p.courses.length;
  if (cert) {
    const ok = cert.status === "ISSUED";
    return (
      <div className={`cu-cert ${ok ? "ok" : "warn"}`} data-testid="certificate-strip">
        <Icon name="certificate" size={18} />
        <span className="grow">
          {ok ? <>Certificado <b className="lp-mono">{cert.code}</b> emitido el {dm(cert.issuedAt, c.now)}{cert.emailedAt ? " y enviado por correo." : " · correo pendiente."}</> : <>Certificado <b className="lp-mono">{cert.code}</b> revocado: {cert.revokeReason}</>}
        </span>
        {ok ? <a className="btn" href={`/admin/certificates/${cert.id}/pdf`} target="_blank" rel="noreferrer">Ver PDF</a> : null}
        {ok && perms.resend ? (
          <button type="button" className="btn" disabled={!!busy} onClick={() => run(`cert:${cert.id}`, () => resendCertificateAction(cert.id))}>
            {busy === `cert:${cert.id}` ? <Spinner /> : null} Reenviar
          </button>
        ) : null}
      </div>
    );
  }
  const blocked = allDone && p.order.balanceCents > 0;
  return (
    <div className={`cu-cert${blocked ? " warn" : ""}`} data-testid="certificate-strip">
      <Icon name="certificate" size={18} />
      <span className="grow">
        {blocked
          ? <>Completó todos los cursos. El certificado se emite al cancelar el saldo de <b>{usd(p.order.balanceCents)}</b>.</>
          : <>Certificado pendiente: faltan {p.courses.length - p.completed} {p.courses.length - p.completed === 1 ? "curso" : "cursos"}{p.order.balanceCents > 0 ? ` y un saldo de ${usd(p.order.balanceCents)}` : ""}.</>}
      </span>
      {perms.manage ? (
        <button type="button" className="btn" disabled={!!busy} onClick={() => run(`chk:${p.orderItemId}`, () => checkCertificateAction(c.customer.id, p.product.id))}>
          {busy === `chk:${p.orderItemId}` ? <Spinner /> : null} Revisar certificado
        </button>
      ) : null}
    </div>
  );
}

/** Si el médico ya tenía cuenta en Moodle y la tienda no la encontró, el staff la vincula a mano. */
function MoodleLinkForm({ customerId, run, busy }: { customerId: string; run: Run; busy: string | null }) {
  const [ref, setRef] = useState("");
  return (
    <form
      aria-label="Vincular cuenta de Moodle"
      style={{ marginTop: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (ref.trim()) await run("moodle-link", () => linkMoodleAccountAction(customerId, ref));
      }}
    >
      <label className="small muted" htmlFor="moodle-link-ref">¿Ya tiene cuenta en Moodle? Número, correo o usuario</label>
      <input id="moodle-link-ref" className="inp" value={ref} maxLength={200} onChange={(e) => setRef(e.target.value)} placeholder="p. ej. 1234 o Dra.Lopez@gmail.com" />
      <div className="cu-acts">
        <button type="submit" className="btn" disabled={!ref.trim() || busy === "moodle-link"}>{busy === "moodle-link" ? <Spinner /> : null} Vincular cuenta de Moodle</button>
      </div>
    </form>
  );
}

function NoteCard({ c, canEdit, run, busy }: { c: C; canEdit: boolean; run: Run; busy: string | null }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.customer.notes ?? "");
  return (
    <section className="card cu-note" aria-labelledby="h-note">
      <div className="cu-card-h">
        <h2 id="h-note">Notas</h2>
        {canEdit && !editing ? (
          <button type="button" className="btn btn-tertiary btn-icon" aria-label="Editar nota" title="Editar nota" onClick={() => { setText(c.customer.notes ?? ""); setEditing(true); }}>
            <Icon name="edit" size={18} />
          </button>
        ) : null}
      </div>
      {editing ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run("note", () => saveCustomerNoteAction(c.customer.id, text));
            if (r.ok) setEditing(false);
          }}
        >
          <textarea className="inp" aria-label="Nota del cliente" value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} autoFocus placeholder="Solo la ve el equipo de CEIUM" />
          <div className="cu-acts">
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={busy === "note"}>{busy === "note" ? <Spinner /> : null} Guardar</button>
          </div>
        </form>
      ) : c.customer.notes ? (
        <p style={{ whiteSpace: "pre-wrap" }} data-testid="customer-note">{c.customer.notes}</p>
      ) : (
        <p className="muted" data-testid="customer-note">Sin notas sobre este cliente.</p>
      )}
    </section>
  );
}

function CustomerTimeline({ c }: { c: C }) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const groups: { key: string; label: string; items: C["events"] }[] = [];
  for (const e of c.events) {
    const k = dayKey(e.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(e);
    else groups.push({ key: k, label: dayLabel(e.createdAt, c.now), items: [e] });
  }
  const toggle = (id: string) => setOpenIds((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <section className="otl-sec" aria-labelledby="h-tl">
      <h2 id="h-tl">Cronología</h2>
      <p className="otl-note" style={{ textAlign: "left", marginTop: 0 }}>Todo lo que pasó en los pedidos de {c.customer.firstName}: pagos, matrículas en Moodle, correos y certificados.</p>
      <ol className="otl" data-testid="timeline">
        {groups.map((g) => (
          <li key={g.key} style={{ listStyle: "none" }}>
            <div className="day">{g.label}</div>
            <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {g.items.map((e) => {
                const kind = eventKind(e.type);
                const open = openIds.has(e.id);
                if (kind === "comment" && e.actorType === "ADMIN") {
                  return (
                    <li key={e.id} className="ev comment" data-event={e.type}>
                      <Avatar name={e.actor?.name ?? "?"} />
                      <div className="txt">
                        <div className="bubble">
                          <div className="who">{e.actor?.name ?? "Panel"} · <Link className="cu-tl-order" href={`/admin/orders/${e.order.id}`}>#{e.order.number}</Link></div>
                          {e.note}
                        </div>
                      </div>
                      <span className="tm">{time(e.createdAt)}</span>
                    </li>
                  );
                }
                return (
                  <li key={e.id} className={`ev ${kind}`} data-event={e.type}>
                    <div className="txt">
                      <button type="button" className="more" aria-expanded={open} onClick={() => toggle(e.id)}>
                        <span>{eventMessage(e, { customerName: c.customer.name })}</span>
                        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
                      </button>{" "}
                      <Link className="cu-tl-order" href={`/admin/orders/${e.order.id}`}>#{e.order.number}</Link>
                      <dl className="dl" hidden={!open}>
                        {eventDetails(e).map(([k, v]) => (
                          <span key={k} style={{ display: "contents" }}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </span>
                        ))}
                      </dl>
                    </div>
                    <span className="tm">{time(e.createdAt)}</span>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
        {groups.length === 0 ? <li className="ev">Sin actividad todavía.</li> : null}
      </ol>
    </section>
  );
}
