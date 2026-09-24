// GET /admin/orders/export?view=…&status=…&method=…&modality=…&q=…&sort=…&dir=… | ?ids=a,b,c
// CSV de pedidos para Excel (solo con sesión del panel). Mismos filtros que el índice.
import type { OrderStatus, PaymentMethod } from "@/server/db";
import { ORDER_SORTS, ORDER_STATUSES, ORDER_VIEWS, PAYMENT_METHODS, exportOrdersCsv, type OrderSort, type OrderView } from "@/server/admin-order-views";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { currentAdmin } from "../../../_lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const list = <T extends string>(v: string | null, allowed: readonly T[]) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is T => (allowed as readonly string[]).includes(s));

export async function GET(req: Request) {
  const user = await currentAdmin();
  if (!user) return new Response("Inicia sesión en el panel.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  const sp = new URL(req.url).searchParams;
  const view = sp.get("view") ?? "ALL";
  const sort = sp.get("sort") ?? "number";
  try {
    const csv = await exportOrdersCsv(services().deps, user, {
      ids: (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9]{10,40}$/i.test(s)),
      view: (view in ORDER_VIEWS ? view : "ALL") as OrderView,
      status: list<OrderStatus>(sp.get("status"), ORDER_STATUSES),
      method: list<PaymentMethod>(sp.get("method"), PAYMENT_METHODS),
      modality: list(sp.get("modality"), ["ONLINE", "SEMIPRESENCIAL"] as const),
      q: (sp.get("q") ?? "").slice(0, 100),
      sort: (sort in ORDER_SORTS ? sort : "number") as OrderSort,
      dir: sp.get("dir") === "asc" ? "asc" : "desc",
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pedidos-ceium-${stamp}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
