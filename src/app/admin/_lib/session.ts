// Sesión del panel para páginas y acciones de /admin. Los servicios vuelven a verificar rol y usuario activo
// (requireAdmin) en cada escritura: esto solo decide qué se muestra y a dónde redirigir.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { ADMIN_SESSION_COOKIE, can, getAdminSession, twoFactorRequired, type Permission, type SessionUser } from "@/server/auth";

export async function currentSession() {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  return getAdminSession(prisma, token);
}

export async function currentAdmin(): Promise<SessionUser | null> {
  return (await currentSession())?.user ?? null;
}

/** ¿Debe configurar la verificación en dos pasos antes de usar el panel (lo exige Configuración)? */
export async function mustSetUpTwoFactor(user: SessionUser): Promise<boolean> {
  if (!(await twoFactorRequired(prisma))) return false;
  const u = await prisma.adminUser.findUnique({ where: { id: user.id }, select: { totpEnabledAt: true } });
  return !u?.totpEnabledAt;
}

/**
 * Página del panel: sin sesión → /admin/login; sin permiso → /admin?denied=1; si Configuración exige la
 * verificación en dos pasos y el usuario no la tiene → Mi cuenta (salvo `allowWithout2fa`, la propia Mi cuenta).
 */
export async function requireAdminPage(permission?: Permission, next?: string, opts: { allowWithout2fa?: boolean } = {}): Promise<SessionUser> {
  const user = await currentAdmin();
  if (!user) redirect(`/admin/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  if (!opts.allowWithout2fa && (await mustSetUpTwoFactor(user))) redirect("/admin/account?configurar=2fa");
  if (permission && !can(user, permission)) redirect("/admin?denied=1");
  return user;
}

/** Acción del panel: devuelve el usuario o lanza (el servicio igual vuelve a comprobar el permiso). */
export async function requireAdminAction(): Promise<SessionUser> {
  const user = await currentAdmin();
  if (!user) redirect("/admin/login");
  return user;
}
