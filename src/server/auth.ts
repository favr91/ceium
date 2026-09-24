// Autenticación y roles del panel (/admin). Independiente de Next: las rutas/acciones del panel leen la
// cookie y llaman a estas funciones.
//   const s = await getAdminSession(prisma, cookies().get(ADMIN_SESSION_COOKIE)?.value);
//   assertCan(s?.user, "payments.refund");
//
// Sesiones opacas en BD (AdminSession): la cookie lleva un token aleatorio de 256 bits; en BD solo se guarda
// su sha256 (un volcado de la BD no permite suplantar). Expiración absoluta (12 h por defecto) y renovación
// deslizante cuando queda menos de la mitad. Desactivar un usuario invalida sus sesiones al instante.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { AdminRole, AdminSession, AdminUser } from "@/generated/prisma/client";
import type { Db, Tx } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { recordAudit } from "@/server/audit";

export const ADMIN_SESSION_COOKIE = "ceium_admin";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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

/** Valida credenciales y crea la sesión. Mismo error para correo inexistente, inactivo o clave errada. */
export async function login(
  db: Db,
  input: { email: string; password: string; ip?: string | null; userAgent?: string | null },
  now: Date = new Date(),
): Promise<LoginResult> {
  const email = input.email?.trim().toLowerCase() ?? "";
  const user = email ? await db.adminUser.findUnique({ where: { email } }) : null;
  const ok = await verifyPassword(input.password ?? "", user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active || !ok) throw new DomainError("UNAUTHORIZED", "Correo o contraseña incorrectos.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  await db.adminSession.create({ data: { tokenHash: hashToken(token), adminUserId: user.id, expiresAt, ip: input.ip ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null } });
  await db.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  // limpieza oportunista de sesiones vencidas de este usuario
  await db.adminSession.deleteMany({ where: { adminUserId: user.id, expiresAt: { lt: now } } });
  return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

export interface ActiveSession {
  session: Pick<AdminSession, "id" | "expiresAt">;
  user: SessionUser;
  /** Nueva expiración si se renovó (la ruta debe reescribir la cookie). */
  renewedUntil?: Date;
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
  if (s.expiresAt.getTime() - now.getTime() < ADMIN_SESSION_TTL_MS / 2) {
    const renewedUntil = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
    await db.adminSession.update({ where: { id: s.id }, data: { expiresAt: renewedUntil } });
    return { session: { id: s.id, expiresAt: renewedUntil }, user, renewedUntil };
  }
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
