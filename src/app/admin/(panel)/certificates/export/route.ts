// GET /admin/certificates/export?format=excel|plain&view=ISSUED|IN_PROGRESS|BLOCKED|REVOKED&q=…&diploma=…: CSV de
// certificados (emitidos o revocados) o de los diplomados en curso / bloqueados por saldo.
import { CERTIFICATE_VIEWS, exportCertificatesTable, type CertificateView } from "@/server/admin-learning";
import { services } from "@/server/services";
import { exportCsv, param } from "../../../_lib/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FILE: Record<CertificateView, string> = { ISSUED: "certificados-ceium", REVOKED: "certificados-revocados-ceium", IN_PROGRESS: "diplomados-en-curso-ceium", BLOCKED: "certificados-bloqueados-ceium" };

export function GET(req: Request) {
  return exportCsv(req, "orders.view", async ({ user, sp }) => {
    const v = param(sp, "view");
    const view = (v in CERTIFICATE_VIEWS ? v : "ISSUED") as CertificateView;
    return { name: FILE[view], ...(await exportCertificatesTable(services().deps, user, { view, q: param(sp, "q"), diploma: param(sp, "diploma", 40) || undefined })) };
  });
}
