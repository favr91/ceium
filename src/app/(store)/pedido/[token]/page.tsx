// Página del pedido para el comprador (/pedido/[token]). Destino de:
//   - return/cancel de PayPal: ?paypal=completado|pendiente|fallido|cancelado|error
//   - errores al iniciar un pago: ?pago=error&motivo=…   · pago manual registrado: ?pago=registrado
//   - enlace «estado de tu pedido» de los correos
//   - enlace de pago manual de una cuota: ?cuota=<installmentId>#pagar
// Muestra estado, programas, cuotas y cómo pagar lo que falta. La tienda (réplica de ceium.net) la re-estiliza.
import type { Metadata } from "next";
import Link from "next/link";
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";
import { formatUSD } from "@/server/pricing";
import { formatDate, formatVES } from "@/server/email/templates";
import { payOrderWithPaypal, reportManualPayment } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tu pedido", robots: { index: false, follow: false } };

const wrap: React.CSSProperties = { maxWidth: 720, margin: "40px auto", padding: "0 16px" };
const card: React.CSSProperties = { padding: "24px", border: "1px solid rgba(0,30,43,0.12)", borderRadius: 12, background: "#fff", marginBottom: 20 };
const h1: React.CSSProperties = { color: "var(--ink)", fontSize: 26, lineHeight: 1.25, margin: "0 0 4px" };
const h2: React.CSSProperties = { color: "var(--ink)", fontSize: 18, margin: "0 0 12px" };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: 16, padding: "8px 0", borderBottom: "1px solid rgba(0,30,43,0.08)" };
const btn: React.CSSProperties = { display: "block", width: "100%", padding: "14px 20px", border: 0, borderRadius: 8, background: "var(--teal)", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" };
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", border: "1px solid rgba(0,30,43,0.25)", borderRadius: 6, fontSize: 15, boxSizing: "border-box" };
const label: React.CSSProperties = { display: "block", fontSize: 14, margin: "12px 0 4px", color: "var(--ink)" };

const STATUS: Record<string, string> = {
  PENDING_PAYMENT: "Pendiente de pago",
  AWAITING_VERIFICATION: "Pago en verificación",
  PARTIALLY_PAID: "Pago parcial recibido",
  PAID: "Pagado",
  ENROLLED: "Inscrito",
  REJECTED: "Pago rechazado",
  CANCELLED: "Cancelado",
  EXPIRED: "Vencido",
  REFUNDED: "Reembolsado",
};
const INSTALLMENT: Record<string, string> = { PENDING: "Pendiente", PAID: "Pagada", OVERDUE: "Vencida", WAIVED: "Exonerada" };

const PAYPAL_BANNER: Record<string, { tone: "ok" | "info" | "error"; text: string }> = {
  completado: { tone: "ok", text: "¡Pago recibido! Te enviamos la confirmación y el acceso a la plataforma por correo." },
  pendiente: { tone: "info", text: "PayPal está revisando tu pago. Te avisaremos por correo en cuanto se confirme; no hace falta pagar de nuevo." },
  fallido: { tone: "error", text: "PayPal no aprobó el pago. Puedes intentarlo de nuevo o elegir otro método." },
  cancelado: { tone: "info", text: "Cancelaste el pago en PayPal. Tu pedido sigue abierto: puedes pagarlo cuando quieras." },
  error: { tone: "error", text: "No pudimos confirmar el pago con PayPal. Si se te cobró, no pagues de nuevo: escríbenos y lo revisamos." },
};
const TONE: Record<string, React.CSSProperties> = {
  ok: { background: "#e6f7f7", borderColor: "#09B0B0" },
  info: { background: "#f3f6f8", borderColor: "rgba(0,30,43,0.2)" },
  error: { background: "#fdecec", borderColor: "#d93025" },
};

function Banner({ tone, children }: { tone: "ok" | "info" | "error"; children: React.ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} style={{ ...TONE[tone], border: "1px solid", borderRadius: 8, padding: "12px 16px", marginBottom: 20 }}>
      {children}
    </div>
  );
}

export default async function OrderPage({ params, searchParams }: PageProps<"/pedido/[token]">) {
  const { token } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? null;
  const s = services();
  let order: Awaited<ReturnType<typeof s.orders.getOrderByToken>> | null;
  try {
    order = await s.orders.getOrderByToken(token);
  } catch (e) {
    if (!isDomainError(e)) throw e;
    order = null;
  }
  if (!order) {
    return (
      <main style={wrap}>
        <section style={card}>
          <h1 style={h1}>Pedido no encontrado</h1>
          <p>Revisa el enlace del correo o escríbenos para ayudarte.</p>
        </section>
      </main>
    );
  }

  const paypal = one("paypal");
  const pago = one("pago");
  const motivo = one("motivo");
  const cuotaId = one("cuota");
  const cuota = cuotaId ? order.installments.find((i) => i.id === cuotaId) ?? null : null;
  const nextIns = order.installments.find((i) => i.status === "PENDING" || i.status === "OVERDUE") ?? null;
  const target = cuota && (cuota.status === "PENDING" || cuota.status === "OVERDUE") ? cuota : nextIns;

  const closed = ["CANCELLED", "EXPIRED", "REFUNDED", "REJECTED"].includes(order.status);
  const awaiting = order.payments.some((p) => p.status === "AWAITING_VERIFICATION");
  const firstPayment = order.status === "PENDING_PAYMENT";
  const amountDueCents = closed
    ? 0
    : firstPayment
      ? Math.max(0, order.dueNowCents - order.amountPaidCents)
      : target
        ? Math.max(0, Math.min(target.amountCents - target.paidCents, order.balanceCents))
        : Math.max(0, order.balanceCents);
  const canPay = !closed && amountDueCents > 0 && !(firstPayment && awaiting);
  const blockedCuota = cuota && target && cuota.id !== target.id && (cuota.status === "PENDING" || cuota.status === "OVERDUE") ? target : null;

  const options = canPay ? await s.orders.listPaymentOptions() : [];
  const hasPaypal = options.some((o) => o.method === "PAYPAL");
  const manual = options.filter((o) => o.method !== "PAYPAL");
  const payPaypal = payOrderWithPaypal.bind(null, token, !firstPayment && target ? target.id : null);
  const payManual = reportManualPayment.bind(null, token, cuotaId);

  return (
    <main style={wrap}>
      {paypal && PAYPAL_BANNER[paypal] ? <Banner tone={PAYPAL_BANNER[paypal].tone}>{PAYPAL_BANNER[paypal].text}</Banner> : null}
      {pago === "error" ? <Banner tone="error">{motivo || "No pudimos procesar el pago. Intenta de nuevo."}</Banner> : null}
      {pago === "registrado" ? <Banner tone="ok">Recibimos los datos de tu pago. Lo verificaremos y te avisaremos por correo.</Banner> : null}

      <section style={card}>
        <p style={{ margin: "0 0 4px", fontSize: 14 }}>Pedido #{order.number}</p>
        <h1 style={h1}>{STATUS[order.status] ?? order.status}</h1>
        {awaiting ? <p style={{ margin: "8px 0 0" }}>Tenemos un pago tuyo en verificación. Te avisaremos por correo al aprobarlo.</p> : null}
        <div style={{ marginTop: 16 }}>
          {order.items.map((it) => (
            <div key={it.id} style={row}>
              <span>
                <strong style={{ color: "var(--ink)" }}>{it.productTitle}</strong>
                <br />
                <span style={{ fontSize: 14 }}>
                  {it.modality === "ONLINE" ? "Online" : `Semipresencial${it.sede ? ` · ${it.sede.name}` : ""}`}
                  {it.cohort ? ` · ${it.cohort.name} (${formatDate(it.cohort.startDate)} – ${formatDate(it.cohort.endDate)})` : ""}
                  {it.planLabel ? ` · ${it.planLabel}` : ""}
                </span>
              </span>
              <span>{formatUSD(it.totalCents)}</span>
            </div>
          ))}
          <div style={row}>
            <span>Pagado</span>
            <span>{formatUSD(order.amountPaidCents)}</span>
          </div>
          <div style={{ ...row, borderBottom: 0 }}>
            <strong style={{ color: "var(--ink)" }}>Saldo pendiente</strong>
            <strong style={{ color: "var(--ink)" }}>{formatUSD(Math.max(0, order.balanceCents))}</strong>
          </div>
        </div>
      </section>

      {order.installments.length > 1 ? (
        <section style={card}>
          <h2 style={h2}>Cuotas</h2>
          {order.installments.map((i) => (
            <div key={i.id} id={`cuota-${i.id}`} style={{ ...row, ...(cuota?.id === i.id ? { background: "#f3f6f8" } : {}) }}>
              <span>
                Cuota {i.sequence}
                {i.course ? ` · ${i.course.title}` : ""}
                {i.dueDate ? <span style={{ fontSize: 14 }}> · vence {formatDate(i.dueDate)}</span> : null}
              </span>
              <span>
                {formatUSD(i.amountCents)} · {INSTALLMENT[i.status] ?? i.status}
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {canPay ? (
        <section style={card} id="pagar">
          <h2 style={h2}>
            {firstPayment ? "Completa tu pago" : target ? `Pagar la cuota ${target.sequence}${target.course ? ` · ${target.course.title}` : ""}` : "Pagar el saldo"}
          </h2>
          {blockedCuota ? <p>Primero debes pagar la cuota {blockedCuota.sequence}.</p> : null}
          <p>
            Monto a pagar: <strong style={{ color: "var(--ink)" }}>{formatUSD(amountDueCents)}</strong>
          </p>
          {hasPaypal ? (
            <form action={payPaypal} style={{ margin: "16px 0" }}>
              <button type="submit" style={btn}>
                Pagar {formatUSD(amountDueCents)} con PayPal
              </button>
            </form>
          ) : null}
          {manual.length ? (
            <form action={payManual} encType="multipart/form-data">
              <h2 style={{ ...h2, marginTop: 24 }}>¿Pagaste por pago móvil o transferencia?</h2>
              {manual.map((m, idx) => (
                <details key={m.method} open={idx === 0} style={{ margin: "8px 0", padding: "8px 12px", border: "1px solid rgba(0,30,43,0.12)", borderRadius: 8 }}>
                  <summary style={{ cursor: "pointer", color: "var(--ink)", fontWeight: 600 }}>
                    {m.label}
                    {m.currency === "VES" && m.vesPerUsd ? ` — ${formatVES(Math.round(amountDueCents * m.vesPerUsd))}` : ""}
                  </summary>
                  <ul style={{ margin: "8px 0", paddingLeft: 18 }}>
                    {Object.entries(m.details ?? {}).map(([k, v]) => (
                      <li key={k}>
                        <span style={{ textTransform: "capitalize" }}>{k}</span>: <strong>{v}</strong>
                      </li>
                    ))}
                  </ul>
                  {m.currency === "VES" && m.vesPerUsd ? <p style={{ fontSize: 14 }}>Tasa: Bs. {m.vesPerUsd.toLocaleString("es-VE")} por USD.</p> : null}
                  {m.instructions ? <p style={{ fontSize: 14 }}>{m.instructions}</p> : null}
                </details>
              ))}
              <label style={label} htmlFor="method">
                Método
              </label>
              <select id="method" name="method" required style={input} defaultValue={manual[0].method}>
                {manual.map((m) => (
                  <option key={m.method} value={m.method}>
                    {m.label} ({m.currency === "VES" ? "Bs." : "USD"})
                  </option>
                ))}
              </select>
              <label style={label} htmlFor="reference">
                Número de referencia
              </label>
              <input id="reference" name="reference" required style={input} inputMode="numeric" autoComplete="off" />
              <label style={label} htmlFor="amount">
                Monto pagado (en la moneda del método)
              </label>
              <input id="amount" name="amount" required style={input} inputMode="decimal" placeholder="0,00" />
              <label style={label} htmlFor="bank">
                Banco de origen
              </label>
              <input id="bank" name="bank" style={input} />
              <label style={label} htmlFor="paidAt">
                Fecha del pago
              </label>
              <input id="paidAt" name="paidAt" type="date" style={input} />
              <label style={label} htmlFor="payerCedula">
                Cédula del titular
              </label>
              <input id="payerCedula" name="payerCedula" style={input} />
              <label style={label} htmlFor="proof">
                Comprobante (imagen o PDF, máx. 10 MB)
              </label>
              <input id="proof" name="proof" type="file" accept="image/*,application/pdf" style={input} />
              <button type="submit" style={{ ...btn, marginTop: 20 }}>
                Enviar datos del pago
              </button>
            </form>
          ) : null}
          {!hasPaypal && !manual.length ? <p>En este momento no hay métodos de pago disponibles. Escríbenos para ayudarte.</p> : null}
        </section>
      ) : null}

      <p style={{ fontSize: 14 }}>
        <Link href="/" style={{ color: "var(--teal)" }}>
          Volver a la tienda
        </Link>
      </p>
    </main>
  );
}
