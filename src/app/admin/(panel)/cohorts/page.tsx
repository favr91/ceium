import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@/server/auth";
import { requireAdminPage } from "../../_lib/session";
import { listCohortRows, sedeOptions, todayVz } from "./data";
import { CohortsIndex } from "@/components/admin/cohorts/CohortsIndex";
import { fillOf, inView, VIEWS, type CohortRow, type Seats, type View } from "@/components/admin/cohorts/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cohortes" };

const PAGE = 50;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const SORTS = ["start-asc", "start-desc", "free-asc", "occ-desc", "program", "sede"] as const;

export default async function CohortsPage({ searchParams }: PageProps<"/admin/cohorts">) {
  const user = await requireAdminPage("cohorts.manage", "/admin/cohorts");
  const sp = await searchParams;
  const [all, sedes] = await Promise.all([listCohortRows(), sedeOptions()]);

  const view = (VIEWS.some((v) => v.key === one(sp.view)) ? one(sp.view) : "ALL") as View;
  const sede = sedes.find((s) => s.slug === one(sp.sede)) ?? null;
  const productId = all.some((r) => r.productId === one(sp.product)) ? one(sp.product) : "";
  const q = one(sp.q).trim();
  const sort = (SORTS as readonly string[]).includes(one(sp.sort)) ? one(sp.sort) : "start-asc";
  const period = one(sp.period) === "upcoming" || one(sp.period) === "past" ? one(sp.period) : "";
  const today = todayVz();

  // Filtros que no son la vista: sede, programa, periodo y búsqueda. Las pestañas cuentan sobre este conjunto.
  let base: CohortRow[] = all;
  if (sede) base = base.filter((r) => r.sedeId === sede.id);
  if (productId) base = base.filter((r) => r.productId === productId);
  if (period === "upcoming") base = base.filter((r) => r.startDate >= today);
  if (period === "past") base = base.filter((r) => r.endDate < today);
  if (q) {
    const terms = norm(q).split(/\s+/).filter(Boolean);
    base = base.filter((r) => {
      const hay = norm(`${r.name} ${r.productTitle} ${r.sedeName}`);
      return terms.every((t) => hay.includes(t));
    });
  }
  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, base.filter((r) => inView(r, v.key)).length])) as Record<View, number>;
  let rows = base.filter((r) => inView(r, view));
  const occ = (r: CohortRow) => (r.seats.capacity ? (r.seats.confirmed + r.seats.held) / r.seats.capacity : 0);
  const by: Record<string, (a: CohortRow, b: CohortRow) => number> = {
    "start-asc": (a, b) => a.startDate.localeCompare(b.startDate) || a.productTitle.localeCompare(b.productTitle, "es"),
    "start-desc": (a, b) => b.startDate.localeCompare(a.startDate) || a.productTitle.localeCompare(b.productTitle, "es"),
    "free-asc": (a, b) => a.seats.free - b.seats.free || a.startDate.localeCompare(b.startDate),
    "occ-desc": (a, b) => occ(b) - occ(a) || a.startDate.localeCompare(b.startDate),
    program: (a, b) => a.productTitle.localeCompare(b.productTitle, "es") || a.startDate.localeCompare(b.startDate),
    sede: (a, b) => a.sedeName.localeCompare(b.sedeName, "es") || a.startDate.localeCompare(b.startDate),
  };
  rows = [...rows].sort(by[sort]);

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
