// /checkout — pantalla de pago. Réplica del checkout de Shopify de ceium.net (dos columnas: formulario a la
// izquierda, resumen gris a la derecha; en móvil, resumen desplegable arriba), con lo que CEIUM necesita:
// datos del médico (nombre, apellidos, cédula, correo, teléfono, especialidad), método de pago y la reserva
// de cupo de los programas semipresenciales con su cuenta regresiva.
//   - Sin pedido en curso: formulario → `placeOrder` crea el pedido y reserva el cupo.
//   - Con pedido en curso (mismo carrito, reserva viva): cuenta regresiva + datos del pedido + cómo pagar.
// Todo sale de la BD (carrito recotizado, cohortes y cupos, métodos de pago configurados en el panel).
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckoutForm, type HoldCohort } from "@/components/checkout/CheckoutForm";
import { ChevronDownIcon } from "@/components/checkout/icons";
import { NextSteps, SummaryLines, SummaryTotalsBlock, usd } from "@/components/checkout/OrderSummary";
import { PendingPayment } from "@/components/checkout/PendingPayment";
import { payPendingWithPaypal, placeOrder } from "./actions";
import { getCheckoutView } from "./data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pantalla de pago" };

export default async function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? null;
  const view = await getCheckoutView();
  if (view.count === 0) redirect("/cart");

  const holds: HoldCohort[] = view.lines
    .filter((l) => l.cohort && !l.error)
    .map((l) => ({ title: l.title, cohort: l.cohort!.name, sede: l.cohort!.sede, dates: `${l.cohort!.startLabel} – ${l.cohort!.endLabel}`, available: l.cohort!.available }));
  const totals = { count: view.count, listCents: view.listCents, discountCents: view.discountCents, totalCents: view.totalCents, dueNowCents: view.pending?.dueNowCents ?? view.dueNowCents };
  const metodo = one("metodo")?.toUpperCase() ?? null;

  return (
    <div className="co-page">
      <details className="co-msum">
        <summary className="co-msum-bar">
          <span className="co-msum-toggle">
            <span className="co-msum-show">Resumen del pedido</span>
            <span className="co-msum-hide">Ocultar resumen</span>
            <ChevronDownIcon />
          </span>
          <strong className="co-msum-total">{usd(totals.dueNowCents)}</strong>
        </summary>
        <div className="co-msum-body">
          <SummaryLines lines={view.lines} />
          <SummaryTotalsBlock t={totals} />
        </div>
      </details>

      <div className="co-main" id="co-main">
        <div className="co-main-inner">
          {view.pending ? (
            <PendingPayment pending={view.pending} methods={view.methods} holds={holds} serverNow={new Date().toISOString()} justCreated={one("pedido") === "creado"} paypalCancelled={one("paypal") === "cancelado"} paypalHoldMinutes={view.ttl.paypalMinutes} payWithPaypal={payPendingWithPaypal} />
          ) : (
            <CheckoutForm action={placeOrder} methods={view.methods} initialMethod={metodo === "PAYPAL" ? "PAYPAL" : null} ttl={view.ttl} holds={holds} dueNowCents={view.dueNowCents} count={view.count} blocked={view.blocked} />
          )}
          <footer className="co-footer">
            <Link href="/cart">Volver al carrito</Link>
            <Link href="/policies/privacy-policy">Política de privacidad</Link>
            <Link href="/pages/contacto">Contacto</Link>
          </footer>
        </div>
      </div>

      <aside className="co-aside" aria-label="Resumen del pedido">
        <div className="co-aside-inner">
          <SummaryLines lines={view.lines} />
          <SummaryTotalsBlock t={totals} />
          <NextSteps semipresencial={view.hasSemipresencial} />
        </div>
      </aside>
    </div>
  );
}
