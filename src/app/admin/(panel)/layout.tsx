import { cookies } from "next/headers";
import { AdminFrame } from "@/components/admin/AdminFrame";
import { ADMIN_WEAK_PASSWORD_COOKIE } from "@/server/auth";
import { requireAdminPage } from "../_lib/session";

// Todo lo que cuelga de (panel) exige sesión; la barra superior y la navegación son las del admin.
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminPage();
  const weakPassword = (await cookies()).get(ADMIN_WEAK_PASSWORD_COOKIE)?.value === "1";
  return <AdminFrame user={{ name: user.name, email: user.email, role: user.role }} weakPassword={weakPassword}>{children}</AdminFrame>;
}
