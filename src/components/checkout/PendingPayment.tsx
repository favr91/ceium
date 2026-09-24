"use client";
// Checkout con el pedido ya creado y el cupo RESERVADO: cuenta regresiva de la reserva, datos del médico
// (del pedido) y cómo pagar. PayPal → crea el pago del pedido en curso y va a PayPal; métodos manuales → datos
// de CEIUM para pagar (con botón copiar) y enlace para registrar el pago con su comprobante.
import Link from "next/link";
import { useActionState, useState } from "react";
import type { MethodView, PendingOrderView } from "@/app/(checkout)/checkout/data";
import type { PlaceOrderState } from "@/app/(checkout)/checkout/actions";
import { COUNTRIES } from "./checkout-fields";
import { HoldCountdown } from "./HoldCountdown";
import { CheckIcon, ClockIcon, CopyIcon, FieldErrorIcon, LockIcon, PayPalWordmark } from "./icons";
import { PaypalButton, PaypalRedirectNotice } from "./paypal";
import { usd } from "./OrderSummary";
import type { HoldCohort } from "./CheckoutForm";

export interface PendingPaymentProps {
  pending: PendingOrderView;
  methods: MethodView[];
  holds: HoldCohort[];
  serverNow: string;
  justCreated: boolean;
  /** Volvió de PayPal sin pagar (cancel_url del checkout). */
  paypalCancelled?: boolean;
  /** Minutos de reserva que da cada intento de PayPal (para la pantalla de salida a PayPal). */
  paypalHoldMinutes?: number | null;
  payWithPaypal: (prev: PlaceOrderState, fd: FormData) => Promise<PlaceOrderState>;
}

function ves(cents: number): string {
  return "Bs. " + (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function holdUntil(iso: string): string {
  return new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: "America/Caracas" }).format(new Date(iso));
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="co-copy"
      aria-label={done ? `${label} copiado` : `Copiar ${label.toLowerCase()}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          window.setTimeout(() => setDone(false), 1800);
        } catch {
          /* el navegador no permite copiar: el dato sigue visible */
        }
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      <span>{done ? "Copiado" : "Copiar"}</span>
    </button>
  );
}

export function PendingPayment({ pending, methods, holds, serverNow, justCreated, paypalCancelled, paypalHoldMinutes, payWithPaypal }: PendingPaymentProps) {
  const keys = methods.map((m) => m.method as string);
  const [method, setMethod] = useState<string>(pending.method && keys.includes(pending.method) ? pending.method : keys[0] ?? "");
  const [state, action] = useActionState(payWithPaypal, null);
  const c = pending.customer;
  const country = COUNTRIES.find((x) => x.code === c.country)?.name;
  const selected = methods.find((m) => m.method === method) ?? null;
  const payHref = `/pedido/${encodeURIComponent(pending.token)}${selected && selected.method !== "PAYPAL" ? `?metodo=${selected.method}` : ""}#pagar`;

  return (
    <div className="co-form">
      {pending.holdExpiresAt ? (
        <section className="co-hold co-hold-live" aria-labelledby="co-hold-title" data-testid="hold-card">
          <ClockIcon className="co-hold-icon" />
          <div className="co-hold-body">
            <h2 id="co-hold-title" className="co-hold-title">
              Tu cupo está reservado
            </h2>
            <ul className="co-hold-list">
              {holds.map((h) => (
                <li key={h.title}>
                  <strong>{h.cohort}</strong> · {h.sede} · {h.dates}
                </li>
              ))}
            </ul>
            <p className="co-hold-text">Completa el pago antes del {holdUntil(pending.holdExpiresAt)} para confirmarlo. Si no, el cupo se libera para otro médico.</p>
          </div>
          <HoldCountdown expiresAt={pending.holdExpiresAt} serverNow={serverNow} />
        </section>
      ) : null}

      {justCreated ? (
        <div className="co-banner co-banner-ok" role="status">
          <CheckIcon />
          <p>
            Creamos tu pedido <strong>#{pending.number}</strong>. También te enviamos por correo los datos para pagar.
          </p>
        </div>
      ) : null}
      {paypalCancelled && !state?.formError ? (
        <div className="co-banner co-banner-info" role="status" data-testid="paypal-cancelled">
          <ClockIcon />
          <p>
            No se completó el pago en PayPal y no se te cobró nada. {pending.holdExpiresAt ? "Tu cupo sigue reservado: puedes" : "Puedes"} intentarlo de nuevo o elegir otro método.
          </p>
        </div>
      ) : null}
      {state?.formError ? (
        <div className="co-banner" role="alert">
          <FieldErrorIcon />
          <p>{state.formError}</p>
        </div>
      ) : null}

      <section className="co-section" aria-labelledby="co-review">
        <div className="co-section-head">
          <h2 id="co-review" className="co-h2">
            Pedido #{pending.number}
          </h2>
        </div>
        <dl className="co-review" data-testid="order-review">
          <div>
            <dt>Contacto</dt>
            <dd>
              {c.email}
              {c.phone ? <span> · {c.phone}</span> : null}
            </dd>
          </div>
          <div>
            <dt>Médico</dt>
            <dd>
              {c.firstName} {c.lastName}
              {c.cedula ? <span> · {c.cedula}</span> : null}
            </dd>
          </div>
          {c.specialty ? (
            <div>
              <dt>Especialidad</dt>
              <dd>
                {c.specialty}
                {c.city || country ? <span> · {[c.city, country].filter(Boolean).join(", ")}</span> : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="co-section" aria-labelledby="co-payment">
        <h2 id="co-payment" className="co-h2">
          Pago
        </h2>
        <p className="co-sub">Todas las transacciones son seguras y están encriptadas.</p>
        <fieldset className="co-methods">
          <legend className="co-visually-hidden">Método de pago</legend>
          {methods.map((m) => {
            const on = m.method === method;
            return (
              <div key={m.method} className="co-method" data-selected={on || undefined} data-testid={`method-${m.method}`}>
                <label className="co-method-head">
                  <input type="radio" name="method" value={m.method} checked={on} onChange={() => setMethod(m.method)} />
                  <span className="co-method-label">{m.label}</span>
                  <span className="co-method-tag">{m.method === "PAYPAL" ? <PayPalWordmark /> : <span className="co-pill">{m.currency === "VES" ? "Bs." : "USD"}</span>}</span>
                </label>
                {on ? (
                  <div className="co-method-body" data-testid="method-body">
                    {m.method === "PAYPAL" ? (
                      <PaypalRedirectNotice />
                    ) : (
                      <>
                        <dl className="co-amount">
                          <div>
                            <dt>Monto a pagar</dt>
                            <dd data-testid="method-amount">{m.currency === "VES" && m.vesPerUsd ? ves(Math.round(pending.dueNowCents * m.vesPerUsd)) : usd(pending.dueNowCents)}</dd>
                          </div>
                          {m.currency === "VES" && m.vesPerUsd ? (
                            <div>
                              <dt>Tasa del día</dt>
                              <dd>
                                Bs. {m.vesPerUsd.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por USD · {usd(pending.dueNowCents)}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                        {m.details?.length ? (
                          <dl className="co-bank" data-testid="method-details">
                            {m.details.map((d) => (
                              <div key={d.label}>
                                <dt>{d.label}</dt>
                                <dd>
                                  <span>{d.value}</span>
                                  <CopyButton value={d.value} label={d.label} />
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                        {m.instructions ? <p className="co-instructions">{m.instructions}</p> : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      </section>

      {selected?.method === "PAYPAL" ? (
        <form action={action}>
          <PaypalButton handoff={{ amountLabel: `${usd(pending.dueNowCents)} USD`, holdMinutes: pending.holdExpiresAt ? paypalHoldMinutes : null }} />
        </form>
      ) : selected ? (
        <Link href={payHref} className="co-pay" data-testid="report-payment">
          Ya pagué: registrar mi pago
        </Link>
      ) : null}
      <p className="co-secure">
        <LockIcon />
        {selected?.method === "PAYPAL" ? `Pagarás ${usd(pending.dueNowCents)} USD en el sitio seguro de PayPal y volverás aquí para ver tu confirmación.` : "Registra la referencia y el comprobante; te avisamos por correo al verificarlo."}
      </p>
    </div>
  );
}
