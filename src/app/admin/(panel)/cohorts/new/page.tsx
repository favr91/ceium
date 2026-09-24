import type { Metadata } from "next";
import { can } from "@/server/auth";
import { requireAdminPage } from "../../../_lib/session";
import { newCohortEditor } from "../data";
import { CohortEditor } from "@/components/admin/cohorts/CohortEditor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Crear cohorte" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function NewCohortPage({ searchParams }: PageProps<"/admin/cohorts/new">) {
  const user = await requireAdminPage("cohorts.manage", "/admin/cohorts/new");
  const sp = await searchParams;
  const data = await newCohortEditor({ productId: one(sp.product), sedeId: one(sp.sede), from: one(sp.from) });
  return <CohortEditor key={one(sp.from) || "new"} initial={data.form} ctx={data.ctx} canEdit={can(user, "cohorts.manage")} />;
}
