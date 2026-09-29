// Usuarios del panel: alta, cambio de rol/estado/nombre y restablecer contraseña, con auditoría
// (el hash nunca se guarda en AuditLog). Siempre queda al menos un ADMIN activo.
import { z } from "zod";
import { requireAdmin, hashPassword, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps, type Tx } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";

const password = z.string().min(10, "La contraseña debe tener al menos 10 caracteres").max(72, "La contraseña puede tener hasta 72 caracteres");

export const createAdminUserSchema = z.object({ email: z.email().transform((e) => e.toLowerCase()), name: z.string().trim().min(1).max(200), role: z.enum(["ADMIN", "STAFF"]), password }).strict();
export const updateAdminUserSchema = z.object({ name: z.string().trim().min(1).max(200), role: z.enum(["ADMIN", "STAFF"]), active: z.boolean() }).partial().strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("VALIDATION", r.error.issues.map((i) => i.message).join(". "), { issues: r.error.issues });
  return r.data;
}

const publicUser = { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true, updatedAt: true } as const;

async function assertAnotherActiveAdmin(tx: Tx, exceptId: string) {
  const others = await tx.adminUser.count({ where: { role: "ADMIN", active: true, id: { not: exceptId } } });
  if (!others) throw new DomainError("CONFLICT", "Debe quedar al menos un administrador activo.");
}

export async function createAdminUser(d: Deps, actor: SessionUser, input: z.input<typeof createAdminUserSchema>) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const p = parse(createAdminUserSchema, input);
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

/** Desactivar o bajar de rol cierra sus sesiones abiertas. */
export async function updateAdminUser(d: Deps, actor: SessionUser, userId: string, input: z.input<typeof updateAdminUserSchema>, note?: string) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const p = parse(updateAdminUserSchema, input);
  return withTx(d, async (tx) => {
    const before = await tx.adminUser.findUnique({ where: { id: userId }, select: publicUser });
    if (!before) throw new DomainError("NOT_FOUND", "El usuario no existe.");
    const losesAdmin = before.role === "ADMIN" && before.active && (p.role === "STAFF" || p.active === false);
    if (losesAdmin) await assertAnotherActiveAdmin(tx, userId);
    const after = await tx.adminUser.update({ where: { id: userId }, data: p, select: publicUser });
    if (p.active === false || (p.role && p.role !== before.role)) await tx.adminSession.deleteMany({ where: { adminUserId: userId } });
    await recordAudit(tx, { actor, action: "admin_user.update", entityType: "AdminUser", entityId: userId, before, after, note });
    return after;
  });
}

/** Restablece la contraseña de otro usuario (o la propia) y cierra sus sesiones. */
export async function resetAdminPassword(d: Deps, actor: SessionUser, userId: string, newPassword: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "users.manage");
  const pw = parse(password, newPassword);
  const passwordHash = await hashPassword(pw);
  return withTx(d, async (tx) => {
    const user = await tx.adminUser.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new DomainError("NOT_FOUND", "El usuario no existe.");
    await tx.adminUser.update({ where: { id: userId }, data: { passwordHash } });
    await tx.adminSession.deleteMany({ where: { adminUserId: userId } });
    await recordAudit(tx, { actor, action: "admin_user.password_reset", entityType: "AdminUser", entityId: userId, note, force: true });
    return { ok: true };
  });
}
