// «Mi cuenta» del panel: cada usuario gestiona su propia seguridad (no requiere permisos de rol, solo su sesión).
// Verificación en dos pasos (activar con QR + código, desactivar con contraseña + código, códigos de recuperación),
// cambio de contraseña, sesiones abiertas y equipos recordados. Cada cambio queda en la auditoría y se avisa por
// correo al usuario (si no fue él, se entera).
import QRCode from "qrcode";
import { changePassword as setPassword, hashPassword, requireAdmin, twoFactorRequired, verifyPassword, type SessionUser } from "@/server/auth";
import { ROLE_LABEL, canManageRole } from "@/server/admin-roles";
import { recordAudit } from "@/server/audit";
import type { Deps } from "@/server/deps";
import { sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import { DomainError } from "@/server/errors";
import {
  consumeRecoveryCode,
  formatManualKey,
  newRecoveryCodes,
  newTotpSecret,
  openSecret,
  otpauthUri,
  recoveryCodesLeft,
  sealSecret,
  verifyTotp,
} from "@/server/two-factor";

type D = Pick<Deps, "db" | "now" | "config" | "mailer" | "log" | "sleep">;
interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

async function me(d: Pick<Deps, "db">, userId: string) {
  const u = await d.db.adminUser.findUnique({ where: { id: userId } });
  if (!u || !u.active) throw new DomainError("UNAUTHORIZED", "Tu usuario del panel no existe o está desactivado.");
  return u;
}

/** Navegador legible a partir del user-agent («Chrome en Android», «Safari en iPhone»…). */
export function describeDevice(ua: string | null | undefined): string {
  const s = ua ?? "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\//.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "Navegador";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} en ${os}` : browser;
}

async function notify(d: D, user: { id: string; email: string; name: string }, event: T.AdminSecurityEvent, meta: ClientMeta & { recoveryLeft?: number; by?: string } = {}) {
  try {
    await sendEmail(d as Deps, {
      template: "admin_security",
      to: user.email,
      rendered: T.adminSecurityNotice({
        name: user.name.split(" ")[0] || user.name,
        event,
        at: d.now(),
        ip: meta.ip,
        device: meta.userAgent ? describeDevice(meta.userAgent) : null,
        recoveryLeft: meta.recoveryLeft,
        by: meta.by,
        accountUrl: `${d.config.appUrl}/admin/account`,
      }),
      actor: { type: "ADMIN", id: user.id },
    });
  } catch (e) {
    d.log.warn("[admin-account] no se pudo enviar el aviso de seguridad", e);
  }
}

/** Aviso por correo tras entrar con un código de recuperación. */
export async function notifyRecoveryUsed(d: D, userId: string, recoveryLeft: number, meta: ClientMeta = {}) {
  const u = await me(d, userId);
  await d.db.$transaction((tx) => recordAudit(tx, { actor: u, action: "admin_user.2fa_recovery_used", entityType: "AdminUser", entityId: userId, note: `Quedan ${recoveryLeft}`, force: true }));
  await notify(d, u, "recovery_used", { ...meta, recoveryLeft });
}

export async function getAccountOverview(d: Pick<Deps, "db" | "now">, userId: string, currentSessionId: string) {
  const u = await me(d, userId);
  const now = d.now();
  const [sessions, devices, required] = await Promise.all([
    d.db.adminSession.findMany({ where: { adminUserId: userId, expiresAt: { gt: now } }, orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }], select: { id: true, createdAt: true, lastSeenAt: true, ip: true, userAgent: true } }),
    d.db.adminTrustedDevice.findMany({ where: { adminUserId: userId, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, lastUsedAt: true, expiresAt: true, userAgent: true } }),
    twoFactorRequired(d.db),
  ]);
  return {
    user: { id: u.id, email: u.email, name: u.name, role: u.role, lastLoginAt: u.lastLoginAt },
    twoFactor: { enabled: !!(u.totpSecret && u.totpEnabledAt), enabledAt: u.totpEnabledAt, recoveryLeft: recoveryCodesLeft(u.recoveryCodes), required },
    sessions: sessions.map((s) => ({ ...s, device: describeDevice(s.userAgent), current: s.id === currentSessionId })),
    devices: devices.map((x) => ({ ...x, device: describeDevice(x.userAgent) })),
  };
}
export type AccountOverview = Awaited<ReturnType<typeof getAccountOverview>>;

/** Paso 1 de la activación: secreto nuevo (pendiente) con su QR y la clave para escribirla a mano. */
export async function beginTwoFactorSetup(d: Pick<Deps, "db">, userId: string) {
  const u = await me(d, userId);
  if (u.totpSecret && u.totpEnabledAt) throw new DomainError("CONFLICT", "La verificación en dos pasos ya está activada.");
  const secret = newTotpSecret();
  await d.db.adminUser.update({ where: { id: userId }, data: { totpPendingSecret: sealSecret(secret) } });
  const uri = otpauthUri(u.email, secret);
  const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 220, color: { dark: "#1a1a1a", light: "#ffffff" } });
  return { qr, manualKey: formatManualKey(secret), uri };
}

/**
 * Paso 2: el código de la app confirma que quedó bien configurada. Activa, entrega 10 códigos de recuperación
 * (se muestran una sola vez) y cierra las demás sesiones y equipos recordados.
 */
export async function confirmTwoFactorSetup(d: D, userId: string, code: string, keepSessionId: string, meta: ClientMeta = {}) {
  const u = await me(d, userId);
  if (u.totpSecret && u.totpEnabledAt) throw new DomainError("CONFLICT", "La verificación en dos pasos ya está activada.");
  if (!u.totpPendingSecret) throw new DomainError("INVALID_STATE", "Empieza de nuevo: vuelve a mostrar el código QR.");
  const step = verifyTotp(openSecret(u.totpPendingSecret), code, d.now());
  if (step == null) throw new DomainError("VALIDATION", "El código no coincide. Escribe el que muestra ahora la app (cambia cada 30 segundos) y revisa que la hora del teléfono sea automática.");
  const { codes, hashes } = newRecoveryCodes();
  await d.db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: userId }, data: { totpSecret: u.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: d.now(), totpLastStep: step, recoveryCodes: JSON.stringify(hashes) } });
    await tx.adminSession.deleteMany({ where: { adminUserId: userId, id: { not: keepSessionId } } });
    await tx.adminTrustedDevice.deleteMany({ where: { adminUserId: userId } });
    await recordAudit(tx, { actor: u, action: "admin_user.2fa_enable", entityType: "AdminUser", entityId: userId, force: true });
  });
  await notify(d, u, "2fa_enabled", meta);
  return { recoveryCodes: codes };
}

/** Contraseña + código (de la app o de recuperación): desactiva y olvida los equipos recordados. */
export async function disableTwoFactor(d: D, userId: string, input: { password: string; code: string }, meta: ClientMeta = {}) {
  const u = await me(d, userId);
  if (!u.totpSecret || !u.totpEnabledAt) throw new DomainError("CONFLICT", "La verificación en dos pasos no está activada.");
  if (!(await verifyPassword(input.password ?? "", u.passwordHash))) throw new DomainError("VALIDATION", "La contraseña no es correcta.");
  const byApp = verifyTotp(openSecret(u.totpSecret), input.code, d.now(), u.totpLastStep) != null;
  if (!byApp && !consumeRecoveryCode(u.recoveryCodes, input.code)) throw new DomainError("VALIDATION", "El código no es válido. Usa el de la app o un código de recuperación.");
  await d.db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: userId }, data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null } });
    await tx.adminTrustedDevice.deleteMany({ where: { adminUserId: userId } });
    await recordAudit(tx, { actor: u, action: "admin_user.2fa_disable", entityType: "AdminUser", entityId: userId, force: true });
  });
  await notify(d, u, "2fa_disabled", meta);
}

/** Nuevos códigos de recuperación (los anteriores dejan de servir). Pide la contraseña. */
export async function regenerateRecoveryCodes(d: D, userId: string, password: string, meta: ClientMeta = {}) {
  const u = await me(d, userId);
  if (!u.totpSecret || !u.totpEnabledAt) throw new DomainError("CONFLICT", "Activa primero la verificación en dos pasos.");
  if (!(await verifyPassword(password ?? "", u.passwordHash))) throw new DomainError("VALIDATION", "La contraseña no es correcta.");
  const { codes, hashes } = newRecoveryCodes();
  await d.db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: userId }, data: { recoveryCodes: JSON.stringify(hashes) } });
    await recordAudit(tx, { actor: u, action: "admin_user.2fa_recovery_regenerate", entityType: "AdminUser", entityId: userId, force: true });
  });
  await notify(d, u, "recovery_regenerated", meta);
  return { recoveryCodes: codes };
}

/**
 * Cambio de la propia contraseña: pide la actual, cierra las demás sesiones y olvida los equipos recordados.
 * La sesión actual se conserva (changePassword las borra todas: se vuelve a crear la cookie en la acción).
 */
export async function changeOwnPassword(d: D, userId: string, input: { current: string; next: string }, meta: ClientMeta = {}) {
  const u = await me(d, userId);
  if (!(await verifyPassword(input.current ?? "", u.passwordHash))) throw new DomainError("VALIDATION", "La contraseña actual no es correcta.");
  if ((input.next ?? "") === input.current) throw new DomainError("VALIDATION", "La contraseña nueva debe ser distinta de la actual.");
  await hashPassword(input.next); // valida largo antes de tocar nada
  await setPassword(d.db, userId, input.next);
  await notify(d, u, "password_changed", meta);
}

export async function revokeSession(d: Pick<Deps, "db">, userId: string, sessionId: string) {
  const n = await d.db.adminSession.deleteMany({ where: { id: sessionId, adminUserId: userId } });
  if (!n.count) throw new DomainError("NOT_FOUND", "Esa sesión ya no está abierta.");
}

export async function revokeOtherSessions(d: Pick<Deps, "db">, userId: string, keepSessionId: string) {
  return (await d.db.adminSession.deleteMany({ where: { adminUserId: userId, id: { not: keepSessionId } } })).count;
}

export async function forgetTrustedDevices(d: Pick<Deps, "db">, userId: string) {
  return (await d.db.adminTrustedDevice.deleteMany({ where: { adminUserId: userId } })).count;
}

/**
 * Quita la verificación en dos pasos de otra persona del equipo que perdió el teléfono y sus códigos (desde Equipo,
 * con la misma jerarquía que el resto de la gestión del equipo, o con scripts/admin-reset-2fa.ts: `actor` null).
 * Cierra sus sesiones: al entrar, la vuelve a configurar. Se le avisa por correo.
 */
export async function resetTwoFactorFor(d: D, actor: SessionUser | null, targetUserId: string, note?: string) {
  if (actor) actor = await requireAdmin(d.db, actor, "users.manage");
  const u = await d.db.adminUser.findUnique({ where: { id: targetUserId }, select: { id: true, email: true, name: true, role: true, totpEnabledAt: true } });
  if (!u) throw new DomainError("NOT_FOUND", "El usuario no existe.");
  if (actor && u.id === actor.id) throw new DomainError("CONFLICT", "Tu propia verificación en dos pasos se gestiona en Mi cuenta.");
  if (actor && !canManageRole(actor.role, u.role)) throw new DomainError("FORBIDDEN", `Solo el super administrador puede gestionar a un ${ROLE_LABEL[u.role].toLowerCase()}.`);
  await d.db.$transaction(async (tx) => {
    await tx.adminUser.update({ where: { id: targetUserId }, data: { totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null, recoveryCodes: null, failedLogins: 0, lockedUntil: null } });
    await tx.adminSession.deleteMany({ where: { adminUserId: targetUserId } });
    await tx.adminTrustedDevice.deleteMany({ where: { adminUserId: targetUserId } });
    await tx.adminLoginChallenge.deleteMany({ where: { adminUserId: targetUserId } });
    await recordAudit(tx, { actor, action: "admin_user.2fa_reset", entityType: "AdminUser", entityId: targetUserId, note, force: true });
  });
  if (u.totpEnabledAt) await notify(d, u, "2fa_reset", { by: actor?.name ?? "Soporte técnico (desde el servidor)" });
}
