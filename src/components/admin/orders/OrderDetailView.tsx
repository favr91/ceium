"use client";
// Ficha del pedido (réplica de la página de pedido de Shopify): cabecera con estado del pedido, del pago y de la
// matrícula, «Reembolsar», «Más acciones» y pedido anterior/siguiente; a la izquierda Programas (cupo, cohorte,
// cursos), Pago (resumen, cuotas, transacciones con verificación y reembolso) y la Cronología; a la derecha
// Notas, Cliente, Moodle y Correos.
import Link from "next/link";
import { useState } from "react";
import { Icon } from "../Icon";
import { adjustBalanceAction, cancelOrderAction, reassignCohortAction, reenrollAction, resendEmailAction, unenrollAction } from "@/app/admin/(panel)/orders/actions";
import type { OrderDetail } from "@/server/admin-order-views";
import { Badge, Copy, Spinner, useDismiss } from "./bits";
import { OrderProvider, useOrder, type Perms } from "./context";
import { EMAIL_TEMPLATE, ENROLLMENT_STATUS, ORDER_STATUS, RELEASE_REASON, RESERVATION_STATUS, calDate, enrollmentBadge, inSentenceDate, listDate, longDate, usd } from "./format";
import { AdjustModal, ConfirmModal, EmailPreview, ReassignModal, TextModal } from "./modals";
import { PaymentCard } from "./PaymentCard";
import { Timeline } from "./Timeline";

type O = OrderDetail;
type Modal = null | "reassign" | "adjust" | "cancel" | "reenroll" | "unenroll" | { email: string };

export function OrderDetailView({ o, perms, adminName }: { o: O; perms: Perms; adminName: string }) {
  return (
    <OrderProvider perms={perms}>
      <Inner o={o} adminName={adminName} />
    </OrderProvider>
  );
}

function enrollSummary(o: O) {
  const e = { total: o.enrollments.length, enrolled: 0, failed: 0, unenrolled: 0, pending: 0 };
  for (const x of o.enrollments) {
    if (x.status === "ENROLLED") e.enrolled++;
    else if (x.status === "FAILED") e.failed++;
    else if (x.status === "UNENROLLED") e.unenrolled++;
    else e.pending++;
  }
  return e;
}

function Inner({ o, adminName }: { o: O; adminName: string }) {
  const { perms, run, busy } = useOrder();
  const [modal, setModal] = useState<Modal>(null);
  const [menuRef, menuOpen, setMenuOpen] = useDismiss<HTMLDivElement>();
  const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: "neutral" as const };
  const enr = enrollSummary(o);
  const monthly = o.items.find((i) => i.planKind === "MONTHLY");
  const enrBadge = enrollmentBadge(o.status, enr, monthly ? { courses: Math.max(monthly.courses.length, o.installments.length) } : null);
  const refundable = o.payments.filter((p) => p.refundableCents > 0);
  const paidState = ["PAID", "PARTIALLY_PAID", "ENROLLED"].includes(o.status);
  const canReassign = perms.reassign && o.items.some((i) => i.modality === "SEMIPRESENCIAL") && !["REFUNDED", "CANCELLED", "EXPIRED", "REJECTED"].includes(o.status);
  const canCancel = perms.cancel && o.amountPaidCents <= 0 && !o.payments.some((p) => p.status === "AWAITING_VERIFICATION") && ["PENDING_PAYMENT", "EXPIRED", "REJECTED"].includes(o.status);
  const canAdjust = perms.adjust && ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"].includes(o.status);
  const canEnroll = perms.enroll && paidState;
  const canUnenroll = perms.enroll && o.enrollments.some((e) => e.status === "ENROLLED");
  const awaiting = o.payments.filter((p) => p.status === "AWAITING_VERIFICATION");
  const customerName = `${o.customer.firstName} ${o.customer.lastName}`.trim();
  const email = typeof modal === "object" && modal ? o.emails.find((m) => m.id === modal.email) : null;
  const attention = o.events.filter((e) => e.type === "ATTENTION");
  const lastAttention = attention[attention.length - 1];
  const openRefund = () => {
    const d = document.querySelector<HTMLDetailsElement>(`details[data-refund-for="${refundable[0]?.id}"]`);
    if (d) d.open = true;
  };
  const method = o.paymentMethod ? { PAYPAL: "PayPal", PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia", ZELLE: "Zelle", EFECTIVO: "Efectivo" }[o.paymentMethod] : null;

  return (
    <div className="adm-page">
      <div className="od-head">
        <Link href="/admin/orders" className="adm-back" aria-label="Pedidos">
          <Icon name="back" />
        </Link>
        <div className="od-title">
          <div className="l1">
            <h1>Pedido #{o.number}</h1>
            <Badge spec={{ ...st, progress: null }} testId="order-status" />
            {enrBadge && !(o.status === "ENROLLED" && enrBadge.label === "Inscrito") ? <Badge spec={enrBadge} /> : null}
            {paidState && o.balanceCents > 0 ? <Badge spec={{ label: `Saldo ${usd(o.balanceCents)}`, tone: "attention", progress: "partial" }} /> : null}
          </div>
          <div className="meta">
            {longDate(o.placedAt)} · Tienda en línea{method ? ` · ${method}` : ""}
          </div>
        </div>
        <div className="od-actions">
          {refundable.length && perms.refund ? (
            <button type="button" className="btn btn-gray" onClick={openRefund}>
              Reembolsar
            </button>
          ) : null}
          <div className="od-menu" ref={menuRef}>
            <button type="button" className="btn btn-gray" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              Más acciones <Icon name="chevronDown" size={16} />
            </button>
            {menuOpen ? (
              <>
              {/* Fondo de la hoja de acciones en el teléfono (en escritorio no se ve): tocarlo solo cierra el menú. */}
              <div className="menu-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />
              <div className="menu" role="menu" onClick={() => setMenuOpen(false)}>
                <button type="button" role="menuitem" className="mi" disabled={!canReassign} onClick={() => setModal("reassign")}>
                  <Icon name="cohort" size={18} /> Reasignar cohorte
                </button>
                <button type="button" role="menuitem" className="mi" disabled={!canAdjust} onClick={() => setModal("adjust")}>
                  <Icon name="order" size={18} /> Ajustar saldo
                </button>
                <button type="button" role="menuitem" className="mi" disabled={!canEnroll} onClick={() => setModal("reenroll")}>
                  <Icon name="enroll" size={18} /> Rematricular en Moodle
                </button>
                <button type="button" role="menuitem" className="mi" disabled={!canUnenroll} onClick={() => setModal("unenroll")}>
                  <Icon name="logout" size={18} /> Desmatricular de Moodle
                </button>
                <div className="sep" />
                <a role="menuitem" className="mi" href={`/pedido/${o.token}`} target="_blank" rel="noreferrer">
                  <Icon name="external" size={18} /> Ver la página del pedido del cliente
                </a>
                <button type="button" role="menuitem" className="mi" onClick={() => window.print()}>
                  <Icon name="duplicate" size={18} /> Imprimir
                </button>
                <div className="sep" />
                <button type="button" role="menuitem" className="mi critical" disabled={!canCancel} onClick={() => setModal("cancel")}>
                  <Icon name="x" size={18} />
                  <span>
                    Cancelar pedido
                    {!canCancel && perms.cancel ? <span className="hint">Solo sin pagos confirmados ni por verificar.</span> : null}
                  </span>
                </button>
              </div>
              </>
            ) : null}
          </div>
          <nav className="adm-pager" aria-label="Pedidos vecinos">
            {o.next ? (
              <Link href={`/admin/orders/${o.next.id}`} aria-label={`Pedido siguiente #${o.next.number}`} title={`#${o.next.number}`}>
                <Icon name="prev" size={16} />
              </Link>
            ) : (
              <span aria-disabled="true"><Icon name="prev" size={16} /></span>
            )}
            {o.prev ? (
              <Link href={`/admin/orders/${o.prev.id}`} aria-label={`Pedido anterior #${o.prev.number}`} title={`#${o.prev.number}`}>
                <Icon name="next" size={16} />
              </Link>
            ) : (
              <span aria-disabled="true"><Icon name="next" size={16} /></span>
            )}
          </nav>
        </div>
      </div>

      {awaiting.length ? (
        <div className="banner attention" role="note">
          <Icon name="alert" />
          <span>
            <b>{awaiting.length === 1 ? "Hay un pago por verificar." : `Hay ${awaiting.length} pagos por verificar.`}</b> Compara el comprobante con tu estado de cuenta y apruébalo o recházalo. El médico recibe un correo en ambos casos.{" "}
            <a className="lk" href={`#verificar-${awaiting[0].id}`}>Ver el comprobante</a>
          </span>
        </div>
      ) : null}
      {lastAttention && !["REFUNDED", "CANCELLED"].includes(o.status) ? (
        <div className="banner critical" role="note">
          <Icon name="alert" />
          <span>
            <b>Requiere atención:</b> {lastAttention.note}
          </span>
        </div>
      ) : null}

      <div className="layout">
        <div className="col">
          {/* Con un pago por verificar, la tarjeta de pago (y su comprobante) va primero. */}
          {awaiting.length ? <PaymentCard o={o} onAdjust={() => setModal("adjust")} /> : null}
          <ItemsCard o={o} enrBadge={enrBadge} canReassign={canReassign} canEnroll={canEnroll} onReassign={() => setModal("reassign")} onReenroll={() => setModal("reenroll")} />
          {awaiting.length ? null : <PaymentCard o={o} onAdjust={() => setModal("adjust")} />}
          <Timeline orderId={o.id} events={o.events} customerName={customerName} adminName={adminName} now={o.now} onViewEmail={(id) => setModal({ email: id })} />
        </div>
        <div className="col">
          <section className="card" aria-labelledby="h-notes">
            <div className="od-card-h">
              <h2 id="h-notes" className="grow">Notas</h2>
            </div>
            {o.customerNote ? <p style={{ whiteSpace: "pre-wrap" }}>{o.customerNote}</p> : <p className="muted">El cliente no dejó notas.</p>}
          </section>

          <section className="card" aria-labelledby="h-cust">
            <div className="side-sec">
              <h3 id="h-cust">Cliente</h3>
              <p>
                <Link className="lk" href={`/admin/orders?q=${encodeURIComponent(o.customer.email)}`}>{customerName}</Link>
              </p>
              <p className="muted">{o.customerOrders === 1 ? "1 pedido" : `${o.customerOrders} pedidos`}</p>
            </div>
            <div className="side-sec">
              <h3>Información de contacto</h3>
              <p className="ln email" title={o.customer.email}>
                <Copy text={o.customer.email} label="Copiar correo">
                  <a className="lk" href={`mailto:${o.customer.email}`}>{o.customer.email}</a>
                </Copy>
              </p>
              {o.customer.phone ? (
                <p className="ln">
                  <Copy text={o.customer.phone} label="Copiar teléfono">
                    <a className="lk" href={`https://wa.me/58${o.customer.phone.replace(/\D/g, "").replace(/^0/, "")}`} target="_blank" rel="noreferrer">{o.customer.phone}</a>
                  </Copy>
                </p>
              ) : (
                <p className="muted">Sin teléfono</p>
              )}
            </div>
            <div className="side-sec">
              <h3>Datos del médico</h3>
              {o.customer.cedula ? <p>Cédula {o.customer.cedula}</p> : null}
              {o.customer.specialty ? <p>{o.customer.specialty}</p> : null}
              <p className="muted">{[o.customer.city, o.customer.country === "VE" ? "Venezuela" : o.customer.country].filter(Boolean).join(", ") || "Sin ciudad"}</p>
            </div>
            <div className="side-sec">
              <h3>Aula virtual</h3>
              {o.customer.moodleUsername ? (
                <p>
                  Usuario <span className="mono">{o.customer.moodleUsername}</span>
                  <br />
                  <span className="muted small">Moodle #{o.customer.moodleUserId}</span>
                </p>
              ) : (
                <p className="muted">Aún sin cuenta de Moodle.</p>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="h-enr">
            <div className="od-card-h">
              <h2 id="h-enr" className="grow">Matrícula en Moodle</h2>
              {canEnroll ? (
                <button type="button" className="btn btn-plain" onClick={() => setModal("reenroll")}>Rematricular</button>
              ) : null}
            </div>
            {o.enrollments.length === 0 ? <p className="small muted">{paidState ? "La matrícula está en curso." : "Se matricula cuando se confirma el pago."}</p> : null}
            <EnrollmentList o={o} />
          </section>

          <section className="card" aria-labelledby="h-mail">
            <div className="od-card-h">
              <h2 id="h-mail" className="grow">Correos al cliente</h2>
              <span className="sub small">{o.emails.length}</span>
            </div>
            {o.emails.length === 0 ? <p className="small muted">Sin correos.</p> : null}
            <ul className="mail-list" data-testid="emails">
              {[...o.emails].reverse().map((m) => (
                <li key={m.id} data-template={m.template}>
                  <div className="i">
                    <div className="t">
                      {EMAIL_TEMPLATE[m.template] ?? m.template}
                      <Badge spec={{ label: m.status === "SENT" ? "Enviado" : m.status === "FAILED" ? "Falló" : "En cola", tone: m.status === "SENT" ? "success" : m.status === "FAILED" ? "critical" : "attention", progress: null }} />
                    </div>
                    <div className="s">{listDate(m.sentAt ?? m.createdAt, o.now)}</div>
                    {m.status === "FAILED" && m.lastError ? <div className="field-err">{m.lastError}</div> : null}
                  </div>
                  <div className="acts">
                    <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Ver «${EMAIL_TEMPLATE[m.template] ?? m.template}»`} title="Ver correo" onClick={() => setModal({ email: m.id })}>
                      <Icon name="eye" size={18} />
                    </button>
                    {perms.resend ? (
                      <button type="button" className="btn btn-tertiary btn-icon" aria-label={`Reenviar «${EMAIL_TEMPLATE[m.template] ?? m.template}»`} title="Reenviar" disabled={busy === `mail:${m.id}`} onClick={() => run(`mail:${m.id}`, () => resendEmailAction(o.id, m.id))}>
                        {busy === `mail:${m.id}` ? <Spinner /> : <Icon name="upload" size={18} />}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      {modal === "reassign" ? (
        <ReassignModal
          o={o}
          busy={busy === "reassign"}
          onClose={() => setModal(null)}
          onSubmit={async (itemId, cohortId, note) => {
            const r = await run("reassign", () => reassignCohortAction(o.id, itemId, cohortId, note));
            if (r.ok) setModal(null);
          }}
        />
      ) : null}
      {modal === "adjust" ? (
        <AdjustModal
          o={o}
          busy={busy === "adjust"}
          onClose={() => setModal(null)}
          onSubmit={async (kind, amount, reason) => {
            const r = await run("adjust", () => adjustBalanceAction(o.id, kind, amount, reason));
            if (r.ok) setModal(null);
          }}
        />
      ) : null}
      {modal === "cancel" ? (
        <TextModal
          title={`Cancelar el pedido #${o.number}`}
          label="Motivo de la cancelación"
          help="Se libera el cupo reservado y el pedido queda cerrado. No se envía correo al cliente."
          confirm="Cancelar pedido"
          critical
          busy={busy === "cancel"}
          onClose={() => setModal(null)}
          onSubmit={async (reason) => {
            const r = await run("cancel", () => cancelOrderAction(o.id, reason));
            if (r.ok) setModal(null);
          }}
        />
      ) : null}
      {modal === "reenroll" ? (
        <ConfirmModal
          title="Rematricular en Moodle"
          confirm="Rematricular"
          busy={busy === "reenroll"}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            const r = await run("reenroll", () => reenrollAction(o.id));
            if (r.ok) setModal(null);
          }}
        >
          Se vuelve a crear o actualizar la cuenta de Moodle de <b>{customerName}</b> y se matricula en los cursos pagados de este pedido. Es seguro repetirlo: no duplica matrículas.
        </ConfirmModal>
      ) : null}
      {modal === "unenroll" ? (
        <ConfirmModal
          title="Desmatricular de Moodle"
          confirm="Desmatricular"
          critical
          busy={busy === "unenroll"}
          onClose={() => setModal(null)}
          onConfirm={async () => {
            const r = await run("unenroll", () => unenrollAction(o.id));
            if (r.ok) setModal(null);
          }}
        >
          <b>{customerName}</b> pierde el acceso a los cursos de este pedido en Moodle (salvo los que tenga por otro pedido vigente). El pago y el cupo no cambian.
        </ConfirmModal>
      ) : null}
      {email ? (
        <EmailPreview
          orderId={o.id}
          email={email}
          canResend={perms.resend}
          busy={busy === `mail:${email.id}`}
          onClose={() => setModal(null)}
          onResend={async () => {
            const r = await run(`mail:${email.id}`, () => resendEmailAction(o.id, email.id));
            if (r.ok) setModal(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ItemsCard({ o, enrBadge, canReassign, canEnroll, onReassign, onReenroll }: { o: O; enrBadge: ReturnType<typeof enrollmentBadge>; canReassign: boolean; canEnroll: boolean; onReassign: () => void; onReenroll: () => void }) {
  const enrolledCourse = new Map(o.enrollments.map((e) => [e.moodleCourseId, e.status]));
  const cohortLine = o.items.find((i) => i.cohort)?.cohort;
  return (
    <section className="card" aria-labelledby="h-items">
      <div className="od-card-h">
        {enrBadge ? <Badge spec={enrBadge} /> : <Badge spec={{ label: "Sin matrícula", tone: "neutral", progress: "incomplete" }} />}
        <h2 id="h-items" className="grow">
          Programas {cohortLine ? <span className="sub">· {cohortLine.sede.name}</span> : null}
        </h2>
      </div>
      {o.items.map((it) => {
        const img = it.product.images[0];
        const courses = it.courses.length ? it.courses.map((c) => c.course) : [];
        const installmentOf = (courseId: string) => o.installments.find((i) => i.courseId === courseId);
        return (
          <div key={it.id} className="li" data-testid="order-item">
            <span className="thumb">
              {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del catálogo */}
              {img ? <img src={img.url} alt={img.alt ?? ""} /> : <Icon name="product" />}
            </span>
            <div style={{ minWidth: 0 }}>
              <Link className="t" href={`/admin/products/${it.product.id}`}>{it.productTitle}</Link>
              <div className="v">
                <span className="tag">{it.modality === "ONLINE" ? "Online" : "Semipresencial"}</span>
                {it.sede ? <span className="tag">{it.sede.name}</span> : null}
                {it.planLabel ? <span className="tag">{it.planLabel}</span> : null}
                {it.choice ? <span className="tag">{it.choice.label}</span> : null}
              </div>
              {it.cohort ? (
                <div className="m">
                  {it.cohort.name} · {calDate(it.cohort.startDate)} – {calDate(it.cohort.endDate)}
                </div>
              ) : null}
              {it.reservation ? (
                <div className="seat" data-testid="seat-status">
                  <span className="muted">Cupo</span>
                  <Badge spec={{ label: RESERVATION_STATUS[it.reservation.status] ?? it.reservation.status, tone: it.reservation.status === "CONFIRMED" ? "success" : it.reservation.status === "HELD" ? "attention" : "neutral", progress: it.reservation.status === "CONFIRMED" ? "complete" : it.reservation.status === "HELD" ? "partial" : "incomplete" }} />
                  {it.reservation.status === "HELD" ? <span className="muted">hasta {inSentenceDate(it.reservation.expiresAt, o.now)}</span> : null}
                  {it.reservation.status === "RELEASED" && it.reservation.releasedReason ? <span className="muted">({RELEASE_REASON[it.reservation.releasedReason] ?? it.reservation.releasedReason.toLowerCase()})</span> : null}
                </div>
              ) : null}
              {it.certificates.length ? (
                <div className="seat">
                  <span className="muted">Certificado</span>
                  {it.certificates.map((c) => (
                    <Badge key={c.id} spec={{ label: `${c.code}${c.status === "REVOKED" ? " · revocado" : ""}`, tone: c.status === "ISSUED" ? "success" : "critical", progress: null }} />
                  ))}
                </div>
              ) : null}
            </div>
            <span className="qty">{usd(it.unitPriceCents)} × {it.quantity}</span>
            <span className="tot">
              {it.discountCents ? <s className="muted small" style={{ display: "block" }}>{usd(it.unitPriceCents * it.quantity)}</s> : null}
              {usd(it.totalCents)}
            </span>
              {courses.length ? (
                <ul className="courses span" aria-label={`Cursos de ${it.productTitle}`}>
                  {courses.map((c, i) => {
                    const es = c.moodleCourseId != null ? enrolledCourse.get(c.moodleCourseId) : undefined;
                    const ins = installmentOf(c.id);
                    const s = es ? ENROLLMENT_STATUS[es] : null;
                    return (
                      <li key={c.id}>
                        <span className="pos">{i + 1}</span>
                        <span className="nm">
                          {c.title} <span className="mid">· Moodle {c.moodleCourseId ?? "—"}</span>
                        </span>
                        {ins && ins.status !== "PAID" && ins.status !== "WAIVED" ? <span className="badge sm attention">Cuota {ins.sequence} pendiente</span> : null}
                        {s ? <span className={`badge sm ${s.tone}`}>{s.label}</span> : <span className="badge sm neutral">Sin matricular</span>}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
          </div>
        );
      })}
      {canReassign || canEnroll ? (
        <div className="card-actions">
          {canEnroll ? (
            <button type="button" className="btn" onClick={onReenroll}>
              Rematricular
            </button>
          ) : null}
          {canReassign ? (
            <button type="button" className="btn" onClick={onReassign}>
              Reasignar cohorte
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function EnrollmentList({ o }: { o: O }) {
  const [all, setAll] = useState(false);
  const n = o.enrollments.length;
  const counts = { ENROLLED: 0, FAILED: 0, UNENROLLED: 0, PENDING: 0 } as Record<string, number>;
  for (const e of o.enrollments) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const shown = n > 4 && !all ? o.enrollments.filter((e) => e.status !== "ENROLLED").slice(0, 4) : o.enrollments;
  return (
    <div data-testid="enrollments">
      {n > 4 ? (
        <p className="small" style={{ marginBottom: 6 }}>
          {counts.ENROLLED} de {n} cursos matriculados
          {counts.FAILED ? <> · <span style={{ color: "#8e0b21" }}>{counts.FAILED} con error</span></> : null}
          {counts.UNENROLLED ? <> · {counts.UNENROLLED} {counts.UNENROLLED === 1 ? "desmatriculado" : "desmatriculados"}</> : null}
          <span className="sr-only"> ({o.enrollments.map((e) => `${e.product.title}: ${ENROLLMENT_STATUS[e.status]?.label ?? e.status}`).join("; ")})</span>
        </p>
      ) : null}
      <ul className="enr-list">
        {shown.map((e) => {
          const s = ENROLLMENT_STATUS[e.status] ?? { label: e.status, tone: "neutral" as const };
          return (
            <li key={e.id}>
              <span className="nm">
                {e.product.title}
                <small>
                  Curso Moodle {e.moodleCourseId}
                  {e.enrolledAt ? ` · ${calDate(e.enrolledAt)}` : ""}
                  {e.completedAt ? " · completado" : ""}
                </small>
                {e.lastError && e.status !== "ENROLLED" ? <span className="field-err">{e.lastError}</span> : null}
              </span>
              <Badge spec={{ ...s, progress: null }} />
            </li>
          );
        })}
      </ul>
      {n > 4 ? (
        <button type="button" className="btn btn-plain" style={{ paddingLeft: 0 }} onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Ver menos" : `Ver los ${n} cursos`}
        </button>
      ) : null}
    </div>
  );
}
