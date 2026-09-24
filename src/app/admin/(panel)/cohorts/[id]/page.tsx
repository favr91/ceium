import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@/server/auth";
import { requireAdminPage } from "../../../_lib/session";
import { cohortEditor } from "../data";
import { CohortEditor } from "@/components/admin/cohorts/CohortEditor";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/admin/cohorts/[id]">): Promise<Metadata> {
  const { id } = await params;
  const data = await cohortEditor(id);
  return { title: data ? `${data.form.name} · ${data.ctx.programs.find((p) => p.id === data.form.productId)?.title ?? "Cohorte"}` : "Cohorte" };
}

export default async function CohortPage({ params }: PageProps<"/admin/cohorts/[id]">) {
  const { id } = await params;
  const user = await requireAdminPage("cohorts.manage", `/admin/cohorts/${id}`);
  const data = await cohortEditor(id);
  if (!data) notFound();
  return <CohortEditor key={id} initial={data.form} ctx={data.ctx} canEdit={can(user, "cohorts.manage")} />;
}
