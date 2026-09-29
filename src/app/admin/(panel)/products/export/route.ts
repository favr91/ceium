// GET /admin/products/export?format=excel|plain & (ids=… | status=…&category=…&q=…&sort=…): CSV de programas con su
// lista de precios. Mismos filtros y orden que el índice (listProductRows).
import type { Category, Status } from "@/components/admin/products/types";
import { exportCsv, param } from "../../../_lib/export";
import { listProductRows, PRODUCT_CATEGORIES, PRODUCT_STATUSES, productsTable } from "../data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  // El catálogo lo consulta todo el equipo (el personal lo ve en solo lectura).
  return exportCsv(req, "orders.view", async ({ sp, ids }) => {
    const status = param(sp, "status");
    const category = param(sp, "category");
    const { rows } = await listProductRows({
      q: param(sp, "q"),
      status: (PRODUCT_STATUSES as readonly string[]).includes(status) ? (status as Status | "ALL") : "ALL",
      category: (PRODUCT_CATEGORIES as readonly string[]).includes(category) ? (category as Category | "ALL") : "ALL",
      sort: param(sp, "sort") || "position",
    });
    return { name: "programas-ceium", ...(await productsTable(ids ? rows.filter((r) => ids.includes(r.id)) : rows)) };
  });
}
