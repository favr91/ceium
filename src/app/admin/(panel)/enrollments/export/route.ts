// GET /admin/enrollments/export?format=excel|plain & (ids=… | page=N | view=…&q=…&program=…&sort=…&dir=…): CSV de matrículas.
import { ENROLLMENT_SORTS, ENROLLMENT_VIEWS, exportEnrollmentsTable, type EnrollmentSort, type EnrollmentView } from "@/server/admin-learning";
import { services } from "@/server/services";
import { exportCsv, param } from "../../../_lib/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request) {
  return exportCsv(req, "orders.view", async ({ user, sp, ids, page }) => {
    const view = param(sp, "view");
    const sort = param(sp, "sort");
    return {
      name: "matriculas-ceium",
      ...(await exportEnrollmentsTable(services().deps, user, {
        ids,
        page,
        view: (view in ENROLLMENT_VIEWS ? view : "ALL") as EnrollmentView,
        q: param(sp, "q"),
        program: param(sp, "program", 40) || undefined,
        sort: (sort in ENROLLMENT_SORTS ? sort : "recent") as EnrollmentSort,
        dir: sp.get("dir") === "asc" ? "asc" : "desc",
      })),
    };
  });
}
