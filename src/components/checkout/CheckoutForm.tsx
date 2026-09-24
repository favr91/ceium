"use client";
// Formulario del checkout (réplica del checkout de Shopify de ceium.net, con lo que CEIUM necesita):
// contacto (correo + teléfono), datos del médico (país, nombre, apellidos, cédula, ciudad, especialidad) y
// método de pago en acordeón. Valida en el navegador con los mismos textos que el servidor, y el servidor
// (server action) vuelve a validar todo antes de crear el pedido y reservar el cupo.
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { MethodView } from "@/app/(checkout)/checkout/data";
import type { PlaceOrderState } from "@/app/(checkout)/checkout/actions";
import { COUNTRIES, FIELD_ORDER, OTHER_SPECIALTY, SPECIALTIES, validateCheckout, type CheckoutField, type CheckoutValues } from "./checkout-fields";
import { ChevronDownIcon, ClockIcon, FieldErrorIcon, HelpIcon, LockIcon, PayPalWordmark } from "./icons";
import { PaypalButton, PaypalRedirectNotice, type PaypalHandoff } from "./paypal";
import { usd } from "./OrderSummary";
import { ManualAmount } from "./ManualPayment";

export interface HoldCohort {
  title: string;
  cohort: string;
  sede: string;
  dates: string;
  available: number;
}

export interface CheckoutFormProps {
  action: (prev: PlaceOrderState, fd: FormData) => Promise<PlaceOrderState>;
  methods: MethodView[];
  initialMethod: string | null;
  ttl: { paypalMinutes: number; manualHours: number };
  holds: HoldCohort[];
  dueNowCents: number;
  count: number;
  blocked: boolean;
}

type Errors = Partial<Record<CheckoutField, string>>;

const EMPTY: CheckoutValues = { email: "", phone: "", country: "VE", firstName: "", lastName: "", cedula: "", city: "", specialty: "", specialtyOther: "", method: "" };

function ttlText(method: string, ttl: CheckoutFormProps["ttl"]): { short: string; long: string } {
  if (method === "PAYPAL") return { short: `${String(ttl.paypalMinutes).padStart(2, "0")}:00`, long: `${ttl.paypalMinutes} minutos` };
  return { short: `${ttl.manualHours} h`, long: `${ttl.manualHours} horas` };
}

// ───────────── campos ─────────────

interface FieldProps {
  name: CheckoutField;
  label: string;
  value: string;
  error?: string;
  onChange: (name: CheckoutField, v: string) => void;
  type?: string;
  autoComplete?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  help?: string;
  optional?: boolean;
  className?: string;
}

function Field({ name, label, value, error, onChange, type = "text", autoComplete, inputMode, help, optional, className }: FieldProps) {
  const id = `co-${name}`;
  return (
    <div className={`co-cell ${className ?? ""}`}>
      <div className="co-field" data-invalid={error ? "true" : undefined} data-help={help ? "true" : undefined}>
        <input
          id={id}
          name={name}
          type={type}
          value={value}
          placeholder=" "
          autoComplete={autoComplete}
          inputMode={inputMode}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          aria-required={optional ? undefined : true}
          onChange={(e) => onChange(name, e.target.value)}
        />
        <label htmlFor={id}>
          {label}
          {optional ? " (opcional)" : ""}
        </label>
        {help ? (
          <span className="co-help">
            <button type="button" aria-label={`Más información: ${help}`} tabIndex={0}>
              <HelpIcon />
            </button>
            <span className="co-tip" role="tooltip">
              {help}
            </span>
          </span>
        ) : null}
      </div>
      {error ? (
        <p className="co-error" id={`${id}-error`}>
          <FieldErrorIcon />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SelectField({ name, label, value, error, onChange, children, className }: Omit<FieldProps, "type"> & { children: React.ReactNode }) {
  const id = `co-${name}`;
  return (
    <div className={`co-cell ${className ?? ""}`}>
      <div className="co-field co-select" data-invalid={error ? "true" : undefined} data-empty={value ? undefined : "true"}>
        <select id={id} name={name} value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} aria-required onChange={(e) => onChange(name, e.target.value)}>
          {children}
        </select>
        <label htmlFor={id}>{label}</label>
        <ChevronDownIcon className="co-chevron" />
      </div>
      {error ? (
        <p className="co-error" id={`${id}-error`}>
          <FieldErrorIcon />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SubmitButton({ method, label, disabled, handoff }: { method: string; label: string; disabled: boolean; handoff: PaypalHandoff }) {
  const { pending } = useFormStatus();
  if (method === "PAYPAL") return <PaypalButton disabled={disabled} handoff={handoff} />;
  return (
    <button type="submit" className="co-pay" disabled={disabled || pending} data-pending={pending || undefined}>
      {pending ? <span className="co-spinner" aria-hidden="true" /> : label}
    </button>
  );
}

// ───────────── formulario ─────────────

export function CheckoutForm({ action, methods, initialMethod, ttl, holds, dueNowCents, count, blocked }: CheckoutFormProps) {
  const methodKeys = methods.map((m) => m.method as string);
  const [v, setV] = useState<CheckoutValues>(() => ({ ...EMPTY, method: initialMethod && methodKeys.includes(initialMethod) ? initialMethod : methodKeys[0] ?? "" }));
  const [errors, setErrors] = useState<Errors>({});
  const [state, formAction] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);

  // Errores del servidor → en línea (ajuste de estado durante el render, una vez por respuesta)…
  const [seenAt, setSeenAt] = useState<number | undefined>(undefined);
  if (state?.at !== seenAt) {
    setSeenAt(state?.at);
    setErrors(state?.fieldErrors ?? {});
  }
  // …y foco en el primero (o en el aviso general).
  useEffect(() => {
    if (!state) return;
    const fe = state.fieldErrors ?? {};
    const first = FIELD_ORDER.find((k) => fe[k]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    else bannerRef.current?.focus();
  }, [state]);

  const set = (name: CheckoutField, value: string) => {
    setV((prev) => ({ ...prev, [name]: value }));
    setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev));
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    const errs = validateCheckout(v, methodKeys);
    if (Object.keys(errs).length) {
      e.preventDefault();
      setErrors(errs);
      const first = FIELD_ORDER.find((k) => errs[k]);
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    }
  };

  const selected = methods.find((m) => m.method === v.method) ?? null;
  const hold = ttlText(v.method, ttl);
  const semi = holds.length > 0;
  const manualLabel = semi ? "Reservar mi cupo y ver datos de pago" : "Confirmar pedido y ver datos de pago";
  const isVe = v.country === "VE";

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} noValidate className="co-form" aria-label="Pantalla de pago">
      {semi ? (
        <section className="co-hold" aria-labelledby="co-hold-title" data-testid="hold-card">
          <ClockIcon className="co-hold-icon" />
          <div className="co-hold-body">
            <h2 id="co-hold-title" className="co-hold-title">
              Tu cupo se reserva al confirmar
            </h2>
            <ul className="co-hold-list">
              {holds.map((h) => (
                <li key={h.title}>
                  <strong>{h.cohort}</strong> · {h.sede} · {h.dates}
                  <span className="co-hold-seats"> · {h.available === 1 ? "queda 1 cupo" : `quedan ${h.available} cupos`}</span>
                </li>
              ))}
            </ul>
            <p className="co-hold-text">
              {v.method === "PAYPAL"
                ? `Lo apartamos ${hold.long} mientras pagas con PayPal. Si no se completa el pago, se libera.`
                : `Lo apartamos ${hold.long} mientras envías tu comprobante. Si no llega, se libera.`}
            </p>
          </div>
          <span className="co-timer co-timer-idle" data-testid="hold-ttl" aria-label={`Reserva de ${hold.long}`}>
            {hold.short}
          </span>
        </section>
      ) : null}

      {state?.formError ? (
        <div className="co-banner" role="alert" tabIndex={-1} ref={bannerRef}>
          <FieldErrorIcon />
          <p>{state.formError}</p>
        </div>
      ) : null}

      <section className="co-section" aria-labelledby="co-contact">
        <div className="co-section-head">
          <h2 id="co-contact" className="co-h2">
            Contacto
          </h2>
        </div>
        <div className="co-grid">
          <Field name="email" label="Correo electrónico" type="email" autoComplete="email" inputMode="email" value={v.email} error={errors.email} onChange={set} help="Te enviaremos la confirmación del pedido y tu acceso al aula virtual (Moodle) a este correo." />
          <Field name="phone" label="Teléfono (WhatsApp)" type="tel" autoComplete="tel" inputMode="tel" value={v.phone} error={errors.phone} onChange={set} help="Solo para avisos sobre tu inscripción y tu sede. Ej.: 0414-1234567." />
        </div>
      </section>

      <section className="co-section" aria-labelledby="co-doctor">
        <div className="co-section-head">
          <h2 id="co-doctor" className="co-h2">
            Datos del médico
          </h2>
        </div>
        <p className="co-sub">Escríbelos como aparecen en tu cédula: así irán en tu certificado.</p>
        <div className="co-grid">
          <SelectField name="country" label="País / Región" value={v.country} error={errors.country} onChange={set}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <Field name="firstName" label="Nombre" autoComplete="given-name" value={v.firstName} error={errors.firstName} onChange={set} className="co-half" />
          <Field name="lastName" label="Apellidos" autoComplete="family-name" value={v.lastName} error={errors.lastName} onChange={set} className="co-half" />
          <Field name="cedula" label={isVe ? "Cédula de identidad" : "Documento de identidad"} autoComplete="off" value={v.cedula} error={errors.cedula} onChange={set} className="co-half" help={isVe ? "Ej.: V-12345678. La usamos para emitir tu certificado." : "Pasaporte o documento nacional. Lo usamos para emitir tu certificado."} />
          <Field name="city" label="Ciudad" autoComplete="address-level2" value={v.city} error={errors.city} onChange={set} className="co-half" optional />
          <SelectField name="specialty" label="Especialidad" value={v.specialty} error={errors.specialty} onChange={set}>
            <option value="" disabled>
              Selecciona tu especialidad
            </option>
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={OTHER_SPECIALTY}>Otra especialidad</option>
          </SelectField>
          {v.specialty === OTHER_SPECIALTY ? <Field name="specialtyOther" label="¿Cuál es tu especialidad?" value={v.specialtyOther} error={errors.specialtyOther} onChange={set} /> : null}
        </div>
      </section>

      <section className="co-section" aria-labelledby="co-payment">
        <h2 id="co-payment" className="co-h2">
          Pago
        </h2>
        <p className="co-sub">Todas las transacciones son seguras y están encriptadas.</p>
        {methods.length === 0 ? (
          <p className="co-banner">En este momento no hay métodos de pago disponibles. Escríbenos y te ayudamos a inscribirte.</p>
        ) : (
          <fieldset className="co-methods" aria-describedby={errors.method ? "co-method-error" : undefined}>
            <legend className="co-visually-hidden">Método de pago</legend>
            {methods.map((m) => {
              const on = m.method === v.method;
              return (
                <div key={m.method} className="co-method" data-selected={on || undefined} data-testid={`method-${m.method}`}>
                  <label className="co-method-head">
                    <input type="radio" name="method" value={m.method} checked={on} onChange={() => set("method", m.method)} />
                    <span className="co-method-label">{m.label}</span>
                    <span className="co-method-tag">{m.method === "PAYPAL" ? <PayPalWordmark /> : <span className="co-pill">{m.currency === "VES" ? "Bs." : "USD"}</span>}</span>
                  </label>
                  {on ? (
                    <div className="co-method-body" data-testid="method-body">
                      <MethodBody m={m} dueNowCents={dueNowCents} semi={semi} holdLong={ttlText(m.method, ttl).long} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        )}
        {errors.method ? (
          <p className="co-error" id="co-method-error">
            <FieldErrorIcon />
            {errors.method}
          </p>
        ) : null}
      </section>

      <div className="co-mobile-total" aria-hidden="true">
        <span>
          <strong>Total</strong>
          <small>{count === 1 ? "1 programa" : `${count} programas`}</small>
        </span>
        <span className="co-total-amount">
          <span className="co-currency">USD</span>
          <strong>{usd(dueNowCents)}</strong>
        </span>
      </div>

      <SubmitButton method={v.method} label={manualLabel} disabled={blocked || methods.length === 0} handoff={{ amountLabel: `${usd(dueNowCents)} USD`, holdMinutes: semi ? ttl.paypalMinutes : null }} />
      {blocked ? <p className="co-error co-error-block">Hay programas en tu carrito que no se pueden comprar tal como están. Vuelve al carrito para corregirlos.</p> : null}
      <p className="co-secure">
        <LockIcon />
        {selected?.method === "PAYPAL" ? `Pagarás ${usd(dueNowCents)} USD en el sitio seguro de PayPal y volverás aquí para ver tu confirmación.` : "Te mostraremos los datos para pagar y podrás enviar tu comprobante."}
      </p>
    </form>
  );
}

const METHOD_VERB: Record<string, string> = { PAGO_MOVIL: "el pago móvil", TRANSFERENCIA: "la transferencia bancaria", ZELLE: "el pago por Zelle", EFECTIVO: "el pago en la sede" };

function MethodBody({ m, dueNowCents, semi, holdLong }: { m: MethodView; dueNowCents: number; semi: boolean; holdLong: string }) {
  if (m.method === "PAYPAL") {
    return <PaypalRedirectNotice />;
  }
  const reserve = semi ? `reservamos tu cupo por ${holdLong} y ` : "";
  return (
    <div className="co-manual-panel">
      <p className="co-method-intro">
        Al finalizar el pedido, {reserve}te mostraremos los datos de {m.label} de CEIUM para hacer {METHOD_VERB[m.method] ?? "el pago"}.{" "}
        {m.method === "EFECTIVO" ? "El personal de la sede registra tu pago" : "Luego registras aquí mismo la referencia y el comprobante"}; una vez que el pago sea verificado, tendrás acceso al curso o diplomado en la plataforma Moodle.
      </p>
      <ManualAmount m={m} dueNowCents={dueNowCents} />
    </div>
  );
}
