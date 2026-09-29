"use server";
// Acciones de «Mi cuenta»: cada una actúa solo sobre el usuario de la sesión actual.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  beginTwoFactorSetup,
  changeOwnPassword,
  confirmTwoFactorSetup,
  disableTwoFactor,
  forgetTrustedDevices,
  regenerateRecoveryCodes,
  revokeOtherSessions,
  revokeSession,
} from "@/server/admin-account";
import { ADMIN_DEVICE_COOKIE, ADMIN_SESSION_COOKIE, adminCookieOptions, createSession } from "@/server/auth";
import { clientIp } from "@/server/client-ip";
import { prisma } from "@/server/db";
import { isDomainError } from "@/server/errors";
import { hit } from "@/server/rate-limit";
import { services } from "@/server/services";
import { currentSession } from "../../_lib/session";

export type AccountResult<T = object> = ({ ok: true; message?: string } & T) | { ok: false; error: string };

async function session() {
  const s = await currentSession();
  if (!s) redirect("/admin/login?next=/admin/account");
  const h = await headers();
  return { s, meta: { ip: clientIp(h), userAgent: h.get("user-agent") } };
}

function fail(e: unknown, fallback: string): { ok: false; error: string } {
  if (isDomainError(e)) return { ok: false, error: e.message };
  console.error("[admin/account]", e);
  return { ok: false, error: fallback };
}

// Las acciones que comprueban contraseña o código tienen su propio límite (además del bloqueo del inicio de sesión).
function throttled(userId: string): { ok: false; error: string } | null {
  return hit(`admin-account:${userId}`, 10, 15 * 60_000).ok ? null : { ok: false, error: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo." };
}

export async function beginTwoFactorAction(): Promise<AccountResult<{ qr: string; manualKey: string }>> {
  const { s } = await session();
  try {
    const r = await beginTwoFactorSetup(services().deps, s.user.id);
    return { ok: true, qr: r.qr, manualKey: r.manualKey };
  } catch (e) {
    return fail(e, "No pudimos preparar la verificación en dos pasos.");
  }
}

export async function confirmTwoFactorAction(code: string): Promise<AccountResult<{ recoveryCodes: string[] }>> {
  const { s, meta } = await session();
  const t = throttled(s.user.id);
  if (t) return t;
  try {
    const r = await confirmTwoFactorSetup(services().deps, s.user.id, code, s.session.id, meta);
    revalidatePath("/admin/account");
    return { ok: true, recoveryCodes: r.recoveryCodes, message: "Verificación en dos pasos activada." };
  } catch (e) {
    return fail(e, "No pudimos activar la verificación en dos pasos.");
  }
}

export async function disableTwoFactorAction(password: string, code: string): Promise<AccountResult> {
  const { s, meta } = await session();
  const t = throttled(s.user.id);
  if (t) return t;
  try {
    await disableTwoFactor(services().deps, s.user.id, { password, code }, meta);
    (await cookies()).delete(ADMIN_DEVICE_COOKIE);
    revalidatePath("/admin/account");
    return { ok: true, message: "Verificación en dos pasos desactivada." };
  } catch (e) {
    return fail(e, "No pudimos desactivar la verificación en dos pasos.");
  }
}

export async function regenerateCodesAction(password: string): Promise<AccountResult<{ recoveryCodes: string[] }>> {
  const { s, meta } = await session();
  const t = throttled(s.user.id);
  if (t) return t;
  try {
    const r = await regenerateRecoveryCodes(services().deps, s.user.id, password, meta);
    revalidatePath("/admin/account");
    return { ok: true, recoveryCodes: r.recoveryCodes, message: "Nuevos códigos generados. Los anteriores ya no sirven." };
  } catch (e) {
    return fail(e, "No pudimos generar los códigos.");
  }
}

/** Cambia la contraseña; se cierran todas las sesiones y este navegador recibe una nueva. */
export async function changePasswordAction(current: string, next: string): Promise<AccountResult> {
  const { s, meta } = await session();
  const t = throttled(s.user.id);
  if (t) return t;
  try {
    await changeOwnPassword(services().deps, s.user.id, { current, next }, meta);
    const fresh = await createSession(prisma, s.user.id, meta);
    const jar = await cookies();
    jar.set(ADMIN_SESSION_COOKIE, fresh.token, adminCookieOptions(fresh.expiresAt));
    jar.delete(ADMIN_DEVICE_COOKIE);
    revalidatePath("/admin/account");
    return { ok: true, message: "Contraseña cambiada. Cerramos tus otras sesiones." };
  } catch (e) {
    return fail(e, "No pudimos cambiar la contraseña.");
  }
}

export async function revokeSessionAction(sessionId: string): Promise<AccountResult> {
  const { s } = await session();
  if (sessionId === s.session.id) return { ok: false, error: "Para cerrar esta sesión usa «Cerrar sesión» en el menú." };
  try {
    await revokeSession(services().deps, s.user.id, sessionId);
    revalidatePath("/admin/account");
    return { ok: true, message: "Sesión cerrada." };
  } catch (e) {
    return fail(e, "No pudimos cerrar la sesión.");
  }
}

export async function revokeOtherSessionsAction(): Promise<AccountResult> {
  const { s } = await session();
  const n = await revokeOtherSessions(services().deps, s.user.id, s.session.id);
  revalidatePath("/admin/account");
  return { ok: true, message: n ? `Cerramos ${n === 1 ? "1 sesión" : `${n} sesiones`}.` : "No había otras sesiones abiertas." };
}

export async function forgetDevicesAction(): Promise<AccountResult> {
  const { s } = await session();
  const n = await forgetTrustedDevices(services().deps, s.user.id);
  (await cookies()).delete(ADMIN_DEVICE_COOKIE);
  revalidatePath("/admin/account");
  return { ok: true, message: n ? "Listo: en esos equipos se volverá a pedir el código." : "No había equipos recordados." };
}
