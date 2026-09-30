// Tienda en línea › Quiénes somos: el personal que muestra /pages/quienes-somos (quién, en qué orden, nombre, cargo
// y foto) y el título y el texto de la sección. Lo edita quien gestiona el catálogo; el asistente solo lo ve.
import type { Metadata } from "next";
import { can } from "@/server/auth";
import { services } from "@/server/services";
import { AboutTeamEditor } from "@/components/admin/pages/AboutTeamEditor";
import { requireAdminPage } from "../../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Quiénes somos" };

export default async function AboutTeamPage() {
  const user = await requireAdminPage("orders.view", "/admin/pages/quienes-somos");
  const data = await services().aboutTeam.getTeamSection(user);
  return <AboutTeamEditor data={data} canEdit={can(user, "catalog.manage")} />;
}
