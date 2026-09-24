import { AdminFrame } from "@/components/admin/AdminFrame";
import { requireAdminPage } from "../_lib/session";

// Todo lo que cuelga de (panel) exige sesión; la barra superior y la navegación son las del admin.
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminPage();
  return <AdminFrame user={{ name: user.name, email: user.email, role: user.role }}>{children}</AdminFrame>;
}
