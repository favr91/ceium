// GET /admin/cohorts/<id>/export?format=excel|plain[&all=1]: lista de alumnos de la cohorte (quienes ocupan cupo;
// con all=1 también las reservas liberadas y vencidas).
import { exportCsv } from "../../../../_lib/export";
import { cohortRosterTable } from "../../data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return exportCsv(req, "cohorts.manage", ({ sp }) => cohortRosterTable(id, sp.get("all") === "1"));
}
