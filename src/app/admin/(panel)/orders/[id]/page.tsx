// Ficha del pedido (panel): programas y cupo, pagos con su comprobante (aprobar / rechazar), reembolsos,
// matrículas de Moodle, correos enviados e historial completo (OrderEvent: quién, cuándo, antes/después).
import crypto from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/server/auth";
import { getAdminOrder } from "@/server/admin-orders";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { Icon } from "@/components/admin/Icon";
import { requireAdminPage } from "../../../_lib/session";
import { refundPaymentAction, verifyPaymentAction } from "../actions";
import { ACTOR, EMAIL_TEMPLATE, ENROLLMENT_STATUS, EVENT, ORDER_STATUS, PAYMENT_STATUS, RESERVATION_STATUS, dateTime, usd } from "../labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pedido" };

const METHOD: Record<string, string> = { PAYPAL: "PayPal", PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia bancaria", ZELLE: "Zelle", EFECTIVO: "Efectivo" };
const OK: Record<string, string> = {
  aprobado: "Pago aprobado. El pedido quedó pagado y se inició la matrícula.",
  rechazado: "Pago rechazado. Se avisó al cliente por correo.",
  reembolsado: "Reembolso completado.",
  "reembolso-parcial": "Reembolso parcial completado.",
};
const RELEASE_REASON: Record<string, string> = { EXPIRED: "venció", REJECTED: "pago rechazado", REFUNDED: "reembolso", CANCELLED: "cancelado", REASSIGNED: "reasignado" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const ves = (cents: number) => "Bs. " + (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: Date) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);

// Tipos explícitos (no PageProps<…>): los tipos de rutas generados dependen del build dir de cada carril.
type SP = Record<string, string | string[] | undefined>;
export default async function OrderDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const user = await requireAdminPage("orders.view", `/admin/orders/${id}`);
  const sp = await searchParams;
  let o: Awaited<ReturnType<typeof getAdminOrder>>;
  try {
    o = await getAdminOrder(services().deps, user, id);
  } catch (e) {
    if (isDomainError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const canVerify = can(user, "payments.verify");
  const canRefund = can(user, "payments.refund");
  const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: "neutral" as const };
  const ok = OK[one(sp.ok)];
  const error = one(sp.error);
  const events = [...o.events].reverse();

  return (
    <div className="adm-page">
      <div className="adm-ph">
        <Link href="/admin/orders" className="adm-back" aria-label="Pedidos"><Icon name="back" /></Link>
        <div className="grow">
          <h1>Pedido #{o.number}</h1>
          <span className={`badge ${st.tone}`} data-testid="order-status">{st.label}</span>
          <span className="meta">{dateTime(o.placedAt)} · {o.paymentMethod ? METHOD[o.paymentMethod] ?? o.paymentMethod : "Sin método"}</span>
        </div>
      </div>
      {ok ? <div className="banner success" role="status"><span>{ok}</span></div> : null}
      {error ? <div className="banner critical" role="alert"><span>{error}</span></div> : null}

      <div className="layout">
        <div className="col">
          <section className="card" aria-labelledby="h-items">
            <div className="card-h"><h2 id="h-items">Programas</h2></div>
            {o.items.map((it) => (
              <div key={it.id} className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", padding: "8px 0", gap: 12 }} data-testid="order-item">
                <div>
                  <div className="strong">{it.productTitle}</div>
                  <div className="muted small">
                    {it.modality === "ONLINE" ? "Online" : ["Semipresencial", it.sede?.name].filter(Boolean).join(" · ")}
                    {it.planLabel ? ` · ${it.planLabel}` : ""}
                  </div>
                  {it.cohort ? (
                    <div className="muted small">
                      {it.cohort.name} · {day(it.cohort.startDate)} – {day(it.cohort.endDate)}
                    </div>
                  ) : null}
                  {it.reservation ? (
                    <div className="small" data-testid="seat-status">
                      Cupo: <span className={`badge sm ${it.reservation.status === "CONFIRMED" ? "success" : it.reservation.status === "HELD" ? "attention" : "neutral"}`}>{RESERVATION_STATUS[it.reservation.status]}</span>
                      {it.reservation.status === "HELD" ? <span className="muted"> hasta {dateTime(it.reservation.expiresAt)}</span> : null}
                      {it.reservation.status === "RELEASED" && it.reservation.releasedReason ? <span className="muted"> ({RELEASE_REASON[it.reservation.releasedReason] ?? it.reservation.releasedReason.toLowerCase()})</span> : null}
                    </div>
                  ) : null}
                </div>
                <div className="mono">{usd(it.totalCents)}</div>
              </div>
            ))}
          </section>

          <section className="card" aria-labelledby="h-pay">
            <div className="card-h"><h2 id="h-pay">Pagos</h2></div>
            {o.payments.length === 0 ? <p className="muted">Aún no hay pagos registrados.</p> : null}
            {o.payments.map((p) => {
              const ps = PAYMENT_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
              const refundable = p.amountUsdCents - p.refundedCents;
              const proofUrl = `/admin/orders/${o.id}/comprobante/${p.id}`;
              return (
                <article key={p.id} className="card-sec" style={{ paddingLeft: 0, paddingRight: 0 }} data-testid="payment" data-payment-id={p.id} aria-label={`Pago ${METHOD[p.method] ?? p.method}`}>
                  <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="strong">{METHOD[p.method] ?? p.method}</span>
                      <span className={`badge ${ps.tone}`} data-testid="payment-status">{ps.label}</span>
                    </div>
                    <span className="mono strong">
                      {p.currency === "VES" ? `${ves(p.amountCents)} ≈ ` : ""}
                      {usd(p.amountUsdCents)}
                    </span>
                  </div>
                  <dl className="kv small" style={{ marginTop: 8 }}>
                    {p.reference ? (<><dt>Referencia</dt><dd className="mono" data-testid="payment-reference">{p.reference}</dd></>) : null}
                    {p.bank ? (<><dt>Banco de origen</dt><dd>{p.bank}</dd></>) : null}
                    {p.currency === "VES" && p.exchangeRate ? (<><dt>Tasa aplicada</dt><dd>Bs. {Number(p.exchangeRate).toLocaleString("es-VE")} por USD</dd></>) : null}
                    {p.payerCedula ? (<><dt>Cédula del titular</dt><dd>{p.payerCedula}</dd></>) : null}
                    {p.paidAt ? (<><dt>Fecha del pago</dt><dd>{day(p.paidAt)}</dd></>) : null}
                    {p.paypalCaptureId ? (<><dt>Captura PayPal</dt><dd className="mono">{p.paypalCaptureId}</dd></>) : null}
                    {p.verifiedAt ? (<><dt>{p.status === "REJECTED" ? "Rechazado por" : "Verificado por"}</dt><dd>{p.verifiedBy?.name ?? "—"} · {dateTime(p.verifiedAt)}</dd></>) : null}
                    {p.rejectionReason ? (<><dt>Motivo del rechazo</dt><dd>{p.rejectionReason}</dd></>) : null}
                    {p.refundedCents ? (<><dt>Reembolsado</dt><dd className="mono">{usd(p.refundedCents)}</dd></>) : null}
                  </dl>
                  {p.hasProof ? (
                    <figure style={{ margin: "12px 0 0" }} data-testid="proof">
                      <figcaption className="small muted" style={{ marginBottom: 6 }}>
                        Comprobante · <a href={proofUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Abrir en otra pestaña</a>
                      </figcaption>
                      {p.proofKind === "image" ? (
                        <a href={proofUrl} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element -- archivo privado servido por el panel */}
                          <img src={proofUrl} alt={`Comprobante del pago ${p.reference ?? ""}`.trim()} style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 8, border: "1px solid var(--p-border)" }} />
                        </a>
                      ) : (
                        <a className="btn btn-gray" href={proofUrl} target="_blank" rel="noreferrer">Ver comprobante (PDF)</a>
                      )}
                    </figure>
                  ) : p.method !== "PAYPAL" ? (
                    <p className="small muted" style={{ marginTop: 8 }}>Sin comprobante adjunto.</p>
                  ) : null}

                  {p.status === "AWAITING_VERIFICATION" && canVerify ? (
                    <div className="grid2" style={{ marginTop: 12, alignItems: "start" }}>
                      <form action={verifyPaymentAction.bind(null, o.id, p.id, "approve")} aria-label="Aprobar pago">
                        <label className="field">
                          <span>Nota (opcional)</span>
                          <input className="inp" name="note" placeholder="p. ej. verificado en el banco" />
                        </label>
                        <button className="btn btn-primary" type="submit">Aprobar pago</button>
                      </form>
                      <form action={verifyPaymentAction.bind(null, o.id, p.id, "reject")} aria-label="Rechazar pago">
                        <label className="field">
                          <span>Motivo del rechazo</span>
                          <input className="inp" name="note" required placeholder="Se le enviará al cliente" />
                        </label>
                        <button className="btn btn-critical" type="submit">Rechazar pago</button>
                      </form>
                    </div>
                  ) : null}

                  {p.refunds.length ? (
                    <ul className="small" style={{ margin: "12px 0 0", paddingLeft: 18 }} data-testid="refunds">
                      {p.refunds.map((r) => (
                        <li key={r.id}>
                          Reembolso {usd(r.amountCents)} · {r.status === "COMPLETED" ? "completado" : r.status === "PENDING" ? "en curso" : "fallido"}
                          {r.manual ? " (registrado a mano)" : r.providerRefundId ? ` · PayPal ${r.providerRefundId}` : ""}
                          {r.createdBy ? ` · ${r.createdBy.name}` : ""} · {dateTime(r.createdAt)}
                          {r.reason ? ` · «${r.reason}»` : ""}
                          {r.error ? <span className="field-err">{r.error}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {(p.status === "COMPLETED" || p.status === "PARTIALLY_REFUNDED") && refundable > 0 && canRefund ? (
                    <details style={{ marginTop: 12 }} data-testid="refund">
                      <summary className="btn btn-gray" style={{ display: "inline-flex" }}>Reembolsar</summary>
                      <form action={refundPaymentAction.bind(null, o.id, p.id)} aria-label="Reembolsar pago" style={{ marginTop: 12 }}>
                        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                        {p.method !== "PAYPAL" ? <input type="hidden" name="manual" value="on" /> : null}
                        <p className="small muted" style={{ marginBottom: 8 }}>
                          {p.method === "PAYPAL" ? "Se devuelve el dinero por PayPal al comprador." : "Registra un reembolso hecho fuera del sistema (transferencia, efectivo…)."} Reembolsable: {usd(refundable)}.
                        </p>
                        <div className="grid2">
                          <label className="field">
                            <span>Monto (USD)</span>
                            <input className="inp" name="amount" inputMode="decimal" defaultValue={(refundable / 100).toFixed(2)} />
                          </label>
                          <label className="field">
                            <span>Motivo</span>
                            <input className="inp" name="reason" placeholder="Visible para el cliente" />
                          </label>
                        </div>
                        <label className="check">
                          <input type="checkbox" name="unenroll" defaultChecked />
                          <span className="t">Desmatricular de Moodle<span className="d">Quita el acceso a los cursos de este pedido.</span></span>
                        </label>
                        <label className="check">
                          <input type="checkbox" name="releaseSeat" defaultChecked />
                          <span className="t">Liberar el cupo de la cohorte<span className="d">El cupo queda disponible para otro médico.</span></span>
                        </label>
                        <label className="check">
                          <input type="checkbox" name="confirmRepeat" />
                          <span className="t">Es otro reembolso del mismo monto (no un doble envío)</span>
                        </label>
                        <button className="btn btn-critical" type="submit" style={{ marginTop: 12 }}>Reembolsar</button>
                      </form>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </section>

          <section className="card" aria-labelledby="h-tl">
            <div className="card-h"><h2 id="h-tl">Historial</h2></div>
            <ol className="tl" data-testid="timeline">
              {events.map((e) => (
                <li key={e.id} data-event={e.type}>
                  <div className="small">
                    <span className="strong">{EVENT[e.type] ?? e.type}</span>
                    {e.fromStatus || e.toStatus ? (
                      <span> · {ORDER_STATUS[e.fromStatus ?? ""]?.label ?? e.fromStatus ?? "—"} → {ORDER_STATUS[e.toStatus ?? ""]?.label ?? e.toStatus}</span>
                    ) : null}
                  </div>
                  {e.note ? <div className="small">{e.note}</div> : null}
                  <div className="small muted">
                    {e.actorType === "ADMIN" && e.actor ? `${e.actor.name} (${e.actor.email})` : ACTOR[e.actorType] ?? e.actorType} · {dateTime(e.createdAt)}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="col">
          <section className="card" aria-labelledby="h-cust">
            <div className="card-h"><h2 id="h-cust">Cliente</h2></div>
            <div style={{ overflowWrap: "anywhere" }}>
            <div className="strong">{o.customer.firstName} {o.customer.lastName}</div>
            <div className="small">{o.customer.email}</div>
            {o.customer.phone ? <div className="small">{o.customer.phone}</div> : null}
            {o.customer.cedula ? <div className="small muted">Cédula {o.customer.cedula}</div> : null}
            {o.customer.moodleUsername ? <div className="small muted">Moodle: {o.customer.moodleUsername}</div> : null}
            </div>
          </section>

          <section className="card" aria-labelledby="h-sum">
            <div className="card-h"><h2 id="h-sum">Resumen</h2></div>
            <dl className="kv">
              <dt>Total</dt><dd className="mono">{usd(o.totalCents)}</dd>
              <dt>Pagado</dt><dd className="mono" data-testid="paid">{usd(o.amountPaidCents)}</dd>
              <dt>Saldo</dt><dd className="mono">{usd(Math.max(0, o.balanceCents))}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="h-enr">
            <div className="card-h"><h2 id="h-enr">Matrícula en Moodle</h2></div>
            {o.enrollments.length === 0 ? <p className="small muted">Sin matrículas.</p> : null}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="enrollments">
              {o.enrollments.map((e) => (
                <li key={e.id} className="small" style={{ padding: "4px 0" }}>
                  {e.product.title} <span className="muted">(curso {e.moodleCourseId})</span>{" "}
                  <span className={`badge sm ${e.status === "ENROLLED" ? "success" : e.status === "FAILED" ? "critical" : "neutral"}`}>{ENROLLMENT_STATUS[e.status] ?? e.status}</span>
                  {e.lastError && e.status !== "ENROLLED" ? <div className="field-err">{e.lastError}</div> : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="card" aria-labelledby="h-mail">
            <div className="card-h"><h2 id="h-mail">Correos al cliente</h2></div>
            {o.emails.length === 0 ? <p className="small muted">Sin correos.</p> : null}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="emails">
              {o.emails.map((m) => (
                <li key={m.id} className="small" style={{ padding: "4px 0" }} data-template={m.template}>
                  <span className="strong">{EMAIL_TEMPLATE[m.template] ?? m.template}</span>{" "}
                  <span className={`badge sm ${m.status === "SENT" ? "success" : m.status === "FAILED" ? "critical" : "neutral"}`}>{m.status === "SENT" ? "Enviado" : m.status === "FAILED" ? "Falló" : "En cola"}</span>
                  <div className="muted">{dateTime(m.sentAt ?? m.createdAt)}</div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
