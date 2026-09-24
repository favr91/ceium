// Página intermedia del enlace "Pagar con PayPal" del recordatorio de cuota. El GET solo muestra la cuota;
// el pago se inicia con un POST (botón), así los escáneres de enlaces de correo no crean ni cancelan
// intentos de PayPal (ver actions.ts).
import type { Metadata } from "next";
import Link from "next/link";
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";
import { formatUSD } from "@/server/pricing";
import { PaypalButton } from "@/components/checkout/paypal";
import { LockIcon } from "@/components/checkout/icons";
import { payInstallmentWithPaypal } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pagar cuota", robots: { index: false, follow: false } };

export default async function PayInstallmentPage({ params }: PageProps<"/pedido/[token]/cuota/[installmentId]/paypal">) {
  const { token, installmentId } = await params;
  const orderUrl = `/pedido/${encodeURIComponent(token)}`;
  let order: Awaited<ReturnType<ReturnType<typeof services>["orders"]["getOrderByToken"]>> | null;
  try {
    order = await services().orders.getOrderByToken(token);
  } catch (e) {
    if (!isDomainError(e)) throw e;
    order = null;
  }
  const ins = order?.installments.find((i) => i.id === installmentId);
  if (!order || !ins) {
    return (
      <main className="co-process" id="co-main">
        <div className="co-process-card">
          <h1 className="co-process-title">Enlace no válido</h1>
          <p className="co-process-text">No encontramos esta cuota. Revisa el enlace del correo o escríbenos para ayudarte.</p>
        </div>
      </main>
    );
  }
  const pending = Math.max(0, Math.min(ins.amountCents - ins.paidCents, order.balanceCents));
  const settled = ins.status === "PAID" || ins.status === "WAIVED" || pending <= 0;
  const next = order.installments.find((i) => i.status === "PENDING" || i.status === "OVERDUE");
  const blockedBy = !settled && next && next.id !== ins.id ? next : null;
  const action = payInstallmentWithPaypal.bind(null, token, installmentId);

  return (
    <main className="co-process" id="co-main">
      <div className="co-process-card co-cuota">
        <p className="co-process-eyebrow">Pedido #{order.number}</p>
        <h1 className="co-process-title">
          Cuota {ins.sequence} de {order.installments.length}
        </h1>
        <dl className="co-review">
          {ins.course?.title ? (
            <div>
              <dt>Curso</dt>
              <dd>{ins.course.title}</dd>
            </div>
          ) : null}
          <div>
            <dt>Monto de la cuota</dt>
            <dd>
              <strong>{formatUSD(pending)}</strong>
            </dd>
          </div>
          <div>
            <dt>Saldo del pedido</dt>
            <dd>{formatUSD(Math.max(0, order.balanceCents))}</dd>
          </div>
        </dl>
        {settled ? (
          <p className="co-process-text">Esta cuota ya está pagada. ¡Gracias!</p>
        ) : blockedBy ? (
          <p className="co-process-text">Primero debes pagar la cuota {blockedBy.sequence}.</p>
        ) : (
          <form action={action} className="co-pay-form">
            <PaypalButton label={`Pagar ${formatUSD(pending)} con PayPal`} handoff={{ amountLabel: `${formatUSD(pending)} USD` }} />
            <p className="co-secure">
              <LockIcon />
              Te llevaremos a PayPal para completar el pago de forma segura.
            </p>
          </form>
        )}
        <p className="co-process-foot">
          <Link href={orderUrl}>Ver mi pedido</Link>
        </p>
      </div>
    </main>
  );
}
