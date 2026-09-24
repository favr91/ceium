// Certificados (panel): emitidos (código verificable, entrega, PDF, reenviar, revocar), médicos cursando un
// diplomado con su avance por curso, los bloqueados por saldo y los revocados. Todo sale de la BD.
import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/server/auth";
import { CERTIFICATE_VIEWS, listCertificatesIndex, type CertificateView } from "@/server/admin-learning";
import { services } from "@/server/services";
import { Icon } from "@/components/admin/Icon";
import { CertificatesIndex, type CertState } from "@/components/admin/learning/CertificatesIndex";
import { SweepButton } from "@/components/admin/learning/SweepButton";
import "@/components/admin/orders/orders.css";
import "@/components/admin/learning/learning.css";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Certificados" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function CertificatesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdminPage("orders.view", "/admin/certificates");
  const sp = await searchParams;
  const state: CertState = {
    view: one(sp.view) in CERTIFICATE_VIEWS ? one(sp.view) : "ISSUED",
    q: one(sp.q).slice(0, 100),
    diploma: one(sp.diploma).slice(0, 40),
  };
  const data = await listCertificatesIndex(services().deps, user, { view: state.view as CertificateView, q: state.q, diploma: state.diploma || undefined });
  const perms = { manage: can(user, "enrollments.manage"), resend: can(user, "emails.resend"), revoke: can(user, "certificates.revoke") };
  return (
    <div className="adm-page wide">
      <div className="op-head">
        <h1>
          <Icon name="certificate" /> Certificados
        </h1>
        {perms.manage ? <SweepButton /> : null}
      </div>

      {data.stats.undelivered ? (
        <div className="banner attention lx-banner" role="status">
          <Icon name="alert" />
          <span>
            <b>{data.stats.undelivered === 1 ? "1 certificado emitido aún no llegó al médico" : `${data.stats.undelivered} certificados emitidos aún no llegaron al médico`}.</b> Se reintenta automáticamente; también puedes reenviarlo desde la lista.
          </span>
        </div>
      ) : null}

      <section className="om-bar" aria-label="Resumen de certificados">
        <Link className="om-cell" href="/admin/certificates">
          <span className="l">Emitidos</span>
          <span className="v" data-testid="metric-issued">{data.counts.ISSUED} <small>{data.stats.issued30} en 30 días</small></span>
        </Link>
        <Link className="om-cell" href="/admin/certificates?view=IN_PROGRESS">
          <span className="l">Cursando un diplomado</span>
          <span className="v" data-testid="metric-in-progress">{data.counts.IN_PROGRESS}</span>
        </Link>
        <Link className="om-cell" href="/admin/certificates?view=IN_PROGRESS">
          <span className="l">A un curso del certificado</span>
          <span className="v">{data.stats.nearlyDone}</span>
        </Link>
        <Link className={`om-cell${data.counts.BLOCKED ? " alert" : ""}`} href="/admin/certificates?view=BLOCKED">
          <span className="l">Bloqueados por saldo</span>
          <span className="v" data-testid="metric-blocked">{data.counts.BLOCKED}</span>
        </Link>
        <Link className="om-cell" href="/admin/certificates?view=REVOKED">
          <span className="l">Revocados</span>
          <span className="v">{data.counts.REVOKED}</span>
        </Link>
      </section>

      <CertificatesIndex data={data} state={state} now={new Date().toISOString()} perms={perms} />
      <p className="lx-help">
        Cada certificado lleva un código que cualquiera puede verificar en <span className="lp-mono">/certificados/&lt;código&gt;</span>. Se emite solo con todos los cursos completos en Moodle y el diplomado pagado por completo.
      </p>
    </div>
  );
}
