"use client";
// Tarjeta «Pago» de la ficha (como la de Shopify): resumen (subtotal, descuento del plan, ajustes, total,
// pagado, reembolsado, saldo), cuotas, y cada transacción con su detalle. Un pago manual por verificar se
// abre como panel de verificación (comprobante + comprobaciones + aprobar / rechazar); uno confirmado tiene
// su botón «Reembolsar» (diálogo).
import { useState } from "react";
import { Icon } from "../Icon";
import { sendInstallmentReminderAction, verifyPayment, waiveInstallmentAction } from "@/app/admin/(panel)/orders/actions";
import type { OrderDetail } from "@/server/admin-order-views";
import { Badge, MethodIcon, Spinner } from "./bits";
import { useOrder } from "./context";
import { INSTALLMENT_STATUS, METHOD, PAYMENT_STATUS, calDate, dayLabel, listDate, paymentBadge, shortDate, time, usd, ves } from "./format";
import { RefundDialog } from "./RefundDialog";
import { Lightbox, TextModal } from "./modals";

type O = OrderDetail;
type P = O["payments"][number];

const REJECT_REASONS = [
  "El monto recibido no coincide con el del pedido.",
  "No encontramos la referencia en el estado de cuenta.",
  "El comprobante no se lee bien. Envíalo de nuevo, por favor.",
  "El pago se hizo a una cuenta que no es de CEIUM.",
];

/** Monto que se espera de este pago: el primer pago del pedido o la cuota que imputa. */
function expectedCents(o: O, p: P): number | null {
  if (p.installment) {
    const ins = o.installments.find((i) => i.sequence === p.installment!.sequence);
    return ins ? ins.amountCents - ins.paidCents : null;
  }
  if (["PENDING_PAYMENT", "AWAITING_VERIFICATION", "REJECTED", "EXPIRED"].includes(o.status)) return o.dueNowCents - o.amountPaidCents;
  return o.balanceCents > 0 ? o.balanceCents : null;
}

function VerifyPanel({ o, p }: { o: O; p: P }) {
  const { run, busy, perms } = useOrder();
  const [mode, setMode] = useState<"idle" | "reject">("idle");
  const [reason, setReason] = useState("");
  const [zoom, setZoom] = useState(false);
  const proofUrl = `/admin/orders/${o.id}/comprobante/${p.id}`;
  const expected = expectedCents(o, p);
  const diff = expected != null ? p.amountUsdCents - expected : 0;
  // Solo se tolera pagar de más (redondeos de la tasa): el servidor exige el monto completo para dar el pedido por
  // pagado, así que cualquier faltante se muestra como faltante.
  const tol = Math.max(100, Math.round((expected ?? 0) * 0.01));
  const hold = o.items.map((i) => i.reservation).find((r) => r?.status === "HELD");
  const hoursLeft = hold ? Math.round((new Date(hold.expiresAt).getTime() - new Date(o.now).getTime()) / 3_600_000) : null;
  const checks: { tone: "ok" | "warn" | "bad"; text: React.ReactNode }[] = [];
  if (expected != null) {
    if (diff >= 0 && diff <= tol) checks.push({ tone: "ok", text: <>El monto cubre lo que se espera de este pago ({usd(expected)}).</> });
    else if (diff < 0) checks.push({ tone: "bad", text: <>Faltan <b>{usd(-diff)}</b>: se esperaba {usd(expected)}.</> });
    else checks.push({ tone: "warn", text: <>Pagó <b>{usd(diff)}</b> de más (se esperaba {usd(expected)}).</> });
  }
  if (p.reference) {
    if (p.duplicates.length)
      checks.push({
        tone: "bad",
        text: (
          <>
            La referencia también aparece en {p.duplicates.map((x, i) => (
              <span key={x.orderId}>
                {i ? ", " : ""}
                <a className="lk" href={`/admin/orders/${x.orderId}`}>#{x.number}</a>
              </span>
            ))}
            .
          </>
        ),
      });
    else checks.push({ tone: "ok", text: <>La referencia no se ha usado en otro pedido.</> });
  }
  if (p.payerCedula && o.customer.cedula && p.payerCedula.replace(/\W/g, "").toUpperCase() !== o.customer.cedula.replace(/\W/g, "").toUpperCase())
    checks.push({ tone: "warn", text: <>El titular ({p.payerCedula}) no es el médico ({o.customer.cedula}): confirma que es un pago de un tercero.</> });
  if (hoursLeft != null) checks.push({ tone: hoursLeft < 12 ? "warn" : "ok", text: <>El cupo está reservado {hoursLeft > 0 ? `${hoursLeft} h más` : "por muy poco tiempo"} (hasta el {listDate(hold!.expiresAt, o.now).replace(/^Hoy/, "hoy").replace(/^Ayer/, "ayer")}).</> });

  return (
    <div className="vf">
      <div data-testid="proof">
        {p.hasProof && p.proofKind === "image" ? (
          <button type="button" className="vf-proof" onClick={() => setZoom(true)} aria-label="Ampliar comprobante">
            {/* eslint-disable-next-line @next/next/no-img-element -- archivo privado servido por el panel */}
            <img src={proofUrl} alt={`Comprobante del pago ${p.reference ?? ""}`.trim()} />
            <span className="zoom">
              <Icon name="search" size={14} /> Ampliar
            </span>
          </button>
        ) : p.hasProof ? (
          <a className="vf-proof pdf" href={proofUrl} target="_blank" rel="noreferrer">
            <span style={{ display: "grid", placeItems: "center", gap: 6, color: "#616161" }}>
              <Icon name="external" size={28} />
              Ver comprobante (PDF)
            </span>
          </a>
        ) : (
          <div className="vf-noproof">
            <div>
              <Icon name="image" size={28} />
              <div>Sin comprobante adjunto</div>
            </div>
          </div>
        )}
        {p.hasProof ? (
          <p className="small" style={{ marginTop: 6, textAlign: "center" }}>
            <a className="lk" href={proofUrl} target="_blank" rel="noreferrer">Abrir en otra pestaña</a>
          </p>
        ) : null}
      </div>
      <div>
        <div className="vf-amount">
          <span className="big">{p.currency === "VES" ? ves(p.amountCents) : usd(p.amountCents)}</span>
          {p.currency === "VES" ? (
            <span className="eq">
              ≈ {usd(p.amountUsdCents)} · tasa Bs. {p.exchangeRate?.toLocaleString("es-VE", { minimumFractionDigits: 2 })} por USD
            </span>
          ) : null}
        </div>
        <ul className="vf-checks" aria-label="Comprobaciones">
          {checks.map((c, i) => (
            <li key={i} className={c.tone}>
              <Icon name={c.tone === "ok" ? "check" : "alert"} size={18} />
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
        <dl className="tx-kv">
          {p.reference ? (<><dt>Referencia</dt><dd className="mono" data-testid="payment-reference">{p.reference}</dd></>) : null}
          {p.bank ? (<><dt>Banco de origen</dt><dd>{p.bank}</dd></>) : null}
          {p.payerCedula ? (<><dt>Cédula del titular</dt><dd>{p.payerCedula}</dd></>) : null}
          {p.payerName ? (<><dt>Titular</dt><dd>{p.payerName}</dd></>) : null}
          {p.payerPhone ? (<><dt>Teléfono del titular</dt><dd>{p.payerPhone}</dd></>) : null}
          {p.paidAt ? (<><dt>Fecha del pago</dt><dd>{shortDate(p.paidAt)}</dd></>) : null}
          <dt>Registrado</dt>
          <dd>{listDate(p.createdAt, o.now)}</dd>
        </dl>

        {perms.verify ? (
          mode === "reject" ? (
            <form
              className="vf-reject"
              aria-label="Rechazar pago"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run(`verify:${p.id}`, () => verifyPayment(o.id, p.id, "reject", reason));
                if (r.ok) setMode("idle");
              }}
            >
              <div className="reasons" aria-label="Motivos frecuentes">
                {REJECT_REASONS.map((t) => (
                  <button key={t} type="button" onClick={() => setReason(t)}>
                    {t.replace(/\.$/, "").replace(/\. Envíalo.*$/, "")}
                  </button>
                ))}
              </div>
              <label className="field">
                <span>Motivo del rechazo</span>
                <textarea className="inp" name="note" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Se le enviará al cliente por correo" />
              </label>
              <div className="vf-acts">
                <button type="button" className="btn" onClick={() => setMode("idle")}>Cancelar</button>
                <button type="submit" className="btn btn-critical" disabled={busy === `verify:${p.id}`}>
                  {busy === `verify:${p.id}` ? <Spinner /> : null}
                  Rechazar pago
                </button>
              </div>
            </form>
          ) : (
            <div className="vf-acts">
              <button type="button" className="btn" onClick={() => setMode("reject")} disabled={!!busy}>
                Rechazar pago
              </button>
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => run(`verify:${p.id}`, () => verifyPayment(o.id, p.id, "approve", ""))}>
                {busy === `verify:${p.id}` ? <Spinner /> : <Icon name="check" size={16} />}
                Aprobar pago
              </button>
            </div>
          )
        ) : (
          <p className="small muted" style={{ marginTop: 12 }}>Tu rol no puede verificar pagos.</p>
        )}
      </div>
      {zoom ? <Lightbox src={proofUrl} alt={`Comprobante del pago ${p.reference ?? ""}`} onClose={() => setZoom(false)} /> : null}
    </div>
  );
}

function Transaction({ o, p }: { o: O; p: P }) {
  const { perms } = useOrder();
  const ps = PAYMENT_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
  const awaiting = p.status === "AWAITING_VERIFICATION";
  const [open, setOpen] = useState(awaiting || p.status === "REJECTED");
  const sub: string[] = [];
  if (p.reference) sub.push(`Ref. ${p.reference}`);
  if (p.bank) sub.push(p.bank);
  if (p.paypalCaptureId) sub.push(`Captura ${p.paypalCaptureId}`);
  if (p.installment && o.installments.length > 1) sub.push(`Cuota ${p.installment.sequence}`);
  sub.push(`${dayLabel(p.createdAt, o.now)} a las ${time(p.createdAt)}`);
  return (
    <article className={`tx${awaiting ? " attn" : ""}`} data-testid="payment" data-payment-id={p.id} aria-label={`Pago ${METHOD[p.method] ?? p.method}`}>
      <div className="tx-row">
        <MethodIcon method={p.method} />
        <div className="main">
          <div className="t">
            {METHOD[p.method] ?? p.method}
            <Badge spec={{ ...ps, progress: null }} testId="payment-status" />
          </div>
          <div className="s">{sub.join(" · ")}</div>
          {p.verifiedAt ? (
            <div className="s">
              {p.status === "REJECTED" ? "Rechazado por " : "Verificado por "}
              {p.verifiedBy?.name ?? "—"} · {listDate(p.verifiedAt, o.now)}
            </div>
          ) : null}
          {p.rejectionReason ? <div className="s" style={{ color: "#8e0b21" }}>Motivo: {p.rejectionReason}</div> : null}
        </div>
        <div className="amt" hidden={awaiting}>
          {p.currency === "VES" ? ves(p.amountCents) : usd(p.amountUsdCents)}
          {p.currency === "VES" ? <small>≈ {usd(p.amountUsdCents)}</small> : null}
          {p.refundedCents ? <small>Reembolsado {usd(p.refundedCents)}</small> : null}
        </div>
        {!awaiting ? (
          <button type="button" className="tog" aria-expanded={open} aria-label={open ? "Ocultar detalle del pago" : "Ver detalle del pago"} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? "chevronUp" : "chevronDown"} size={18} />
          </button>
        ) : null}
      </div>
      {awaiting ? <VerifyPanel o={o} p={p} /> : null}
      {!awaiting && open ? (
        <div className="tx-body">
          <dl className="tx-kv">
            <dt>Monto</dt>
            <dd className="mono">
              {p.currency === "VES" ? `${ves(p.amountCents)} ≈ ${usd(p.amountUsdCents)}` : usd(p.amountUsdCents)}
            </dd>
            {p.currency === "VES" && p.exchangeRate ? (<><dt>Tasa aplicada</dt><dd>Bs. {p.exchangeRate.toLocaleString("es-VE", { minimumFractionDigits: 2 })} por USD</dd></>) : null}
            {p.reference ? (<><dt>Referencia</dt><dd className="mono">{p.reference}</dd></>) : null}
            {p.bank ? (<><dt>Banco de origen</dt><dd>{p.bank}</dd></>) : null}
            {p.payerCedula ? (<><dt>Cédula del titular</dt><dd>{p.payerCedula}</dd></>) : null}
            {p.paidAt ? (<><dt>Fecha del pago</dt><dd>{shortDate(p.paidAt)}</dd></>) : null}
            {p.paypalOrderId ? (<><dt>Orden PayPal</dt><dd className="mono">{p.paypalOrderId}</dd></>) : null}
            {p.paypalCaptureId ? (<><dt>Captura PayPal</dt><dd className="mono">{p.paypalCaptureId}</dd></>) : null}
            {p.providerStatus ? (<><dt>Estado en PayPal</dt><dd>{p.providerStatus}</dd></>) : null}
            {p.hasProof ? (<><dt>Comprobante</dt><dd><a className="lk" href={`/admin/orders/${o.id}/comprobante/${p.id}`} target="_blank" rel="noreferrer">Ver comprobante</a></dd></>) : null}
          </dl>
        </div>
      ) : null}
      {p.refunds.length ? (
        <div className="tx-body">
          <ul className="tx-refunds" data-testid="refunds">
            {p.refunds.map((r) => (
              <li key={r.id}>
                <Icon name="back" size={16} />
                <span className="r">
                  Reembolso {r.status === "COMPLETED" ? "completado" : r.status === "PENDING" ? "en curso" : "fallido"}
                  {r.manual ? " · registrado a mano" : r.providerRefundId ? ` · PayPal ${r.providerRefundId}` : ""}
                  {r.createdBy ? ` · ${r.createdBy.name}` : ""} · {listDate(r.createdAt, o.now)}
                  {r.reason ? <> · «{r.reason}»</> : null}
                  {r.error && r.status !== "COMPLETED" ? <span className="field-err">{r.error}</span> : null}
                </span>
                <span className="amt">−{usd(r.amountCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.refundableCents > 0 && perms.refund ? (
        <div className="tx-body" style={{ paddingTop: 0 }}>
          <div className="tx-acts">
            <RefundDialog o={o} p={p} />
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function PaymentCard({ o, onAdjust }: { o: O; onAdjust: () => void }) {
  const { perms, run, busy } = useOrder();
  const [waive, setWaive] = useState<O["installments"][number] | null>(null);
  const refunded = o.payments.reduce((a, p) => a + p.refundedCents, 0);
  const badge = paymentBadge({ ...o, refundedCents: refunded });
  const adjustments = o.adjustments.reduce((a, x) => a + x.amountCents, 0);
  const grossPaid = o.payments.filter((p) => ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(p.status)).reduce((a, p) => a + p.amountUsdCents, 0);
  const planLabel = o.items.map((i) => i.planLabel).filter(Boolean)[0];
  const nItems = o.items.reduce((a, i) => a + i.quantity, 0);
  const canAdjust = perms.adjust && ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"].includes(o.status);
  const showInstallments = o.installments.length > 1;
  // Recordatorio con enlace de pago: solo de la siguiente cuota por pagar y con el primer pago ya confirmado.
  const nextOpen = o.installments.find((i) => i.status !== "PAID" && i.status !== "WAIVED");
  const canRemind = perms.resend && ["PAID", "PARTIALLY_PAID", "ENROLLED"].includes(o.status) && o.balanceCents > 0 && !!nextOpen;
  const actionsCol = canAdjust || canRemind;

  return (
    <section className="card" aria-labelledby="h-pay">
      <div className="od-card-h">
        <Badge spec={badge} />
        <h2 id="h-pay">Pago</h2>
      </div>
      <div className="ps-box">
        <div className="ps">
          <span className="k">Subtotal</span>
          <span className="d">{nItems} {nItems === 1 ? "programa" : "programas"}</span>
          <span className="a">{usd(o.subtotalCents)}</span>
          {o.discountCents ? (
            <>
              <span className="k">Descuento</span>
              <span className="d">{planLabel ?? "Plan de pago"}</span>
              <span className="a">−{usd(o.discountCents)}</span>
            </>
          ) : null}
          {o.subtotalCents - o.discountCents !== o.totalCents && !o.discountCents ? (
            <>
              <span className="k">Plan</span>
              <span className="d">{planLabel}</span>
              <span className="a">{usd(o.totalCents - o.subtotalCents)}</span>
            </>
          ) : null}
          {adjustments ? (
            <>
              <span className="k">Ajustes</span>
              <span className="d">{o.adjustments.length} {o.adjustments.length === 1 ? "ajuste" : "ajustes"} del panel</span>
              <span className="a">{usd(adjustments)}</span>
            </>
          ) : null}
          <span className="k b">Total</span>
          <span className="d" />
          <span className="a b">{usd(o.totalCents + adjustments)}</span>
        </div>
      </div>
      <div className="ps-box">
        <div className="ps">
          <span className="k">Pagado por el cliente</span>
          <span className="d" />
          <span className="a">{usd(grossPaid)}</span>
          {refunded ? (
            <>
              <span className="k">Reembolsado</span>
              <span className="d" />
              <span className="a">−{usd(refunded)}</span>
            </>
          ) : null}
          {refunded ? (
            <>
              <span className="hr" />
              <span className="k">Pago neto</span>
              <span className="d" />
              <span className="a" data-testid="paid">{usd(o.amountPaidCents)}</span>
            </>
          ) : null}
          <span className="k b">Saldo pendiente</span>
          <span className="d">{o.balanceCents > 0 && o.installments.length > 1 ? `${o.installments.filter((i) => i.status !== "PAID" && i.status !== "WAIVED").length} cuota(s) por pagar` : ""}</span>
          <span className="a b" data-testid="balance">{usd(Math.max(0, o.balanceCents))}</span>
        </div>
      </div>

      {showInstallments ? (
        <div style={{ marginTop: 16 }}>
          <h3 className="tx-h">Cuotas</h3>
          <div style={{ overflowX: "auto" }}>
            <table className="inst" data-testid="installments">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{o.items.some((i) => i.planKind === "MONTHLY") ? "Curso que habilita" : "Concepto"}</th>
                  <th>Vence</th>
                  <th>Estado</th>
                  <th className="num">Monto</th>
                  {actionsCol ? <th><span className="sr-only">Acciones</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {o.installments.map((i) => {
                  const st = INSTALLMENT_STATUS[i.status] ?? { label: i.status, tone: "neutral" as const };
                  const open = i.status !== "PAID" && i.status !== "WAIVED";
                  return (
                    <tr key={i.id}>
                      <td>{i.sequence}</td>
                      <td className="c">{i.course?.title ?? (i.sequence === 1 ? "Primer pago" : "Saldo")}</td>
                      <td className="dt">{i.dueDate ? calDate(i.dueDate) : "—"}</td>
                      <td><Badge spec={{ ...st, progress: null }} /></td>
                      <td className="num">
                        {i.paidCents > 0 && i.paidCents < i.amountCents ? <span className="muted">{usd(i.paidCents)} de </span> : null}
                        {usd(i.amountCents)}
                      </td>
                      {actionsCol ? (
                        <td className="num acts">
                          {canRemind && nextOpen?.id === i.id ? (
                            <button
                              type="button"
                              className="btn btn-plain"
                              aria-label={`Enviar recordatorio de la cuota ${i.sequence}`}
                              title="Envía al médico el correo con el enlace de pago de esta cuota"
                              disabled={busy === `remind:${i.id}`}
                              onClick={() => run(`remind:${i.id}`, () => sendInstallmentReminderAction(o.id, i.id))}
                            >
                              {busy === `remind:${i.id}` ? <Spinner /> : "Recordar"}
                            </button>
                          ) : null}
                          {canAdjust && open ? (
                            <button type="button" className="btn btn-plain" onClick={() => setWaive(i)}>
                              Condonar
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="tx-list">
        <h3 className="tx-h">Transacciones</h3>
        {o.payments.length === 0 ? <p className="muted small">Aún no hay pagos registrados.</p> : null}
        {o.payments.map((p) => (
          <Transaction key={p.id} o={o} p={p} />
        ))}
      </div>

      {o.adjustments.length ? (
        <div style={{ marginTop: 12 }}>
          <h3 className="tx-h">Ajustes de saldo</h3>
          <ul className="tx-refunds" style={{ marginTop: 0 }}>
            {o.adjustments.map((a) => (
              <li key={a.id}>
                <Icon name={a.amountCents < 0 ? "check" : "plus"} size={16} />
                <span className="r">
                  {a.amountCents < 0 ? "Condonación" : "Cargo"} · «{a.reason}» {a.createdBy ? `· ${a.createdBy.name}` : ""} · {listDate(a.createdAt, o.now)}
                </span>
                <span className="amt">{usd(a.amountCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canAdjust ? (
        <div className="card-actions">
          <button type="button" className="btn" onClick={onAdjust}>
            Ajustar saldo
          </button>
        </div>
      ) : null}

      {waive ? (
        <TextModal
          title={`Condonar la cuota ${waive.sequence}`}
          label="Motivo"
          help={`Se condonan ${usd(waive.amountCents - waive.paidCents)}${waive.course ? ` y se habilita «${waive.course.title}» en Moodle` : ""}. Queda en el historial del pedido.`}
          confirm="Condonar cuota"
          busy={busy === "waive"}
          onClose={() => setWaive(null)}
          onSubmit={async (reason) => {
            const r = await run("waive", () => waiveInstallmentAction(o.id, waive.id, reason));
            if (r.ok) setWaive(null);
          }}
        />
      ) : null}
    </section>
  );
}
