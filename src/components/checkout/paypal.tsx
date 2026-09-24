"use client";
// Piezas del pago con PayPal compartidas por el checkout, el pedido en curso y la página del pedido:
//   - PaypalRedirectNotice: el panel del método PayPal seleccionado (como el de Shopify: ícono de «redirección»
//     y «Se te redirigirá a PayPal para que completes la compra»);
//   - PaypalButton: botón amarillo «Pagar con PayPal». Mientras el servidor crea la orden PayPal muestra la
//     pantalla «Te estamos llevando a PayPal» (monto, reserva del cupo, no cerrar la ventana) para que el médico
//     sepa qué está pasando antes de salir del sitio. Si vuelve con «Atrás» desde PayPal y el navegador restaura la
//     página congelada (bfcache), la recarga para mostrar el estado real del pedido.
import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import { LockIcon, PayPalWordmark } from "./icons";

/** Ícono de Shopify para «se abrirá otra página»: ventana con una flecha que sale. */
export function RedirectIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="-252.3 356.1 163 80.9" {...p}>
      <path fill="none" stroke="currentColor" strokeMiterlimit="10" strokeWidth="2" d="M-108.9 404.1v30c0 1.1-.9 2-2 2h-120.1c-1.1 0-2-.9-2-2v-75c0-1.1.9-2 2-2h120.1c1.1 0 2 .9 2 2v10.7" />
      <path fill="none" stroke="currentColor" strokeMiterlimit="10" strokeWidth="2" d="M-233 367.7h124.1" />
      <circle cx="-227.4" cy="362.4" r="1.5" fill="currentColor" />
      <circle cx="-222.2" cy="362.4" r="1.5" fill="currentColor" />
      <circle cx="-217.1" cy="362.4" r="1.5" fill="currentColor" />
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeMiterlimit="10" strokeWidth="2" d="M-128.7 400.1H-92m-3.6-4.1 4 4.1-4 4.1" />
    </svg>
  );
}

export function PaypalRedirectNotice({ amountLabel }: { amountLabel?: string }) {
  return (
    <div className="co-redirect-notice">
      <RedirectIcon className="co-redirect-icon" />
      <p>Se te redirigirá a PayPal para que completes la compra.</p>
      <p className="co-redirect-sub">
        Paga con tu cuenta PayPal o con tarjeta de débito o crédito{amountLabel ? <> · <strong>{amountLabel}</strong></> : null}.
      </p>
    </div>
  );
}

export interface PaypalHandoff {
  /** «$180.00 USD». */
  amountLabel: string;
  /** Minutos que el cupo queda reservado mientras paga (solo con programas semipresenciales). */
  holdMinutes?: number | null;
}

function Handoff({ amountLabel, holdMinutes }: PaypalHandoff) {
  return (
    <div className="co-handoff" role="status" aria-live="assertive" data-testid="paypal-handoff">
      <div className="co-handoff-card">
        <div className="co-handoff-mark" aria-hidden="true">
          <span className="co-handoff-ring" />
          <LockIcon />
        </div>
        <PayPalWordmark />
        <p className="co-handoff-title">Te estamos llevando a PayPal</p>
        <p className="co-handoff-text">
          Pagarás <strong>{amountLabel}</strong> en el sitio seguro de PayPal. Al terminar volverás a CEIUM para ver la confirmación de tu inscripción.
        </p>
        {holdMinutes ? <p className="co-handoff-hold">Tu cupo queda reservado {holdMinutes} minutos mientras pagas.</p> : null}
        <p className="co-handoff-foot">No cierres ni recargues esta ventana.</p>
      </div>
    </div>
  );
}

export function PaypalButton({ label = "Pagar con PayPal", disabled, handoff }: { label?: string; disabled?: boolean; handoff: PaypalHandoff }) {
  const { pending } = useFormStatus();
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return (
    <>
      <button type="submit" className="co-pay co-pay-paypal" disabled={disabled || pending} aria-label={label} data-pending={pending || undefined} data-testid="paypal-button">
        {pending ? (
          <span className="co-spinner" aria-hidden="true" />
        ) : (
          <>
            <span className="co-pay-with">Pagar con</span>
            <PayPalWordmark />
          </>
        )}
      </button>
      {pending ? <Handoff {...handoff} /> : null}
    </>
  );
}
