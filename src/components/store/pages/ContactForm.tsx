"use client";
// Formulario de contacto (réplica del formulario PageFly de ceium.net/pages/contacto): Nombre* y Apellido en dos
// columnas, Correo electrónico*, Mensaje* y «Enviar mensaje». Envía por Server Action (funciona también sin JS)
// y muestra la confirmación o los errores de validación de cada campo.
import { useActionState, useEffect, useId, useRef } from "react";
import { sendContactMessage, type ContactFormState } from "@/app/(store)/pages/contacto/actions";

const INITIAL: ContactFormState = { status: "idle" };

type FieldName = "nombre" | "apellido" | "email" | "mensaje";

export function ContactForm({ submitLabel, successMessage }: { submitLabel: string; successMessage: string }) {
  const [state, action, pending] = useActionState(sendContactMessage, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const uid = useId();

  useEffect(() => {
    if (state.status === "ok") formRef.current?.reset();
    if (state.status !== "idle") statusRef.current?.focus();
    if (state.status === "error" && state.fields) {
      const first = (["nombre", "apellido", "email", "mensaje"] as FieldName[]).find((f) => state.fields?.[f]);
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    }
  }, [state]);

  const errors = state.status === "error" ? (state.fields ?? {}) : {};
  const values = state.status === "error" ? (state.values ?? {}) : {};
  const id = (f: FieldName) => `${uid}-${f}`;
  const err = (f: FieldName) =>
    errors[f] ? (
      <p className="pg-form__error" id={`${id(f)}-error`}>
        {errors[f]}
      </p>
    ) : null;
  const a11y = (f: FieldName) => (errors[f] ? { "aria-invalid": true, "aria-describedby": `${id(f)}-error` } : {});
  // Tras un error se remonta el formulario con lo que el médico escribió (las Server Actions reinician los campos).
  const formKey = state.status === "error" ? JSON.stringify(values) : state.status;

  return (
    <form ref={formRef} key={formKey} action={action} className="pg-form" aria-describedby={`${uid}-status`}>
      <input type="hidden" name="success" value={successMessage} />
      <div className="pg-form__trap" aria-hidden="true">
        <label htmlFor={`${uid}-website`}>No llenar este campo</label>
        <input id={`${uid}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <div className="pg-form__row pg-form__row--2">
        <div className="pg-form__field">
          <label htmlFor={id("nombre")}>
            Nombre<sup aria-hidden="true">*</sup>
          </label>
          <input id={id("nombre")} name="nombre" type="text" placeholder="Ingresa tu nombre" required autoComplete="given-name" maxLength={120} defaultValue={values.nombre} {...a11y("nombre")} />
          {err("nombre")}
        </div>
        <div className="pg-form__field">
          <label htmlFor={id("apellido")}>Apellido</label>
          <input id={id("apellido")} name="apellido" type="text" placeholder="Ingresa tu apellido" autoComplete="family-name" maxLength={120} defaultValue={values.apellido} {...a11y("apellido")} />
          {err("apellido")}
        </div>
      </div>
      <div className="pg-form__row">
        <div className="pg-form__field">
          <label htmlFor={id("email")}>
            Correo electrónico<sup aria-hidden="true">*</sup>
          </label>
          <input id={id("email")} name="email" type="email" placeholder="Ingresa tu correo" required autoComplete="email" maxLength={200} defaultValue={values.email} {...a11y("email")} />
          {err("email")}
        </div>
      </div>
      <div className="pg-form__row">
        <div className="pg-form__field">
          <label htmlFor={id("mensaje")}>
            Mensaje<sup aria-hidden="true">*</sup>
          </label>
          <textarea id={id("mensaje")} name="mensaje" placeholder="Ingresa tu mensaje" required rows={6} maxLength={5000} defaultValue={values.mensaje} {...a11y("mensaje")} />
          {err("mensaje")}
        </div>
      </div>
      <p
        ref={statusRef}
        id={`${uid}-status`}
        tabIndex={-1}
        role={state.status === "error" ? "alert" : "status"}
        className={`pg-form__status${state.status === "ok" ? " pg-form__status--ok" : state.status === "error" ? " pg-form__status--error" : ""}`}
      >
        {state.status === "ok" || state.status === "error" ? state.message : ""}
      </p>
      <div className="pg-form__actions">
        <button type="submit" className="pg-btn" disabled={pending} aria-busy={pending}>
          {pending ? "Enviando…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
