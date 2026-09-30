// Equipo: quién tiene acceso al panel, con qué rol, y la gestión según la jerarquía de roles (admin-roles.ts).
import type { Metadata } from "next";
import { twoFactorRequired } from "@/server/auth";
import { services } from "@/server/services";
import { TeamView } from "@/components/admin/team/TeamView";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Equipo" };

export default async function TeamPage() {
  const user = await requireAdminPage("users.manage", "/admin/team");
  const s = services();
  const [team, require2fa] = await Promise.all([s.adminUsers.listTeam(user), twoFactorRequired(s.deps.db)]);
  return (
    <div className="adm-page">
      <TeamView data={team} require2fa={require2fa} />
    </div>
  );
}
