"use client";
// Checkout con el pedido ya creado y el cupo RESERVADO: cuenta regresiva de la reserva, datos del médico
// (del pedido) y cómo pagar. PayPal → crea el pago del pedido en curso y va a PayPal; métodos manuales → monto en
// Bs./USD a la tasa del panel, datos de CEIUM con «Copiar» y, en el mismo panel, el registro del pago (referencia,
// banco, monto, fecha y comprobante) que se envía a /api/checkout/comprobante → página del pedido «en verificación».
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import type { MethodView, PendingOrderView } from "@/app/(checkout)/checkout/data";
import type { PlaceOrderState } from "@/app/(checkout)/checkout/actions";
import { COUNTRIES } from "./checkout-fields";
import { HoldCountdown } from "./HoldCountdown";
import { CheckIcon, ClockIcon, FieldErrorIcon, LockIcon } from "./icons";
import { ManualAmount, ManualFields, methodAmountCents, methodAmountLabel, PayeeDetails } from "./ManualPayment";
import { formatAmount, MANUAL_FIELD_ORDER, methodInText, validateManualPayment, type ManualErrors, type ManualField, type ManualValues } from "./manual-payment-fields";
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
  /** Fecha de hoy en Venezuela (tope del campo «Fecha del pago»). */
  today: string;
  /** Aviso del registro del pago sin JavaScript (?pago=error|vencido&motivo=…). */
  payError?: string | null;
}

type SendResult = { ok: true; redirect: string } | { ok: false; formError: string; fieldErrors?: ManualErrors; expired?: boolean };

function holdUntil(iso: string): string {
  return new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: "America/Caracas" }).format(new Date(iso));
}


function sendProof(fd: FormData, onProgress: (pct: number) => void): Promise<SendResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/checkout/comprobante");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as SendResult);
      } catch {
        resolve({ ok: false, formError: "No pudimos registrar tu pago. Intenta de nuevo en unos segundos; tu cupo sigue reservado." });
      }
    };
    xhr.onerror = () => resolve({ ok: false, formError: "Se perdió la conexión al enviar el comprobante. Revisa tu internet e intenta de nuevo; tu cupo sigue reservado." });
    xhr.send(fd);
  });
}

export function PendingPayment({ pending, methods, holds, serverNow, justCreated, paypalCancelled, paypalHoldMinutes, payWithPaypal, today, payError }: PendingPaymentProps) {
  const router = useRouter();
  const keys = methods.map((m) => m.method as string);
  const [method, setMethod] = useState<string>(pending.method && keys.includes(pending.method) ? pending.method : keys[0] ?? "");
  const [state, action] = useActionState(payWithPaypal, null);
  const c = pending.customer;
  const country = COUNTRIES.find((x) => x.code === c.country)?.name;
  const selected = methods.find((m) => m.method === method) ?? null;
  const manual = !!selected && selected.method !== "PAYPAL";
  const reportable = manual && selected.method !== "EFECTIVO";
  const payHref = `/pedido/${encodeURIComponent(pending.token)}${manual ? `?metodo=${selected.method}` : ""}#pagar`;

  // Registro del pago manual: un solo estado para todos los métodos (cambiar de método no borra lo escrito); el
  // monto se precarga con lo que corresponde en la moneda de cada método hasta que el médico lo cambie.
  const [vals, setVals] = useState<Omit<ManualValues, "amount">>({ reference: "", bank: "", paidAt: today });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<ManualErrors>({});
  const [sendError, setSendError] = useState<string | null>(payError ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const amount = selected ? (amounts[selected.method] ?? formatAmount(methodAmountCents(selected, pending.dueNowCents))) : "";
  const values: ManualValues = { ...vals, amount };
  const sending = progress !== null;

  const setValue = (name: Exclude<ManualField, "proof">, v: string) => {
    if (name === "amount") setAmounts((prev) => ({ ...prev, [method]: v }));
    else setVals((prev) => ({ ...prev, [name]: v }));
    setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev));
  };
  const setProof = (f: File | null) => {
    setFile(f);
    setErrors((prev) => (prev.proof ? { ...prev, proof: undefined } : prev));
  };
  const focusFirst = (errs: ManualErrors) => {
    const first = MANUAL_FIELD_ORDER.find((k) => errs[k]);
    const el = first ? formRef.current?.querySelector<HTMLElement>(`#co-${first}`) : null;
    if (el) {
      el.focus({ preventScroll: true });
      (first === "proof" ? el.parentElement : el)?.scrollIntoView({ block: "center", behavior: "smooth" });
    } else bannerRef.current?.focus();
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selected || !reportable || sending) return;
    const errs = validateManualPayment(values, file ? { name: file.name, size: file.size } : null, selected.currency, today);
    setErrors(errs);
    setSendError(null);
    if (Object.keys(errs).length) return focusFirst(errs);
    const fd = new FormData();
    fd.set("method", selected.method);
    fd.set("reference", values.reference);
    fd.set("bank", values.bank);
    fd.set("amount", values.amount);
    fd.set("paidAt", values.paidAt);
    fd.set("proof", file!, file!.name);
    setProgress(0);
    const res = await sendProof(fd, setProgress);
    if (res.ok) {
      setProgress(100);
      router.push(res.redirect);
      return;
    }
    setProgress(null);
    setErrors(res.fieldErrors ?? {});
    setSendError(res.fieldErrors && Object.keys(res.fieldErrors).length ? null : res.formError);
    if (res.expired) router.refresh();
    window.setTimeout(() => focusFirst(res.fieldErrors ?? {}), 0);
  };

  const firstName = c.firstName?.trim();
  const steps = !selected
    ? ["Pedido creado", "Pago", "Acceso al aula virtual"]
    : selected.method === "PAYPAL"
      ? ["Pedido creado", "Pago con PayPal", "Acceso al aula virtual"]
      : selected.method === "EFECTIVO"
        ? ["Pedido creado", "Pago en la sede", "Registro del pago", "Acceso al aula virtual"]
        : ["Pedido creado", "Pago y comprobante", "Verificación de CEIUM", "Acceso al aula virtual"];
  const nextStep = !selected
    ? "elige cómo pagar para confirmar tu inscripción."
    : selected.method === "PAYPAL"
      ? `paga ${usd(pending.dueNowCents)} USD con PayPal y tu inscripción se confirma al instante.`
      : selected.method === "EFECTIVO"
        ? `paga ${methodAmountLabel(selected, pending.dueNowCents)} en efectivo en la sede; el personal registra tu pago y confirma tu inscripción.`
        : `paga ${methodAmountLabel(selected, pending.dueNowCents)} por ${methodInText(selected.method, selected.label)} y registra tu comprobante aquí abajo. Confirmamos tu inscripción al verificarlo.`;

  return (
    <div className="co-form co-pending">
      <header className="co-status" role={justCreated ? "status" : undefined} data-testid="order-status">
        <span className="co-status-icon" aria-hidden="true">
          <CheckIcon />
        </span>
        <div className="co-status-body">
          <p className="co-status-eyebrow">Pedido #{pending.number}</p>
          <h1 className="co-status-title">{justCreated ? `Creamos tu pedido${firstName ? `, ${firstName}` : ""}` : `Tu pedido espera tu pago${firstName ? `, ${firstName}` : ""}`}</h1>
          <p className="co-status-text">
            <strong>Falta un paso:</strong> {nextStep}
            {justCreated ? <> También te enviamos estos datos a {c.email}.</> : null}
          </p>
        </div>
      </header>

      <ol className="co-progress" aria-label="Tu inscripción">
        {steps.map((label, i) => (
          <li key={label} data-state={i === 0 ? "done" : i === 1 ? "current" : undefined} aria-current={i === 1 ? "step" : undefined}>
            <span className="co-progress-dot" aria-hidden="true">
              {i === 0 ? <CheckIcon /> : i + 1}
            </span>
            <span className="co-progress-label">
              {label}
              {i === 0 ? <span className="co-visually-hidden"> (listo)</span> : i === 1 ? <span className="co-visually-hidden"> (paso actual)</span> : null}
            </span>
          </li>
        ))}
      </ol>

      {pending.holdExpiresAt ? (
        <section className="co-hold co-hold-live co-hold-compact" aria-labelledby="co-hold-title" data-testid="hold-card">
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
            <p className="co-hold-text">Paga antes del {holdUntil(pending.holdExpiresAt).replace(/\.$/, "")}. Si no, el cupo se libera para otro médico.</p>
          </div>
          <HoldCountdown expiresAt={pending.holdExpiresAt} serverNow={serverNow} />
        </section>
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

      <form ref={formRef} action="/api/checkout/comprobante" method="post" encType="multipart/form-data" noValidate onSubmit={onSubmit} aria-label="Registrar el pago" className="co-pay-manual">
        <section className="co-section co-paynow" aria-labelledby="co-payment">
          <h2 id="co-payment" className="co-h2">
            {reportable ? "Paga y registra tu pago" : selected?.method === "EFECTIVO" ? "Cómo hacer tu pago" : "Haz tu pago"}
          </h2>
          <fieldset className="co-switch" disabled={sending}>
            <legend className="co-switch-legend">{methods.length > 1 ? "Método de pago (puedes cambiarlo)" : "Método de pago"}</legend>
            {methods.map((m) => {
              const on = m.method === method;
              return (
                <div key={m.method} className="co-switch-item" data-selected={on || undefined} data-testid={`method-${m.method}`}>
                  <label className="co-chip">
                    <input
                      type="radio"
                      name="method"
                      value={m.method}
                      checked={on}
                      className="co-visually-hidden"
                      onChange={() => {
                        setMethod(m.method);
                        setErrors({});
                        setSendError(null);
                      }}
                    />
                    <span className="co-chip-check" aria-hidden="true">
                      {on ? <CheckIcon /> : null}
                    </span>
                    <span className="co-chip-label">{m.label}</span>
                    <span className="co-chip-tag" aria-hidden="true">
                      {m.method === "PAYPAL" ? null : m.currency === "VES" ? "Bs." : "USD"}
                    </span>
                  </label>
                  {on ? (
                    <div className="co-paycard" data-testid="method-body">
                      {m.method === "PAYPAL" ? (
                        <PaypalRedirectNotice />
                      ) : (
                        <div className="co-manual-panel">
                          <p className="co-method-intro">
                            {m.method === "EFECTIVO" ? (
                              <>Paga en la sede el monto indicado. El personal registra tu pago y te entrega el recibo; al confirmarlo recibirás tu acceso al aula virtual (Moodle).</>
                            ) : (
                              <>
                                Haz {m.method === "PAGO_MOVIL" ? "el pago móvil" : m.method === "TRANSFERENCIA" ? "la transferencia" : "el pago"} a CEIUM con estos datos y luego registra tu pago abajo con el comprobante. Al verificarlo te enviamos tu acceso al aula virtual (Moodle).
                              </>
                            )}
                          </p>
                          <ManualAmount m={m} dueNowCents={pending.dueNowCents} copy={m.method !== "EFECTIVO"} />
                          <PayeeDetails m={m} amountLabel={methodAmountLabel(m, pending.dueNowCents)} />
                          {m.instructions ? <p className="co-instructions">{m.instructions}</p> : null}
                          {m.method !== "EFECTIVO" ? <ManualFields m={m} dueNowCents={pending.dueNowCents} today={today} values={values} errors={errors} onChange={setValue} file={file} onFile={setProof} /> : null}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        </section>

        {sendError ? (
          <div className="co-banner co-banner-send" role="alert" tabIndex={-1} ref={bannerRef} data-testid="send-error">
            <FieldErrorIcon />
            <p>{sendError}</p>
          </div>
        ) : null}

        {reportable ? (
          <>
            <button type="submit" className="co-pay" disabled={sending} data-pending={sending || undefined} aria-busy={sending || undefined}>
              {sending ? (
                <>
                  <span className="co-spinner" aria-hidden="true" />
                  <span>{progress !== null && progress < 100 ? `Enviando comprobante… ${progress} %` : "Registrando tu pago…"}</span>
                </>
              ) : (
                "Enviar comprobante"
              )}
            </button>
            <p className="co-secure">
              <LockIcon />
              Tu comprobante solo lo ve el equipo de CEIUM. Te avisaremos por correo a {c.email} al verificarlo.
            </p>
          </>
        ) : null}
      </form>

      {selected?.method === "PAYPAL" ? (
        <form action={action}>
          <PaypalButton handoff={{ amountLabel: `${usd(pending.dueNowCents)} USD`, holdMinutes: pending.holdExpiresAt ? paypalHoldMinutes : null }} />
          <p className="co-secure">
            <LockIcon />
            Pagarás {usd(pending.dueNowCents)} USD en el sitio seguro de PayPal y volverás aquí para ver tu confirmación.
          </p>
        </form>
      ) : null}
      {manual ? (
        <p className="co-later">
          {selected.method === "EFECTIVO" ? "Guarda tu pedido para pagar en la sede: " : "¿Pagarás más tarde? "}
          <Link href={payHref} data-testid="report-payment">
            {selected.method === "EFECTIVO" ? "ver mi pedido" : "Registra tu pago desde la página de tu pedido"}
          </Link>
          {selected.method === "EFECTIVO" ? "." : " (también te enviamos el enlace por correo)."}
        </p>
      ) : null}

      <section className="co-section co-orderdata" aria-labelledby="co-review">
        <h2 id="co-review" className="co-h3">
          Datos del pedido
        </h2>
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
    </div>
  );
}
