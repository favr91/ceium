// Autenticación y roles del panel (/admin). Independiente de Next: las rutas/acciones del panel leen la
// cookie y llaman a estas funciones.
//   const s = await getAdminSession(prisma, cookies().get(ADMIN_SESSION_COOKIE)?.value);
//   assertCan(s?.user, "payments.refund");
//
// Sesiones opacas en BD (AdminSession): la cookie lleva un token aleatorio de 256 bits; en BD solo se guarda
// su sha256 (un volcado de la BD no permite suplantar). Expiración absoluta de 12 h desde el inicio de sesión (sin
// renovación: la cookie del navegador vence igual, así que renovar solo alargaría un token robado). Desactivar un
// usuario invalida sus sesiones al instante.
//
// Inicio de sesión en dos pasos (si el usuario lo activó, ver two-factor.ts): contraseña correcta → desafío
// (AdminLoginChallenge, 10 min, 5 intentos) → código de la app o de recuperación → sesión. «Recordar este equipo»
// (AdminTrustedDevice, 30 días) omite solo el código. 5 intentos fallidos seguidos (contraseña o código)
// bloquean la cuenta 15 minutos.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { AdminRole, AdminSession, AdminUser } from "@/generated/prisma/client";
import type { Db, Tx } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRecoveryCode, openSecret, verifyTotp } from "@/server/two-factor";

export const ADMIN_SESSION_COOKIE = "ceium_admin";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Cookie del segundo paso (contraseña ya validada, falta el código). */
export const ADMIN_CHALLENGE_COOKIE = "ceium_admin_2fa";
export const ADMIN_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Cookie de «Recordar este equipo». */
export const ADMIN_DEVICE_COOKIE = "ceium_admin_device";
export const ADMIN_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
/** Setting { enabled: boolean }: todo el equipo debe tener activada la verificación en dos pasos. */
export const REQUIRE_2FA_SETTING = "security.require2fa";
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD = 10;
// Hash de relleno: con un correo inexistente se compara igual (mismo tiempo de respuesta).
const DUMMY_HASH = bcrypt.hashSync("ceium-dummy-password", BCRYPT_ROUNDS);

// ───────────── Permisos ─────────────

/**
 * STAFF opera el día a día (ver pedidos, verificar pagos manuales, reenviar correos, notas, cohortes).
 * Lo que mueve dinero o cambia el catálogo/configuración es solo ADMIN.
 */
export const PERMISSIONS = {
  "orders.view": ["ADMIN", "STAFF"],
  "orders.note": ["ADMIN", "STAFF"],
  "orders.cancel": ["ADMIN", "STAFF"],
  "payments.verify": ["ADMIN", "STAFF"],
  "emails.resend": ["ADMIN", "STAFF"],
  "enrollments.manage": ["ADMIN", "STAFF"],
  "cohorts.manage": ["ADMIN", "STAFF"],
  "orders.reassignCohort": ["ADMIN", "STAFF"],
  "payments.refund": ["ADMIN"],
  "orders.adjustBalance": ["ADMIN"],
  "certificates.revoke": ["ADMIN"],
  "catalog.manage": ["ADMIN"],
  "settings.manage": ["ADMIN"],
  "users.manage": ["ADMIN"],
} as const satisfies Record<string, readonly AdminRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export type SessionUser = Pick<AdminUser, "id" | "email" | "name" | "role">;

export function can(user: Pick<AdminUser, "role"> | null | undefined, permission: Permission): boolean {
  return !!user && (PERMISSIONS[permission] as readonly AdminRole[]).includes(user.role);
}

export function assertCan(user: Pick<AdminUser, "role"> | null | undefined, permission: Permission): asserts user is SessionUser {
  if (!user) throw new DomainError("UNAUTHORIZED", "Inicia sesión para continuar.");
  if (!can(user, permission)) throw new DomainError("FORBIDDEN", "Tu rol no tiene permiso para esta acción.", { permission });
}

/**
 * Guardia de TODO servicio del panel: permiso por rol y, además, que el usuario exista y siga activo en BD
 * con un rol que tenga el permiso (un objeto de sesión viejo de alguien degradado o desactivado no pasa).
 * Devuelve el usuario leído de la BD.
 */
export async function requireAdmin(db: Db | Tx, user: SessionUser | null | undefined, permission: Permission): Promise<SessionUser> {
  assertCan(user, permission);
  const row = user.id ? await db.adminUser.findUnique({ where: { id: user.id }, select: { id: true, email: true, name: true, role: true, active: true, totpEnabledAt: true } }) : null;
  if (!row || !row.active) throw new DomainError("UNAUTHORIZED", "Tu usuario del panel no existe o está desactivado.");
  assertCan(row, permission);
  if (!row.totpEnabledAt && (await twoFactorRequired(db))) {
    throw new DomainError("FORBIDDEN", "El equipo exige la verificación en dos pasos: actívala en Mi cuenta para seguir usando el panel.");
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

/** ¿Configuración exige verificación en dos pasos a todo el equipo? */
export async function twoFactorRequired(db: Db | Tx): Promise<boolean> {
  const r = await db.setting.findUnique({ where: { key: REQUIRE_2FA_SETTING } });
  return !!(r?.value as { enabled?: boolean } | null)?.enabled;
}

// ───────────── Contraseñas ─────────────

export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < MIN_PASSWORD) throw new DomainError("VALIDATION", `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`, { field: "password" });
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ───────────── Sesiones ─────────────

export const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: SessionUser;
}

/** Paso 1: sesión directa, o desafío si el usuario tiene la verificación en dos pasos activada. */
export type LoginOutcome = ({ kind: "session" } & LoginResult) | ({ kind: "challenge" } & LoginResult);

interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const toSessionUser = (u: Pick<AdminUser, "id" | "email" | "name" | "role">): SessionUser => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const newToken = () => crypto.randomBytes(32).toString("base64url");

function assertNotLocked(user: Pick<AdminUser, "lockedUntil">, now: Date) {
  if (user.lockedUntil && user.lockedUntil > now) {
    const min = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000));
    throw new DomainError("FORBIDDEN", `Demasiados intentos fallidos. Por seguridad, espera ${min} ${min === 1 ? "minuto" : "minutos"} e inténtalo de nuevo.`);
  }
}

/** Suma un intento fallido; al quinto seguido bloquea la cuenta 15 minutos. */
async function registerFailure(db: Db, userId: string, now: Date) {
  const u = await db.adminUser.update({ where: { id: userId }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
  if (u.failedLogins >= MAX_FAILED_LOGINS) await db.adminUser.update({ where: { id: userId }, data: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) } });
}

/** Abre una sesión nueva (inicio de sesión, o la del propio navegador tras cambiar la contraseña). */
export async function createSession(db: Db, userId: string, meta: ClientMeta, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  await db.adminSession.create({ data: { tokenHash: hashToken(token), adminUserId: userId, expiresAt, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, lastSeenAt: now } });
  await db.adminUser.update({ where: { id: userId }, data: { lastLoginAt: now, failedLogins: 0, lockedUntil: null } });
  // limpieza oportunista de sesiones y desafíos vencidos de este usuario
  await db.adminSession.deleteMany({ where: { adminUserId: userId, expiresAt: { lt: now } } });
  await db.adminLoginChallenge.deleteMany({ where: { adminUserId: userId, expiresAt: { lt: now } } });
  return { token, expiresAt };
}

/**
 * Paso 1: valida credenciales. Mismo error para correo inexistente, inactivo o clave errada. Con la verificación en
 * dos pasos activada devuelve un desafío (salvo en un equipo recordado: `deviceToken`).
 */
export async function login(
  db: Db,
  input: { email: string; password: string; deviceToken?: string | null } & ClientMeta,
  now: Date = new Date(),
): Promise<LoginOutcome> {
  const email = input.email?.trim().toLowerCase() ?? "";
  const user = email ? await db.adminUser.findUnique({ where: { email } }) : null;
  const ok = await verifyPassword(input.password ?? "", user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active) throw new DomainError("UNAUTHORIZED", "Correo o contraseña incorrectos.");
  assertNotLocked(user, now);
  if (!ok) {
    await registerFailure(db, user.id, now);
    throw new DomainError("UNAUTHORIZED", "Correo o contraseña incorrectos.");
  }
  if (user.totpSecret && user.totpEnabledAt) {
    const device = input.deviceToken ? await db.adminTrustedDevice.findUnique({ where: { tokenHash: hashToken(input.deviceToken) } }) : null;
    if (!device || device.adminUserId !== user.id || device.expiresAt <= now) {
      const token = newToken();
      const expiresAt = new Date(now.getTime() + ADMIN_CHALLENGE_TTL_MS);
      await db.adminLoginChallenge.create({ data: { tokenHash: hashToken(token), adminUserId: user.id, expiresAt, ip: input.ip ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null } });
      if (user.failedLogins) await db.adminUser.update({ where: { id: user.id }, data: { failedLogins: 0 } });
      return { kind: "challenge", token, expiresAt, user: toSessionUser(user) };
    }
    await db.adminTrustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: now } });
  }
  const s = await createSession(db, user.id, input, now);
  return { kind: "session", ...s, user: toSessionUser(user) };
}

export interface ChallengeResult extends LoginResult {
  /** Token de «Recordar este equipo» si se pidió. */
  device?: { token: string; expiresAt: Date };
  /** Se entró con un código de recuperación: cuántos quedan. */
  recoveryLeft?: number;
}

/**
 * Paso 2: código de la app autenticadora (o de recuperación con `recovery`). Cada código incorrecto cuenta para el
 * bloqueo de la cuenta; al quinto en el mismo desafío hay que volver a escribir la contraseña.
 */
export async function completeLoginChallenge(
  db: Db,
  input: { token: string | null | undefined; code: string; recovery?: boolean; remember?: boolean } & ClientMeta,
  now: Date = new Date(),
): Promise<ChallengeResult> {
  const c = input.token ? await db.adminLoginChallenge.findUnique({ where: { tokenHash: hashToken(input.token) }, include: { adminUser: true } }) : null;
  if (!c || c.expiresAt <= now || !c.adminUser.active || !c.adminUser.totpSecret) {
    if (c) await db.adminLoginChallenge.deleteMany({ where: { id: c.id } });
    throw new DomainError("UNAUTHORIZED", "La verificación venció. Vuelve a escribir tu correo y contraseña.");
  }
  const user = c.adminUser;
  assertNotLocked(user, now);
  let ok = false;
  let recoveryLeft: number | undefined;
  if (input.recovery) {
    const rest = consumeRecoveryCode(user.recoveryCodes, input.code);
    // Solo si nadie lo usó en paralelo (la lista sigue igual que al leerla).
    if (rest) ok = (await db.adminUser.updateMany({ where: { id: user.id, recoveryCodes: user.recoveryCodes }, data: { recoveryCodes: JSON.stringify(rest) } })).count === 1;
    if (ok) recoveryLeft = rest!.length;
  } else {
    const step = verifyTotp(openSecret(user.totpSecret!), input.code, now, user.totpLastStep);
    // Un mismo código no entra dos veces, ni siquiera en dos intentos simultáneos.
    if (step != null) ok = (await db.adminUser.updateMany({ where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } })).count === 1;
  }
  if (!ok) {
    await registerFailure(db, user.id, now);
    const left = await db.adminLoginChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } }, select: { attempts: true } });
    if (left.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      await db.adminLoginChallenge.deleteMany({ where: { id: c.id } });
      throw new DomainError("UNAUTHORIZED", "Demasiados códigos incorrectos. Vuelve a escribir tu correo y contraseña.");
    }
    throw new DomainError("UNAUTHORIZED", input.recovery ? "Ese código de recuperación no es válido o ya se usó." : "Código incorrecto. Escribe el que muestra ahora la app (cambia cada 30 segundos).");
  }
  await db.adminLoginChallenge.deleteMany({ where: { id: c.id } });
  const s = await createSession(db, user.id, input, now);
  let device: ChallengeResult["device"];
  if (input.remember) {
    const token = newToken();
    const expiresAt = new Date(now.getTime() + ADMIN_DEVICE_TTL_MS);
    await db.adminTrustedDevice.create({ data: { tokenHash: hashToken(token), adminUserId: user.id, expiresAt, userAgent: input.userAgent?.slice(0, 300) ?? null, lastUsedAt: now } });
    device = { token, expiresAt };
  }
  return { ...s, user: toSessionUser(user), device, recoveryLeft };
}

/** Correo del desafío en curso (para mostrarlo en el paso 2), o null si venció. */
export async function pendingChallengeEmail(db: Db, token: string | null | undefined, now: Date = new Date()): Promise<string | null> {
  if (!token) return null;
  const c = await db.adminLoginChallenge.findUnique({ where: { tokenHash: hashToken(token) }, select: { expiresAt: true, adminUser: { select: { email: true, active: true } } } });
  return c && c.expiresAt > now && c.adminUser.active ? c.adminUser.email : null;
}

export interface ActiveSession {
  session: Pick<AdminSession, "id" | "expiresAt">;
  user: SessionUser;
}

/** Sesión vigente para el token de la cookie, o null (vencida, revocada o usuario desactivado). */
export async function getAdminSession(db: Db | Tx, token: string | null | undefined, now: Date = new Date()): Promise<ActiveSession | null> {
  if (!token) return null;
  const s = await db.adminSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { adminUser: true } });
  if (!s) return null;
  if (s.expiresAt <= now || !s.adminUser.active) {
    await db.adminSession.deleteMany({ where: { id: s.id } });
    return null;
  }
  const user: SessionUser = { id: s.adminUser.id, email: s.adminUser.email, name: s.adminUser.name, role: s.adminUser.role };
  // Última actividad (para «Sesiones abiertas» en Mi cuenta), a lo sumo una escritura cada 5 minutos.
  if (!s.lastSeenAt || now.getTime() - s.lastSeenAt.getTime() > 5 * 60_000) await db.adminSession.updateMany({ where: { id: s.id }, data: { lastSeenAt: now } });
  return { session: { id: s.id, expiresAt: s.expiresAt }, user };
}

export async function logout(db: Db, token: string | null | undefined): Promise<void> {
  if (token) await db.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Cierra todas las sesiones del usuario (cambio de contraseña, desactivación). */
export async function revokeAllSessions(db: Db, adminUserId: string): Promise<number> {
  return (await db.adminSession.deleteMany({ where: { adminUserId } })).count;
}

export async function changePassword(db: Db, adminUserId: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    const u = await tx.adminUser.update({ where: { id: adminUserId }, data: { passwordHash }, select: { id: true, email: true } });
    await tx.adminSession.deleteMany({ where: { adminUserId } });
    await tx.adminTrustedDevice.deleteMany({ where: { adminUserId } });
    await recordAudit(tx, { actor: u, action: "admin_user.password_change", entityType: "AdminUser", entityId: adminUserId, force: true });
  });
}

/** Opciones de la cookie de sesión (para `cookies().set(ADMIN_SESSION_COOKIE, token, adminCookieOptions(exp))`). */
export function adminCookieOptions(expiresAt: Date, env: NodeJS.ProcessEnv = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production" && !(env.APP_URL ?? "").startsWith("http://localhost"),
    path: "/",
    expires: expiresAt,
  };
}
