import { AdminFrame } from "@/components/admin/AdminFrame";
import { requireAdminPage } from "../_lib/session";

// «Mi cuenta» fuera de (panel): es la única página a la que se puede entrar sin la verificación en dos pasos cuando
// Configuración la exige (para poder activarla).
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminPage(undefined, "/admin/account", { allowWithout2fa: true });
  return <AdminFrame user={{ name: user.name, email: user.email, role: user.role }}>{children}</AdminFrame>;
}
