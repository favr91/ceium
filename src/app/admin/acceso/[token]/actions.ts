"use server";
// Crear la contraseña con el enlace de acceso (invitación o restablecer). No requiere sesión: el enlace es la
// credencial (256 bits, un solo uso). Límite por conexión por si alguien prueba enlaces al azar.
import { headers } from "next/headers";
import { clientIp, ipKey } from "@/server/client-ip";
import { isDomainError } from "@/server/errors";
import { hit } from "@/server/rate-limit";
import { services } from "@/server/services";

export type SetPasswordResult = { ok: true; email: string; kind: "invite" | "reset" } | { ok: false; error: string };

export async function setPasswordWithLinkAction(token: string, password: string, confirm: string): Promise<SetPasswordResult> {
  if (!hit(ipKey("admin-access", clientIp(await headers())), 20, 15 * 60_000).ok) return { ok: false, error: "Demasiados intentos desde esta conexión. Espera unos minutos." };
  if (password !== confirm) return { ok: false, error: "Las contraseñas no coinciden." };
  try {
    const r = await services().adminUsers.setPasswordWithAccessLink(String(token), String(password));
    return { ok: true, email: r.email, kind: r.kind };
  } catch (e) {
    if (isDomainError(e)) return { ok: false, error: e.message };
    console.error("[admin/acceso]", e);
    return { ok: false, error: "No pudimos guardar la contraseña. Intenta de nuevo." };
  }
}
