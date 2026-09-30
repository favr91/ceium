// Equipo del panel: invitar (enlace para crear la contraseña), cambiar nombre o rol, desactivar y reactivar, enviar un
// enlace para restablecer la contraseña y cancelar invitaciones. Todo con auditoría (el hash nunca se guarda en
// AuditLog) y aviso por correo a la persona afectada.
//
// Jerarquía (admin-roles.ts): el super administrador gestiona a todos; el administrador comercial, solo a los
// asistentes (ni a otros administradores comerciales ni al super administrador). Nadie cambia su propio rol ni se
// desactiva a sí mismo (su cuenta se gestiona en Mi cuenta), y siempre queda al menos un super administrador activo.
// Las cuentas no se borran (su nombre sigue en el historial de pagos y pedidos): se desactivan. Solo una invitación
// que nunca se usó se puede eliminar.
import crypto from "node:crypto";
import { z } from "zod";
import type { AdminRole } from "@/generated/prisma/client";
import { accessLinkUrl, issueAccessToken, readAccessLink, type AccessLinkKind } from "@/server/admin-access";
import { ADMIN_ROLES, ROLE_LABEL, assignableRoles, canManageRole } from "@/server/admin-roles";
import { hashPassword, hashToken, requireAdmin, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps, type Tx } from "@/server/deps";
import { sendEmail, TEMP_PASSWORD_PLACEHOLDER } from "@/server/email";
import * as T from "@/server/email/templates";
import { DomainError, isUniqueViolation } from "@/server/errors";

const password = z.string().min(10, "La contraseña debe tener al menos 10 caracteres").max(72, "La contraseña puede tener hasta 72 caracteres");
const email = z.email("Escribe un correo válido").max(200).transform((e) => e.toLowerCase());
const name = z.string().trim().min(1, "Escribe el nombre").max(200);
const role = z.enum(ADMIN_ROLES);

export const inviteAdminUserSchema = z.object({ email, name, role }).strict();
export const createAdminUserSchema = z.object({ email, name, role, password }).strict();
export const updateAdminUserSchema = z.object({ name, role, active: z.boolean() }).partial().strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("VALIDATION", r.error.issues.map((i) => i.message).join(". "), { issues: r.error.issues });
  return r.data;
}

const publicUser = { id: true, email: true, name: true, role: true, active: true, invitePending: true, lastLoginAt: true, createdAt: true, updatedAt: true } as const;

async function assertAnotherActiveAdmin(tx: Tx, exceptId: string) {
  const others = await tx.adminUser.count({ where: { role: "ADMIN", active: true, invitePending: false, id: { not: exceptId } } });
  if (!others) throw new DomainError("CONFLICT", "Debe quedar al menos un super administrador activo.");
}

function assertAssignable(actor: SessionUser, target: AdminRole) {
  if (!canManageRole(actor.role, target)) throw new DomainError("FORBIDDEN", `Tu rol no puede dar el rol «${ROLE_LABEL[target]}». Pídeselo al super administrador.`);
}

/** Otra persona del equipo que `actor` puede gestionar (la propia cuenta se gestiona en Mi cuenta). */
function assertManageable(actor: SessionUser, target: { id: string; role: AdminRole }) {
  if (target.id === actor.id) throw new DomainError("CONFLICT", "No puedes cambiar tu propio rol ni desactivar tu cuenta: tu contraseña y tu seguridad se gestionan en Mi cuenta.");
  if (!canManageRole(actor.role, target.role)) throw new DomainError("FORBIDDEN", `Solo el super administrador puede gestionar a un ${ROLE_LABEL[target.role].toLowerCase()}.`);
}

const firstName = (n: string) => n.split(" ")[0] || n;

/** Aviso de seguridad a la persona afectada; un fallo de correo no deshace el cambio. */
async function notify(d: Deps, user: { id: string; email: string; name: string }, event: T.AdminSecurityEvent, extra: { by?: string; role?: string } = {}) {
  try {
    await sendEmail(d, {
      template: "admin_security",
      to: user.email,
      rendered: T.adminSecurityNotice({ name: firstName(user.name), event, at: d.now(), accountUrl: `${d.config.appUrl}/admin/account`, ...extra }),
      actor: { type: "ADMIN", id: user.id },
    });
  } catch (e) {
    d.log.warn("[admin-users] no se pudo enviar el aviso de seguridad", e);
  }
}

export interface AccessLinkResult {
  kind: AccessLinkKind;
  /** Enlace completo: se muestra UNA vez a quien lo generó (por si el correo no llega) y no se guarda. */
  link: string;
  expiresAt: Date;
  emailed: boolean;
}

/** Emite el enlace y lo envía por correo (el token viaja como secreto: no queda en la bandeja). */
async function deliverAccessLink(d: Deps, actor: SessionUser, target: { id: string; email: string; name: string; role: AdminRole }): Promise<AccessLinkResult> {
  const { token, expiresAt, kind } = await issueAccessToken(d.db, target.id, d.now());
  let emailed = false;
  try {
    const r = await sendEmail(d, {
      template: "admin_access",
      to: target.email,
      rendered: T.adminAccessLink({ name: firstName(target.name), kind, link: accessLinkUrl(d.config.appUrl, TEMP_PASSWORD_PLACEHOLDER), expiresAt, by: actor.name, role: ROLE_LABEL[target.role] }),
      secret: { kind: "admin_access_link", adminUserId: target.id, value: token },
      actor: { type: "ADMIN", id: actor.id },
    });
    emailed = r.status === "SENT";
  } catch (e) {
    d.log.warn("[admin-users] no se pudo enviar el enlace de acceso", e);
  }
  return { kind, link: accessLinkUrl(d.config.appUrl, token), expiresAt, emailed };
}

// ───────────── Lectura ─────────────

export async function listTeam(d: Pick<Deps, "db" | "now">, actor: SessionUser) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const now = d.now();
  const rows = await d.db.adminUser.findMany({
    select: { ...publicUser, totpEnabledAt: true, setupTokenExpiresAt: true, lockedUntil: true },
  });
  const rank = (r: AdminRole) => ADMIN_ROLES.indexOf(r);
  rows.sort((a, b) => Number(b.active) - Number(a.active) || rank(a.role) - rank(b.role) || a.name.localeCompare(b.name, "es"));
  return {
    me: actor,
    assignable: assignableRoles(actor.role),
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      invitePending: u.invitePending,
      inviteExpired: u.invitePending && (!u.setupTokenExpiresAt || u.setupTokenExpiresAt <= now),
      twoFactor: !!u.totpEnabledAt,
      locked: !!u.lockedUntil && u.lockedUntil > now,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      me: u.id === actor.id,
      manageable: u.id !== actor.id && canManageRole(actor.role, u.role),
    })),
  };
}
export type TeamOverview = Awaited<ReturnType<typeof listTeam>>;

// ───────────── Altas ─────────────

/** Invita a alguien: cuenta sin contraseña + enlace (72 h) para crearla. */
export async function inviteAdminUser(d: Deps, actor: SessionUser, input: z.input<typeof inviteAdminUserSchema>): Promise<AccessLinkResult & { user: { id: string; email: string; name: string; role: AdminRole } }> {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const p = parse(inviteAdminUserSchema, input);
  assertAssignable(actor, p.role);
  // Contraseña imposible de adivinar hasta que la cree con el enlace.
  const passwordHash = await hashPassword(crypto.randomBytes(32).toString("base64url"));
  const user = await withTx(d, async (tx) => {
    let u;
    try {
      u = await tx.adminUser.create({ data: { email: p.email, name: p.name, role: p.role, passwordHash, invitePending: true }, select: publicUser });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya hay una cuenta con ese correo en el equipo (si está desactivada, reactívala).");
      throw e;
    }
    await recordAudit(tx, { actor, action: "admin_user.invite", entityType: "AdminUser", entityId: u.id, before: null, after: u, force: true });
    return u;
  });
  const link = await deliverAccessLink(d, actor, user);
  return { ...link, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

/** Alta directa con contraseña (scripts y pruebas; el panel usa inviteAdminUser). */
export async function createAdminUser(d: Deps, actor: SessionUser, input: z.input<typeof createAdminUserSchema>) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const p = parse(createAdminUserSchema, input);
  assertAssignable(actor, p.role);
  const passwordHash = await hashPassword(p.password);
  return withTx(d, async (tx) => {
    let user;
    try {
      user = await tx.adminUser.create({ data: { email: p.email, name: p.name, role: p.role, passwordHash }, select: publicUser });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya existe un usuario con ese correo.");
      throw e;
    }
    await recordAudit(tx, { actor, action: "admin_user.create", entityType: "AdminUser", entityId: user.id, before: null, after: user, force: true });
    return user;
  });
}

// ───────────── Cambios ─────────────

/** Nombre, rol o estado. Desactivar o cambiar el rol cierra sus sesiones abiertas (y anula su enlace pendiente). */
export async function updateAdminUser(d: Deps, actor: SessionUser, userId: string, input: z.input<typeof updateAdminUserSchema>, note?: string) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const p = parse(updateAdminUserSchema, input);
  const r = await withTx(d, async (tx) => {
    const before = await tx.adminUser.findUnique({ where: { id: userId }, select: publicUser });
    if (!before) throw new DomainError("NOT_FOUND", "El usuario no existe.");
    const roleChange = !!p.role && p.role !== before.role;
    const deactivate = p.active === false && before.active;
    if (roleChange || p.active !== undefined || before.id !== actor.id) assertManageable(actor, before);
    if (p.role) assertAssignable(actor, p.role);
    if (before.role === "ADMIN" && before.active && (roleChange || deactivate)) await assertAnotherActiveAdmin(tx, userId);
    const after = await tx.adminUser.update({
      where: { id: userId },
      data: { ...p, ...(deactivate ? { setupTokenHash: null, setupTokenExpiresAt: null } : {}) },
      select: publicUser,
    });
    if (deactivate || roleChange) {
      await tx.adminSession.deleteMany({ where: { adminUserId: userId } });
      await tx.adminLoginChallenge.deleteMany({ where: { adminUserId: userId } });
    }
    await recordAudit(tx, { actor, action: "admin_user.update", entityType: "AdminUser", entityId: userId, before, after, note });
    return { after, roleChange };
  });
  if (r.roleChange && !r.after.invitePending) await notify(d, r.after, "role_changed", { by: actor.name, role: ROLE_LABEL[r.after.role] });
  return r.after;
}

/**
 * Enlace de acceso para otra persona del equipo: si aún no creó su contraseña, reenvía la invitación (72 h); si ya
 * entraba, un enlace para crear una nueva (24 h; la actual sigue sirviendo hasta que la cambie).
 */
export async function sendAccessLink(d: Deps, actor: SessionUser, userId: string): Promise<AccessLinkResult> {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const target = await d.db.adminUser.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true, active: true, invitePending: true } });
  if (!target) throw new DomainError("NOT_FOUND", "El usuario no existe.");
  assertManageable(actor, target);
  if (!target.active) throw new DomainError("CONFLICT", "La cuenta está desactivada: reactívala antes de enviarle un enlace.");
  const r = await deliverAccessLink(d, actor, target);
  await withTx(d, (tx) => recordAudit(tx, { actor, action: target.invitePending ? "admin_user.invite_resend" : "admin_user.password_link", entityType: "AdminUser", entityId: userId, note: r.emailed ? `Enviado a ${target.email}` : "Enlace generado (el correo no salió)", force: true }));
  return r;
}

/** Elimina una invitación que nunca se usó (la cuenta no llegó a entrar: no tiene historial). */
export async function cancelInvitation(d: Deps, actor: SessionUser, userId: string) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  await withTx(d, async (tx) => {
    const u = await tx.adminUser.findUnique({ where: { id: userId }, select: publicUser });
    if (!u) throw new DomainError("NOT_FOUND", "El usuario no existe.");
    assertManageable(actor, u);
    if (!u.invitePending || u.lastLoginAt) throw new DomainError("CONFLICT", "Esta persona ya creó su contraseña: desactiva su acceso en lugar de eliminarla.");
    await tx.adminUser.delete({ where: { id: userId } });
    await recordAudit(tx, { actor, action: "admin_user.invite_cancel", entityType: "AdminUser", entityId: userId, before: u, after: null, force: true });
  });
  return { ok: true };
}

/** Restablece la contraseña de otro usuario (o la propia) y cierra sus sesiones (scripts y pruebas). */
export async function resetAdminPassword(d: Deps, actor: SessionUser, userId: string, newPassword: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const pw = parse(password, newPassword);
  const passwordHash = await hashPassword(pw);
  return withTx(d, async (tx) => {
    const user = await tx.adminUser.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!user) throw new DomainError("NOT_FOUND", "El usuario no existe.");
    if (user.id !== actor.id) assertManageable(actor, user);
    await tx.adminUser.update({ where: { id: userId }, data: { passwordHash, invitePending: false, setupTokenHash: null, setupTokenExpiresAt: null } });
    await tx.adminSession.deleteMany({ where: { adminUserId: userId } });
    await recordAudit(tx, { actor, action: "admin_user.password_reset", entityType: "AdminUser", entityId: userId, note, force: true });
    return { ok: true };
  });
}

// ───────────── Enlace de acceso (sin sesión) ─────────────

/**
 * La persona del enlace crea su contraseña. El enlace se consume en la misma escritura (dos envíos simultáneos: solo
 * uno pasa). Cierra sus sesiones y equipos recordados; la verificación en dos pasos, si la tenía, sigue igual.
 */
export async function setPasswordWithAccessLink(d: Deps, token: string, newPassword: string): Promise<{ email: string; kind: AccessLinkKind }> {
  const link = await readAccessLink(d.db, token, d.now());
  if (!link) throw new DomainError("NOT_FOUND", "Este enlace ya no es válido: se usó, venció o la cuenta fue desactivada. Pide uno nuevo a quien te invitó.");
  const passwordHash = await hashPassword(parse(password, newPassword));
  await withTx(d, async (tx) => {
    const n = await tx.adminUser.updateMany({
      where: { id: link.id, active: true, setupTokenHash: hashToken(token) },
      data: { passwordHash, invitePending: false, setupTokenHash: null, setupTokenExpiresAt: null, failedLogins: 0, lockedUntil: null },
    });
    if (n.count !== 1) throw new DomainError("NOT_FOUND", "Este enlace ya no es válido. Pide uno nuevo a quien te invitó.");
    await tx.adminSession.deleteMany({ where: { adminUserId: link.id } });
    await tx.adminTrustedDevice.deleteMany({ where: { adminUserId: link.id } });
    await recordAudit(tx, { actor: { id: link.id, email: link.email }, action: link.kind === "invite" ? "admin_user.invite_accept" : "admin_user.password_change", entityType: "AdminUser", entityId: link.id, note: "Con enlace de acceso", force: true });
  });
  if (link.kind === "reset") await notify(d, link, "password_changed");
  return { email: link.email, kind: link.kind };
}
