// Matrículas (panel): cada curso habilitado en Moodle por una compra, con su estado (matriculando, en curso,
// completado, con error, desmatriculado) y el progreso que reporta Moodle. Métricas, vistas, búsqueda, filtro
// por programa, consulta de progreso y reintento de matrícula. Todo sale de la BD (admin-learning.ts).
import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/server/auth";
import { ENROLLMENT_SORTS, ENROLLMENT_VIEWS, enrollmentMetrics, listEnrollmentsIndex, type EnrollmentSort, type EnrollmentView } from "@/server/admin-learning";
import { services } from "@/server/services";
import { Icon } from "@/components/admin/Icon";
import { ExportButton } from "@/components/admin/ExportButton";
import { exportOptions, exportQuery } from "@/components/admin/export-options";
import { EnrollmentsIndex, type EnrollState } from "@/components/admin/learning/EnrollmentsIndex";
import { RefreshAllButton } from "@/components/admin/learning/RefreshAllButton";
import "@/components/admin/orders/orders.css";
import "@/components/admin/learning/learning.css";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Matrículas" };

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function EnrollmentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireAdminPage("orders.view", "/admin/enrollments");
  const sp = await searchParams;
  const views = Object.keys(ENROLLMENT_VIEWS) as EnrollmentView[];
  const state: EnrollState = {
    view: (views as string[]).includes(one(sp.view)) ? one(sp.view) : "ALL",
    q: one(sp.q).slice(0, 100),
    program: one(sp.program).slice(0, 40),
    sort: one(sp.sort) in ENROLLMENT_SORTS ? one(sp.sort) : "recent",
    dir: one(sp.dir) === "asc" ? "asc" : "desc",
    page: Math.max(1, Number(one(sp.page)) || 1),
  };
  const d = services().deps;
  const [idx, m] = await Promise.all([
    listEnrollmentsIndex(d, user, { view: state.view as EnrollmentView, q: state.q, program: state.program || undefined, sort: state.sort as EnrollmentSort, dir: state.dir, page: state.page }),
    enrollmentMetrics(d, user),
  ]);
  const canManage = can(user, "enrollments.manage");
  return (
    <div className="adm-page wide">
      <div className="op-head">
        <h1>
          <Icon name="enroll" /> Matrículas
        </h1>
        <ExportButton
          title="Exportar matrículas"
          endpoint="/admin/enrollments/export"
          {...exportOptions({
            noun: ["matrículas", "matrícula"], fem: true,
            filters: exportQuery({ view: state.view !== "ALL" && state.view, q: state.q, program: state.program, sort: state.sort !== "recent" && state.sort, dir: state.dir !== "desc" && state.dir }),
            filtered: state.view !== "ALL" || !!state.q || !!state.program,
            total: idx.total,
            page: idx.page,
            pages: idx.pages,
          })}
        />
        {canManage ? <RefreshAllButton ids={idx.rows.filter((r) => r.state === "IN_PROGRESS").map((r) => r.id)} /> : null}
      </div>

      {m.failed ? (
        <div className="banner critical lx-banner" role="alert">
          <Icon name="alert" />
          <span>
            <b>{m.failed === 1 ? "1 matrícula no se pudo crear en Moodle" : `${m.failed} matrículas no se pudieron crear en Moodle`}.</b> {m.failed === 1 ? "El médico pagó, pero aún no tiene acceso al curso." : "Los médicos pagaron, pero aún no tienen acceso a sus cursos."} Revisa el error y reintenta.{" "}
            <Link href="/admin/enrollments?view=FAILED" style={{ textDecoration: "underline" }}>Ver matrículas con error</Link>
          </span>
        </div>
      ) : null}

      <section className="om-bar" aria-label="Resumen de matrículas">
        <Link className="om-cell" href="/admin/enrollments?view=IN_PROGRESS">
          <span className="l">Médicos con acceso</span>
          <span className="v" data-testid="metric-students">{m.students}</span>
        </Link>
        <Link className="om-cell" href="/admin/enrollments?view=IN_PROGRESS">
          <span className="l">Cursos activos</span>
          <span className="v" data-testid="metric-active">{m.active}</span>
        </Link>
        <Link className="om-cell" href="/admin/enrollments?view=COMPLETED">
          <span className="l">Completados</span>
          <span className="v" data-testid="metric-completed">
            {m.completed} <small>{Math.round(m.rate * 100)} % · {m.completed30} en 30 días</small>
          </span>
        </Link>
        <Link className={`om-cell${m.failed ? " alert" : ""}`} href="/admin/enrollments?view=FAILED">
          <span className="l">Con error</span>
          <span className="v" data-testid="metric-failed">{m.failed}</span>
        </Link>
        <Link className="om-cell" href="/admin/enrollments?view=PENDING">
          <span className="l">Pendientes</span>
          <span className="v">{m.pending}</span>
        </Link>
        <div className="om-cell">
          <span className="l">Sin consultar hoy</span>
          <span className="v">{m.stale} <small>en curso</small></span>
        </div>
      </section>

      <EnrollmentsIndex
        rows={idx.rows}
        counts={idx.counts}
        views={views.map((k) => ({ key: k, label: ENROLLMENT_VIEWS[k].label }))}
        sorts={Object.entries(ENROLLMENT_SORTS).map(([key, label]) => ({ key, label }))}
        programs={idx.programs}
        total={idx.total}
        page={idx.page}
        pages={idx.pages}
        perPage={idx.perPage}
        state={state}
        now={new Date().toISOString()}
        canManage={canManage}
      />
      <p className="lx-help">
        El progreso viene de Moodle (finalización de cada curso). Se consulta solo cada hora; el certificado del diplomado se emite cuando están completos todos sus cursos y el saldo es cero.
      </p>
    </div>
  );
}
