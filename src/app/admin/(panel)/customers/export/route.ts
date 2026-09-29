// GET /admin/customers/export?format=excel|plain & (ids=… | page=N | q=…): CSV de clientes (médicos).
import { exportCustomersTable } from "@/server/admin-learning";
import { services } from "@/server/services";
import { exportCsv, param } from "../../../_lib/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return exportCsv(req, "orders.view", async ({ user, sp, ids, page }) => ({
    name: "clientes-ceium",
    ...(await exportCustomersTable(services().deps, user, { ids, page, q: param(sp, "q") })),
  }));
}
