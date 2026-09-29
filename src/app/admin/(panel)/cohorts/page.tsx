import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/server/auth";
import { requireAdminPage } from "../../_lib/session";
import { listCohortRows, queryCohorts, sedeOptions, todayVz } from "./data";
import { CohortsIndex } from "@/components/admin/cohorts/CohortsIndex";
import { ExportButton } from "@/components/admin/ExportButton";
import { exportOptions, exportQuery } from "@/components/admin/export-options";
import { fillOf, type Seats } from "@/components/admin/cohorts/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cohortes" };

const PAGE = 50;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function CohortsPage({ searchParams }: PageProps<"/admin/cohorts">) {
  const user = await requireAdminPage("cohorts.manage", "/admin/cohorts");
  const sp = await searchParams;
  const [all, sedes] = await Promise.all([listCohortRows(), sedeOptions()]);

  const { view, sede, productId, q, sort, period, base, rows, counts } = queryCohorts(all, sedes, (k) => one(sp[k]));
  const today = todayVz();

  // Resumen: cohortes abiertas del conjunto filtrado (sede/programa/búsqueda), sin importar la pestaña.
  const open = base.filter((r) => r.status === "OPEN");
  const sum = (k: keyof Seats) => open.reduce((a, r) => a + r.seats[k], 0);
  const summary = {
    open: open.length,
    low: open.filter((r) => fillOf(r.seats) === "low").length,
    full: open.filter((r) => fillOf(r.seats) === "full").length,
    inProgress: base.filter((r) => r.status === "IN_PROGRESS").length,
    seats: { capacity: sum("capacity"), confirmed: sum("confirmed"), held: sum("held"), stale: sum("stale"), free: sum("free") },
    sample: all.some((r) => r.isSample),
  };

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const page = Math.min(pages, Math.max(1, Number(one(sp.page)) || 1));
  const programs = [...new Map(all.map((r) => [r.productId, r.productTitle])).entries()].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title, "es"));
  const sedeCounts = Object.fromEntries(sedes.map((s) => [s.slug, all.filter((r) => r.sedeId === s.id && r.status === "OPEN").length]));

  return (
    <div className="adm-page wide">
      <div className="adm-ph">
        <div className="grow">
          <h1>Cohortes</h1>
        </div>
        <div className="adm-ph-actions">
          <Link className="btn btn-gray hide-sm" href="/admin/sedes">Sedes</Link>
          <ExportButton
            title="Exportar cohortes"
            endpoint="/admin/cohorts/export"
            {...exportOptions({
              noun: ["cohortes", "cohorte"],
              filters: exportQuery({ view: view !== "ALL" && view, sede: sede?.slug, product: productId, period, q, sort: sort !== "start-asc" && sort }),
              filtered: view !== "ALL" || !!sede || !!productId || !!period || !!q,
              total: rows.length,
              page,
              pages,
            })}
          />
          <Link className="btn btn-primary" href={`/admin/cohorts/new${productId || sede ? `?${new URLSearchParams({ ...(productId ? { product: productId } : {}), ...(sede ? { sede: sede.id } : {}) })}` : ""}`}>Crear cohorte</Link>
        </div>
      </div>
      <CohortsIndex
        rows={rows.slice((page - 1) * PAGE, page * PAGE)}
        total={rows.length}
        allTotal={all.length}
        counts={counts}
        summary={summary}
        sedes={sedes.map((s) => ({ slug: s.slug, name: s.name, active: s.active, open: sedeCounts[s.slug] ?? 0 }))}
        programs={programs}
        query={{ view, sede: sede?.slug ?? "", product: productId, q, sort, period, page }}
        pages={pages}
        today={today}
        canEdit={can(user, "cohorts.manage")}
      />
    </div>
  );
}
