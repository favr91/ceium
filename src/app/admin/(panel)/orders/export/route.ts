// GET /admin/orders/export?format=excel|plain & (ids=a,b | page=N | view=…&status=…&method=…&modality=…&q=…&sort=…&dir=…)
// CSV de pedidos (solo con sesión del panel). Mismos filtros y orden que el índice.
import type { OrderStatus, PaymentMethod } from "@/server/db";
import { ORDER_SORTS, ORDER_STATUSES, ORDER_VIEWS, PAYMENT_METHODS, exportOrdersTable, type OrderSort, type OrderView } from "@/server/admin-order-views";
import { services } from "@/server/services";
import { exportCsv, param } from "../../../_lib/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const list = <T extends string>(v: string | null, allowed: readonly T[]) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

export function GET(req: Request) {
  return exportCsv(req, "orders.view", async ({ user, sp, ids, page }) => {
    const view = param(sp, "view");
    const sort = param(sp, "sort");
    const t = await exportOrdersTable(services().deps, user, {
      ids,
      page,
      view: (view in ORDER_VIEWS ? view : "ALL") as OrderView,
      status: list<OrderStatus>(sp.get("status"), ORDER_STATUSES),
      method: list<PaymentMethod>(sp.get("method"), PAYMENT_METHODS),
      modality: list(sp.get("modality"), ["ONLINE", "SEMIPRESENCIAL"] as const),
      q: param(sp, "q"),
      sort: (sort in ORDER_SORTS ? sort : "number") as OrderSort,
      dir: sp.get("dir") === "asc" ? "asc" : "desc",
    });
    return { name: "pedidos-ceium", ...t };
  });
}
