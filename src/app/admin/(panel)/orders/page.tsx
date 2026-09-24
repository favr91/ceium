// Pedidos (panel): réplica del índice de Pedidos de Shopify — métricas de los últimos 30 días, aviso de pagos
// por verificar, pestañas (Todos, Por verificar, Pago pendiente, Con saldo, Inscritos, Reembolsados,
// Cerrados), búsqueda, filtros, orden, selección con exportación CSV y paginación. Todo sale de la BD.
import type { Metadata } from "next";
import Link from "next/link";
import type { OrderStatus, PaymentMethod } from "@/server/db";
import { ORDER_SORTS, ORDER_STATUSES, ORDER_VIEWS, PAYMENT_METHODS, listOrdersIndex, orderMetrics, type OrderSort, type OrderView } from "@/server/admin-order-views";
import { services } from "@/server/services";
import { Icon } from "@/components/admin/Icon";
import { OrdersIndex } from "@/components/admin/orders/OrdersIndex";
import { toQuery, type IndexState } from "@/components/admin/orders/query";
import { Sparkline } from "@/components/admin/orders/bits";
import { usd } from "@/components/admin/orders/format";
import "@/components/admin/orders/orders.css";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pedidos" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const list = <T extends string>(v: string | string[] | undefined, allowed: readonly T[]) =>
  one(v)
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdminPage("orders.view", "/admin/orders");
  const sp = await searchParams;
  const viewKeys = Object.keys(ORDER_VIEWS) as OrderView[];
  let view = (viewKeys as string[]).includes(one(sp.view)) ? (one(sp.view) as OrderView) : "ALL";
  let status = list<OrderStatus>(sp.status, ORDER_STATUSES);
  // Enlaces antiguos /admin/orders?status=AWAITING_VERIFICATION → la pestaña equivalente.
  if (!one(sp.view) && status.length === 1 && (viewKeys as string[]).includes(status[0])) {
    view = status[0] as OrderView;
    status = [];
  }
  const state: IndexState = {
    view,
    status,
    method: list<PaymentMethod>(sp.method, PAYMENT_METHODS),
    modality: list(sp.modality, ["ONLINE", "SEMIPRESENCIAL"] as const),
    q: one(sp.q).slice(0, 100),
    sort: (Object.keys(ORDER_SORTS) as string[]).includes(one(sp.sort)) ? one(sp.sort) : "number",
    dir: one(sp.dir) === "asc" ? "asc" : "desc",
    page: Math.max(1, Number(one(sp.page)) || 1),
  };
  const d = services().deps;
  const [idx, m] = await Promise.all([
    listOrdersIndex(d, user, {
      view: state.view as OrderView,
      status: state.status as OrderStatus[],
      method: state.method as PaymentMethod[],
      modality: state.modality as ("ONLINE" | "SEMIPRESENCIAL")[],
      q: state.q,
      sort: state.sort as OrderSort,
      dir: state.dir,
      page: state.page,
    }),
    orderMetrics(d, user, 30),
  ]);
  const awaiting = m.awaiting.count;

  return (
    <div className="adm-page wide">
      <div className="op-head">
        <h1>
          <Icon name="order" /> Pedidos
        </h1>
        <a className="btn btn-gray" href={`/admin/orders/export${toQuery(state, { page: 1 })}`} download>
          Exportar
        </a>
        {awaiting ? (
          <Link className="btn btn-primary" href="/admin/orders?view=AWAITING_VERIFICATION">
            Verificar pagos
          </Link>
        ) : null}
      </div>

      {awaiting ? (
        <div className="banner attention" role="status">
          <Icon name="alert" />
          <span>
            <b>{awaiting === 1 ? "1 pago manual por verificar" : `${awaiting} pagos manuales por verificar`}</b> ({usd(m.awaiting.cents)}). Revisa cada comprobante y apruébalo o recházalo: el cupo del médico queda reservado mientras tanto.{" "}
            <Link href="/admin/orders?view=AWAITING_VERIFICATION" style={{ textDecoration: "underline" }}>Revisar</Link>
          </span>
        </div>
      ) : null}

      <section className="om-bar" aria-label="Resumen de los últimos 30 días">
        <div className="om-range">
          <span className="btn" aria-label="Periodo">
            <Icon name="cohort" size={16} /> Últimos 30 días
          </span>
        </div>
        <Link className="om-cell" href="/admin/orders?sort=date">
          <span className="l">Pedidos</span>
          <span className="v" data-testid="metric-orders">{m.orders.count}</span>
          <Sparkline values={m.orders.series} />
        </Link>
        <div className="om-cell">
          <span className="l">Cobrado</span>
          <span className="v" data-testid="metric-collected">{usd(m.collected.cents)}</span>
          <Sparkline values={m.collected.series} />
        </div>
        <Link className={`om-cell${awaiting ? " alert" : ""}`} href="/admin/orders?view=AWAITING_VERIFICATION">
          <span className="l">Por verificar</span>
          <span className="v" data-testid="metric-awaiting">
            {awaiting} <small>{usd(m.awaiting.cents)}</small>
          </span>
        </Link>
        <Link className="om-cell" href="/admin/orders?view=BALANCE">
          <span className="l">Saldo por cobrar</span>
          <span className="v">
            {usd(m.balance.cents)} <small>{m.balance.count} {m.balance.count === 1 ? "pedido" : "pedidos"}</small>
          </span>
        </Link>
        <Link className="om-cell" href="/admin/orders?view=REFUNDED">
          <span className="l">Reembolsado</span>
          <span className="v">
            {usd(m.refunded.cents)} <small>{m.refunded.count}</small>
          </span>
        </Link>
      </section>

      <OrdersIndex
        rows={idx.rows}
        counts={idx.counts}
        views={viewKeys.map((k) => ({ key: k, label: ORDER_VIEWS[k].label }))}
        sorts={Object.entries(ORDER_SORTS).map(([key, label]) => ({ key, label }))}
        total={idx.total}
        page={idx.page}
        pages={idx.pages}
        perPage={idx.perPage}
        state={state}
        now={new Date().toISOString()}
      />
      <p className="oi-learn">
        Los pagos con PayPal se confirman solos; los pagos móviles y transferencias esperan tu verificación.
      </p>
    </div>
  );
}
