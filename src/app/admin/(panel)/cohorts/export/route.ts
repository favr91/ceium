// GET /admin/cohorts/export?format=excel|plain & (ids=… | page=N | view=…&sede=…&product=…&period=…&q=…&sort=…): CSV
// de cohortes con cupos. Mismos filtros y orden que el índice (queryCohorts).
import { exportCsv } from "../../../_lib/export";
import { cohortsTable, listCohortRows, queryCohorts, sedeOptions } from "../data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE = 50; // igual que el índice

export function GET(req: Request) {
  return exportCsv(req, "cohorts.manage", async ({ sp, ids, page }) => {
    const [all, sedes] = await Promise.all([listCohortRows(), sedeOptions()]);
    let rows = ids ? all.filter((r) => ids.includes(r.id)) : queryCohorts(all, sedes, (k) => (sp.get(k) ?? "").trim()).rows;
    if (page && !ids) rows = rows.slice((page - 1) * PAGE, page * PAGE);
    return { name: "cohortes-ceium", ...cohortsTable(rows) };
  });
}
