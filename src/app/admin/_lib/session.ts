// Sesión del panel para páginas y acciones de /admin. Los servicios vuelven a verificar rol y usuario activo
// (requireAdmin) en cada escritura: esto solo decide qué se muestra y a dónde redirigir.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { ADMIN_SESSION_COOKIE, can, getAdminSession, type Permission, type SessionUser } from "@/server/auth";

export async function currentAdmin(): Promise<SessionUser | null> {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const s = await getAdminSession(prisma, token);
  return s?.user ?? null;
}

/** Página del panel: sin sesión → /admin/login; sin permiso → /admin?denied=1. */
export async function requireAdminPage(permission?: Permission, next?: string): Promise<SessionUser> {
  const user = await currentAdmin();
  if (!user) redirect(`/admin/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  if (permission && !can(user, permission)) redirect("/admin?denied=1");
  return user;
}

/** Acción del panel: devuelve el usuario o lanza (el servicio igual vuelve a comprobar el permiso). */
export async function requireAdminAction(): Promise<SessionUser> {
  const user = await currentAdmin();
  if (!user) redirect("/admin/login");
  return user;
}
