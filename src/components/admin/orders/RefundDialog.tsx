"use client";
// Diálogo «Reembolsar pago» (réplica de la pantalla de reembolso de Shopify en un modal): programas del pedido,
// qué pasa con la inscripción (desmatricular, liberar cupo, conservar certificado), motivo, y a la derecha el
// resumen con lo disponible, el monto (total / mitad / otro) y a dónde vuelve el dinero. PayPal se reembolsa por
// API; los métodos manuales se registran (el dinero se devuelve fuera del sistema).
// Es un <details> dentro de la transacción: «Reembolsar» (summary) lo abre como modal; el botón de la cabecera
// de la ficha lo abre por su data-refund-for.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { refundPayment } from "@/app/admin/(panel)/orders/actions";
import type { OrderDetail } from "@/server/admin-order-views";
import { MethodIcon, Spinner } from "./bits";
import { useOrder } from "./context";
import { METHOD, usd } from "./format";

type O = OrderDetail;
type P = O["payments"][number];

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random()}`);
const money = (cents: number) => (cents / 100).toFixed(2);
function toCents(s: string): number {
  let t = s.trim().replace(/[\s$]/g, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function RefundDialog({ o, p }: { o: O; p: P }) {
  const { run, busy } = useOrder();
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const available = p.refundableCents;
  const [amount, setAmount] = useState(money(available));
  const [reason, setReason] = useState("");
  // Por defecto (como el servicio): desmatricular y liberar el cupo solo si el reembolso deja el pedido en cero.
  const [unenrollSet, setUnenroll] = useState<boolean | null>(null);
  const [releaseSet, setReleaseSeat] = useState<boolean | null>(null);
  const [keepCert, setKeepCert] = useState(false);
  const [confirmRepeat, setConfirmRepeat] = useState(false);
  const [needsRepeat, setNeedsRepeat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const cents = toCents(amount);
  const valid = Number.isInteger(cents) && cents > 0 && cents <= available;
  const full = valid && cents === available;
  const paypal = p.method === "PAYPAL";
  const hasSeat = o.items.some((i) => i.reservation && i.reservation.status !== "RELEASED");
  const certs = o.items.flatMap((i) => i.certificates).filter((c) => c.status === "ISSUED");
  const enrolled = o.enrollments.some((e) => e.status === "ENROLLED");
  const otherPaid = o.payments.filter((x) => x.id !== p.id).reduce((a, x) => a + x.refundableCents, 0);
  const orderWillBeRefunded = full && otherPaid === 0;
  const unenroll = unenrollSet ?? orderWillBeRefunded;
  const releaseSeat = releaseSet ?? orderWillBeRefunded;
  const k = `refund:${p.id}`;

  const dlg = useRef<HTMLDialogElement>(null);
  const close = () => {
    dlg.current?.close();
    if (ref.current) ref.current.open = false;
    setOpen(false);
  };
  // Modal nativo (capa superior del navegador: tapa la barra superior y la navegación), aunque el diálogo viva
  // dentro de la transacción en el DOM.
  useEffect(() => {
    if (open && dlg.current && !dlg.current.open) dlg.current.showModal();
  }, [open]);
  // Al abrir: formulario limpio y una clave de idempotencia nueva (dos clics en «Reembolsar» = un reembolso).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAmount(money(available));
      setError(null);
      setNeedsRepeat(false);
      setConfirmRepeat(false);
      setUnenroll(null);
      setReleaseSeat(null);
    }
  }

  return (
    <details ref={ref} className="rf-details" data-testid="refund" data-refund-for={p.id} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="btn">Reembolsar</summary>
      {open ? (
        <dialog
          ref={dlg}
          className="rf-dialog"
          aria-label="Reembolsar pago"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <form
            className="modal lg"
            aria-label="Reembolsar pago"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!valid) return setError(`El monto debe estar entre $0.01 y ${usd(available)}.`);
              setError(null);
              const r = await run(k, () => refundPayment(o.id, { paymentId: p.id, amount: money(cents), reason, unenroll, releaseSeat: hasSeat ? releaseSeat : false, keepCertificate: keepCert, confirmRepeat, idempotencyKey: key }));
              if (r.ok) {
                setKey(newKey());
                setReason("");
                close();
              } else if (r.needsConfirmRepeat) {
                setNeedsRepeat(true);
                setError(r.error);
              } else {
                setError(r.error);
                // Un fallo definitivo de PayPal cierra esa solicitud: un nuevo intento usa otra clave.
                if (!r.pending) setKey(newKey());
              }
            }}
          >
            <div className="modal-h">
              <h2>Reembolsar pago · Pedido #{o.number}</h2>
              <button type="button" className="btn btn-tertiary btn-icon" aria-label="Cerrar" onClick={close}>
                <Icon name="x" />
              </button>
            </div>
            <div className="modal-b scroll">
              <div className="rf">
                <div>
                  <div className="rf-items" aria-label="Programas del pedido">
                    {o.items.map((i) => (
                      <div key={i.id} className="li">
                        <span className="thumb">
                          {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del catálogo */}
                          {i.product.images[0] ? <img src={i.product.images[0].url} alt="" /> : <Icon name="product" />}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="strong">{i.productTitle}</div>
                          <div className="small muted">
                            {[i.modality === "ONLINE" ? "Online" : "Semipresencial", i.sede?.name, i.cohort?.name, i.planLabel].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <span className="mono">{usd(i.totalCents)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="divider" />
                  <h3 className="strong" style={{ fontSize: 13, marginBottom: 8 }}>Inscripción</h3>
                  <div className="rf-opts">
                    <label className="check">
                      <input type="checkbox" name="unenroll" checked={unenroll} onChange={(e) => setUnenroll(e.target.checked)} />
                      <span className="t">
                        Desmatricular de Moodle
                        <span className="d">{enrolled ? "Quita el acceso a los cursos de este pedido (salvo los que tenga por otro pedido)." : "Todavía no tiene cursos matriculados por este pedido."}</span>
                      </span>
                    </label>
                    <label className="check">
                      <input type="checkbox" name="releaseSeat" checked={hasSeat ? releaseSeat : false} disabled={!hasSeat} onChange={(e) => setReleaseSeat(e.target.checked)} />
                      <span className="t">
                        Liberar el cupo de la cohorte
                        <span className="d">{hasSeat ? "El cupo queda disponible para otro médico." : "Este pedido no ocupa cupo en una cohorte."}</span>
                      </span>
                    </label>
                    {certs.length ? (
                      <label className="check">
                        <input type="checkbox" name="keepCertificate" checked={keepCert} onChange={(e) => setKeepCert(e.target.checked)} />
                        <span className="t">
                          Conservar el certificado {certs.map((c) => c.code).join(", ")}
                          <span className="d">Un reembolso total revoca el certificado, salvo que lo marques.</span>
                        </span>
                      </label>
                    ) : null}
                  </div>
                  <div className="divider" />
                  <label className="field">
                    <span>Motivo del reembolso</span>
                    <input className="inp" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="p. ej. no podrá asistir a la cohorte" />
                    <span className="help">Se incluye en el correo al cliente{paypal ? " y en la nota de PayPal" : ""}.</span>
                  </label>
                </div>

                <aside className="rf-sum" aria-label="Resumen del reembolso">
                  <h3>Resumen</h3>
                  <div className="ps">
                    <span className="k">Pagado con {METHOD[p.method] ?? p.method}</span>
                    <span className="a">{usd(p.amountUsdCents)}</span>
                    {p.refundedCents ? (
                      <>
                        <span className="k">Ya reembolsado</span>
                        <span className="a">−{usd(p.refundedCents)}</span>
                      </>
                    ) : null}
                    <span className="hr" />
                    <span className="k b">Disponible</span>
                    <span className="a b">{usd(available)}</span>
                  </div>
                  <label className="field rf-amt">
                    <span>Monto a reembolsar</span>
                    <span className="inp-affix">
                      <span className="pre">$</span>
                      <input className="inp has-pre num" name="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid} />
                      <span className="suf">USD</span>
                    </span>
                  </label>
                  <div className="rf-quick" role="group" aria-label="Montos rápidos">
                    <button type="button" className={cents === available ? "on" : ""} onClick={() => setAmount(money(available))}>Todo</button>
                    <button type="button" className={cents === Math.round(available / 2) ? "on" : ""} onClick={() => setAmount(money(Math.round(available / 2)))}>50 %</button>
                    <button type="button" className={cents === Math.round(available / 4) ? "on" : ""} onClick={() => setAmount(money(Math.round(available / 4)))}>25 %</button>
                  </div>
                  <div className="rf-dest">
                    <MethodIcon method={p.method} />
                    <span className="small">
                      {paypal ? (
                        <>Vuelve a la cuenta PayPal del comprador{p.paypalCaptureId ? <> · captura {p.paypalCaptureId}</> : null}.</>
                      ) : (
                        <>Registro manual: devuelve el dinero por {METHOD[p.method]?.toLowerCase()} y anótalo aquí.</>
                      )}
                    </span>
                  </div>
                  {orderWillBeRefunded ? (
                    <p className="small muted" style={{ marginTop: 8 }}>El pedido quedará <b>Reembolsado</b> y el médico recibirá un correo.</p>
                  ) : valid ? (
                    <p className="small muted" style={{ marginTop: 8 }}>Reembolso parcial: el pedido sigue activo y queda un saldo de {usd(Math.max(0, o.balanceCents) + cents)}.</p>
                  ) : null}
                  {needsRepeat ? (
                    <label className="check rf-warn">
                      <input type="checkbox" name="confirmRepeat" checked={confirmRepeat} onChange={(e) => setConfirmRepeat(e.target.checked)} />
                      <span className="t">Es otro reembolso del mismo monto (no un doble envío)</span>
                    </label>
                  ) : null}
                  {error ? (
                    <div className="field-err" role="alert" style={{ marginTop: 8 }}>
                      <Icon name="alert" size={16} /> {error}
                    </div>
                  ) : null}
                </aside>
              </div>
            </div>
            <div className="modal-f">
              <button type="button" className="btn" onClick={close}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={!valid || busy === k || (needsRepeat && !confirmRepeat)}>
                {busy === k ? <Spinner /> : null}
                Reembolsar {valid ? usd(cents) : ""}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </details>
  );
}
