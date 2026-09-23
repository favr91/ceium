// Página intermedia del enlace "Pagar con PayPal" del recordatorio de cuota. El GET solo muestra la cuota;
// el pago se inicia con un POST (botón), así los escáneres de enlaces de correo no crean ni cancelan
// intentos de PayPal (ver actions.ts).
import type { Metadata } from "next";
import Link from "next/link";
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";
import { formatUSD } from "@/server/pricing";
import { payInstallmentWithPaypal } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pagar cuota", robots: { index: false, follow: false } };

const box: React.CSSProperties = { maxWidth: 520, margin: "48px auto", padding: "32px 24px", border: "1px solid rgba(0,30,43,0.12)", borderRadius: 12, background: "#fff" };
const h1: React.CSSProperties = { color: "var(--ink)", fontSize: 24, lineHeight: 1.25, margin: "0 0 8px" };
const btn: React.CSSProperties = { display: "block", width: "100%", padding: "14px 20px", border: 0, borderRadius: 8, background: "var(--teal)", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 16, padding: "8px 0", borderBottom: "1px solid rgba(0,30,43,0.08)" };

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
      <main style={{ padding: "0 16px" }}>
        <section style={box}>
          <h1 style={h1}>Enlace no válido</h1>
          <p>No encontramos esta cuota. Revisa el enlace del correo o escríbenos para ayudarte.</p>
        </section>
      </main>
    );
  }
  const pending = Math.max(0, Math.min(ins.amountCents - ins.paidCents, order.balanceCents));
  const settled = ins.status === "PAID" || ins.status === "WAIVED" || pending <= 0;
  const next = order.installments.find((i) => i.status === "PENDING" || i.status === "OVERDUE");
  const blockedBy = !settled && next && next.id !== ins.id ? next : null;
  const action = payInstallmentWithPaypal.bind(null, token, installmentId);

  return (
    <main style={{ padding: "0 16px" }}>
      <section style={box}>
        <p style={{ margin: "0 0 4px", fontSize: 14 }}>Pedido #{order.number}</p>
        <h1 style={h1}>
          Cuota {ins.sequence} de {order.installments.length}
        </h1>
        <div style={{ margin: "16px 0 24px" }}>
          {ins.course?.title ? (
            <div style={row}>
              <span>Curso</span>
              <strong style={{ color: "var(--ink)", textAlign: "right" }}>{ins.course.title}</strong>
            </div>
          ) : null}
          <div style={row}>
            <span>Monto de la cuota</span>
            <strong style={{ color: "var(--ink)" }}>{formatUSD(pending)}</strong>
          </div>
          <div style={row}>
            <span>Saldo del pedido</span>
            <span>{formatUSD(Math.max(0, order.balanceCents))}</span>
          </div>
        </div>
        {settled ? (
          <p>Esta cuota ya está pagada. ¡Gracias!</p>
        ) : blockedBy ? (
          <p>Primero debes pagar la cuota {blockedBy.sequence}.</p>
        ) : (
          <form action={action}>
            <button type="submit" style={btn}>
              Pagar {formatUSD(pending)} con PayPal
            </button>
            <p style={{ fontSize: 13, marginTop: 12 }}>Te llevaremos a PayPal para completar el pago de forma segura.</p>
          </form>
        )}
        <p style={{ marginTop: 20, fontSize: 14 }}>
          <Link href={orderUrl} style={{ color: "var(--teal)" }}>
            Ver mi pedido
          </Link>
        </p>
      </section>
    </main>
  );
}
