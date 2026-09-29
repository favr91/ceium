"use server";
// Inicio (en uno o dos pasos) y cierre de sesión del panel.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { ADMIN_CHALLENGE_COOKIE, ADMIN_DEVICE_COOKIE, ADMIN_SESSION_COOKIE, ADMIN_WEAK_PASSWORD_COOKIE, adminCookieOptions, completeLoginChallenge, login, logout } from "@/server/auth";
import { notifyRecoveryUsed } from "@/server/admin-account";
import { clientIp, ipKey } from "@/server/client-ip";
import { isDomainError } from "@/server/errors";
import { record, tooMany } from "@/server/rate-limit";
import { services } from "@/server/services";

export interface LoginState { error?: string; email?: string }
export interface VerifyState { error?: string; recovery?: boolean }

// Por conexión (además del bloqueo de la cuenta tras 5 fallos): 20 intentos FALLIDOS cada 15 minutos (una oficina
// comparte IP: los inicios de sesión correctos no cuentan).
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60_000;
const TOO_MANY = "Demasiados intentos desde esta conexión. Espera unos minutos e inténtalo de nuevo.";

// Contraseñas de ejemplo del seed (públicas): el panel muestra un aviso fijo hasta cambiarla (ver AdminFrame).
const EXAMPLE_PASSWORDS = new Set(["ceium-admin-2026", "ceium-staff-2026"]);

function safeNext(raw: FormDataEntryValue | null): string {
  const n = String(raw ?? "");
  return n.startsWith("/admin") && !n.startsWith("//") && !n.startsWith("/admin/login") ? n : "/admin/products";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));
  const h = await headers();
  const ip = clientIp(h);
  if (tooMany(ipKey("admin-login", ip), IP_LIMIT, IP_WINDOW_MS)) return { error: TOO_MANY, email };
  const jar = await cookies();
  let step2 = false;
  try {
    const weak = EXAMPLE_PASSWORDS.has(password);
    const r = await login(prisma, { email, password, ip, userAgent: h.get("user-agent"), deviceToken: jar.get(ADMIN_DEVICE_COOKIE)?.value });
    if (r.kind === "challenge") {
      jar.set(ADMIN_CHALLENGE_COOKIE, r.token, adminCookieOptions(r.expiresAt));
      step2 = true;
    } else {
      jar.set(ADMIN_SESSION_COOKIE, r.token, adminCookieOptions(r.expiresAt));
    }
    if (weak) jar.set(ADMIN_WEAK_PASSWORD_COOKIE, "1", adminCookieOptions(new Date(Date.now() + 30 * 86_400_000)));
    else jar.delete(ADMIN_WEAK_PASSWORD_COOKIE);
  } catch (e) {
    if (isDomainError(e)) {
      record(ipKey("admin-login", ip));
      return { error: e.message, email };
    }
    console.error("[admin/login]", e);
    return { error: "No pudimos iniciar sesión. Intenta de nuevo.", email };
  }
  redirect(step2 ? `/admin/login/verificar${next !== "/admin/products" ? `?next=${encodeURIComponent(next)}` : ""}` : next);
}

/** Paso 2: código de la app autenticadora o de recuperación. */
export async function verifyLoginCodeAction(prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const recovery = formData.get("recovery") === "1";
  const h = await headers();
  const ip = clientIp(h);
  if (tooMany(ipKey("admin-login", ip), IP_LIMIT, IP_WINDOW_MS)) return { error: TOO_MANY, recovery };
  const jar = await cookies();
  let dest = safeNext(formData.get("next"));
  try {
    const r = await completeLoginChallenge(prisma, {
      token: jar.get(ADMIN_CHALLENGE_COOKIE)?.value,
      code: String(formData.get("code") ?? ""),
      recovery,
      remember: formData.get("remember") === "on",
      ip,
      userAgent: h.get("user-agent"),
    });
    jar.delete(ADMIN_CHALLENGE_COOKIE);
    jar.set(ADMIN_SESSION_COOKIE, r.token, adminCookieOptions(r.expiresAt));
    if (r.device) jar.set(ADMIN_DEVICE_COOKIE, r.device.token, adminCookieOptions(r.device.expiresAt));
    if (r.recoveryLeft != null) {
      await notifyRecoveryUsed(services().deps, r.user.id, r.recoveryLeft, { ip, userAgent: h.get("user-agent") });
      dest = `/admin/account?recuperacion=${r.recoveryLeft}`;
    }
  } catch (e) {
    if (isDomainError(e)) {
      record(ipKey("admin-login", ip));
      // Desafío vencido o agotado: de vuelta al paso 1.
      if (/Vuelve a escribir tu correo/.test(e.message)) {
        jar.delete(ADMIN_CHALLENGE_COOKIE);
        redirect(`/admin/login?vencido=1`);
      }
      return { error: e.message, recovery };
    }
    console.error("[admin/login/verificar]", e);
    return { error: "No pudimos verificar el código. Intenta de nuevo.", recovery };
  }
  redirect(dest);
}

export async function logoutAction(): Promise<never> {
  const jar = await cookies();
  await logout(prisma, jar.get(ADMIN_SESSION_COOKIE)?.value);
  jar.delete(ADMIN_SESSION_COOKIE);
  redirect("/admin/login");
}
