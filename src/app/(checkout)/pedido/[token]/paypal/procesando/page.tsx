// «Confirmando tu pago»: la pantalla que ve el médico al volver de PayPal mientras se captura el cobro.
// El retorno de PayPal (/pedido/[token]/paypal/retorno) trae aquí al navegador; esta página vuelve de inmediato
// al retorno con &confirmar=1 (reemplazando la entrada del historial) y el navegador la mantiene visible hasta
// que la captura termina y llega la confirmación. Sin JavaScript, un meta refresh hace lo mismo.
import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/server/db";
import { usd } from "@/components/checkout/OrderSummary";
import { ContinueTo } from "@/components/checkout/ContinueTo";
import { CheckIcon, LockIcon } from "@/components/checkout/icons";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirmando tu pago", robots: { index: false, follow: false } };

export default async function PaypalProcessingPage({ params, searchParams }: PageProps<"/pedido/[token]/paypal/procesando">) {
  const { token } = await params;
  const sp = await searchParams;
  const paypalOrderId = typeof sp.token === "string" ? sp.token : "";
  const orderHref = `/pedido/${encodeURIComponent(token)}`;
  const confirmHref = `${orderHref}/paypal/retorno?${new URLSearchParams({ token: paypalOrderId, confirmar: "1" })}`;

  const payment = paypalOrderId
    ? await prisma.payment.findFirst({ where: { paypalOrderId, order: { token } }, select: { amountCents: true, installment: { select: { sequence: true } }, order: { select: { number: true, items: { select: { modality: true } } } } } })
    : null;
  const semi = payment?.order.items.some((i) => i.modality === "SEMIPRESENCIAL") ?? false;

  return (
    <main className="co-process" id="co-main" data-testid="paypal-processing">
      {paypalOrderId ? (
        <>
          <ContinueTo href={confirmHref} />
          <noscript>
            <meta httpEquiv="refresh" content={`0;url=${confirmHref}`} />
          </noscript>
        </>
      ) : null}
      <div className="co-process-card" role="status" aria-live="polite">
        <div className="co-process-mark" aria-hidden="true">
          <span className="co-handoff-ring" />
          <LockIcon />
        </div>
        {payment ? <p className="co-process-eyebrow">Pedido #{payment.order.number}</p> : null}
        <h1 className="co-process-title">Confirmando tu pago</h1>
        <p className="co-process-text">
          PayPal aprobó tu pago{payment ? <> de <strong>{usd(payment.amountCents)} USD</strong></> : null}
          {payment?.installment ? ` (cuota ${payment.installment.sequence})` : ""}. Lo estamos confirmando y preparando tu inscripción: solo toma unos segundos.
        </p>
        <ol className="co-process-steps">
          <li data-state="done">
            <span className="co-step-dot" aria-hidden="true">
              <CheckIcon />
            </span>
            Pago aprobado en PayPal
          </li>
          <li data-state="active" aria-current="step">
            <span className="co-step-dot" aria-hidden="true" />
            Confirmando el cobro{semi ? " y tu cupo" : ""}
          </li>
          <li data-state="todo">
            <span className="co-step-dot" aria-hidden="true" />
            Acceso al aula virtual por correo
          </li>
        </ol>
        <p className="co-process-foot">No cierres ni recargues esta ventana. No se te cobrará dos veces.</p>
        <noscript>
          <p className="co-process-foot">
            <Link href={confirmHref}>Continuar</Link>
          </p>
        </noscript>
      </div>
    </main>
  );
}
