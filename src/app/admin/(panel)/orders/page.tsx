// Pedidos (panel): listado con vistas por estado y búsqueda. «En verificación» = pagos manuales con
// comprobante por revisar.
import type { Metadata } from "next";
import Link from "next/link";
import type { OrderStatus } from "@/server/db";
import { listAdminOrders } from "@/server/admin-orders";
import { services } from "@/server/services";
import { requireAdminPage } from "../../_lib/session";
import { ORDER_STATUS, dateTime, usd } from "./labels";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pedidos" };

const VIEWS: { key: OrderStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "Todos" },
  { key: "AWAITING_VERIFICATION", label: "En verificación" },
  { key: "PENDING_PAYMENT", label: "Pago pendiente" },
  { key: "ENROLLED", label: "Inscritos" },
  { key: "PAID", label: "Pagados" },
  { key: "PARTIALLY_PAID", label: "Pago parcial" },
  { key: "REJECTED", label: "Rechazados" },
  { key: "REFUNDED", label: "Reembolsados" },
  { key: "EXPIRED", label: "Vencidos" },
  { key: "CANCELLED", label: "Cancelados" },
];
const METHOD: Record<string, string> = { PAYPAL: "PayPal", PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia", ZELLE: "Zelle", EFECTIVO: "Efectivo" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

type SP = Record<string, string | string[] | undefined>;
export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdminPage("orders.view", "/admin/orders");
  const sp = await searchParams;
  const status = (VIEWS.find((v) => v.key === one(sp.status))?.key ?? "ALL") as OrderStatus | "ALL";
  const q = one(sp.q).slice(0, 100);
  const { rows, counts } = await listAdminOrders(services().deps, user, { status, q });
  const total = Object.values(counts).reduce((a, n) => a + (n ?? 0), 0);
  const link = (patch: { status?: string; q?: string }) => {
    const p = new URLSearchParams();
    const st = patch.status ?? status;
    const qq = patch.q ?? q;
    if (st && st !== "ALL") p.set("status", st);
    if (qq) p.set("q", qq);
    const s = p.toString();
    return s ? `/admin/orders?${s}` : "/admin/orders";
  };

  return (
    <div className="adm-page wide">
      <div className="adm-ph">
        <div className="grow">
          <h1>Pedidos</h1>
        </div>
      </div>
      {counts.AWAITING_VERIFICATION ? (
        <div className="banner attention" role="status">
          <span>
            <b>{counts.AWAITING_VERIFICATION}</b> {counts.AWAITING_VERIFICATION === 1 ? "pedido tiene" : "pedidos tienen"} un pago por verificar.{" "}
            <Link href={link({ status: "AWAITING_VERIFICATION" })} style={{ textDecoration: "underline" }}>Revisar</Link>
          </span>
        </div>
      ) : null}
      <div className="card card-flush">
        <nav className="ix-tabs" aria-label="Vistas de pedidos">
          {VIEWS.map((v) => (
            <Link key={v.key} href={link({ status: v.key })} className={`ix-tab${v.key === status ? " active" : ""}`} aria-current={v.key === status ? "page" : undefined}>
              {v.label} <span className="n">{v.key === "ALL" ? total : (counts[v.key] ?? 0)}</span>
            </Link>
          ))}
        </nav>
        <form className="ix-tools" action="/admin/orders" style={{ padding: "8px 12px", display: "flex", gap: 8 }}>
          {status !== "ALL" ? <input type="hidden" name="status" value={status} /> : null}
          <input className="inp" type="search" name="q" defaultValue={q} placeholder="Buscar por nº de pedido, correo, nombre, cédula o referencia" aria-label="Buscar pedidos" />
          <button className="btn btn-gray" type="submit">Buscar</button>
        </form>
        {rows.length === 0 ? (
          <div className="ix-empty">
            <h3>No hay pedidos en esta vista</h3>
            <p className="muted">Prueba con otra vista o búsqueda.</p>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="ix" data-testid="orders-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Programa</th>
                  <th>Método</th>
                  <th>Estado</th>
                  <th className="num">Total</th>
                  <th className="num">Pagado</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: "neutral" as const };
                  return (
                    <tr key={o.id} data-order-number={o.number}>
                      <td>
                        <Link className="title" href={`/admin/orders/${o.id}`}>#{o.number}</Link>
                      </td>
                      <td>{dateTime(o.placedAt)}</td>
                      <td>
                        <div>{o.customer.firstName} {o.customer.lastName}</div>
                        <div className="sub">{o.customer.email}</div>
                      </td>
                      <td className="c-title">
                        {o.items.map((i, k) => (
                          <div key={k}>
                            {i.title}
                            <div className="sub">{i.modality === "ONLINE" ? "Online" : ["Semipresencial", i.sede, i.cohort].filter(Boolean).join(" · ")}</div>
                          </div>
                        ))}
                      </td>
                      <td>{o.paymentMethod ? METHOD[o.paymentMethod] ?? o.paymentMethod : "—"}</td>
                      <td>
                        <span className={`badge ${st.tone}`}>{st.label}</span>
                        {o.awaitingVerification ? <div className="sub">{o.awaitingVerification} pago(s) por verificar</div> : null}
                      </td>
                      <td className="num mono">{usd(o.totalCents)}</td>
                      <td className="num mono">{usd(o.amountPaidCents)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
