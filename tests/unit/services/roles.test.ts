// Roles del panel (superadministrador, administrador comercial, asistente): permisos de cada uno, jerarquía del
// equipo (el comercial solo gestiona asistentes), invitaciones y enlaces de acceso de un solo uso.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { resetTwoFactorFor } from "@/server/admin-account";
import { readAccessLink, INVITE_TTL_MS } from "@/server/admin-access";
import { assignableRoles, canManageRole } from "@/server/admin-roles";
import { updateSetting } from "@/server/admin-settings";
import { can, getAdminSession, hashPassword, login, type Permission, type SessionUser } from "@/server/auth";
import { upsertSede } from "@/server/catalog";
import { adjustBalance } from "@/server/corrections";
import { refundPayment } from "@/server/payments";
import { SETTING_KEYS } from "@/server/settings";
import { cancelInvitation, inviteAdminUser, listTeam, sendAccessLink, setPasswordWithAccessLink, updateAdminUser } from "@/server/admin-users";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let admin: SessionUser;
let commercial: SessionUser;
let commercial2: SessionUser;
let staff: SessionUser;
const PASS = "clave-larga-del-equipo-1";

async function member(email: string, role: AdminRole): Promise<SessionUser> {
  const u = await ctx.db.adminUser.create({ data: { email, name: email.split("@")[0]!, role, passwordHash: await hashPassword(PASS) }, select: { id: true, email: true, name: true, role: true } });
  return u;
}
const tokenOf = (link: string) => link.split("/admin/acceso/")[1]!;

beforeEach(async () => {
  ctx = await setupContext("roles");
  admin = ctx.fx.admin;
  staff = ctx.fx.staff;
  commercial = await member("ventas@ceium.net", "COMMERCIAL");
  commercial2 = await member("ventas2@ceium.net", "COMMERCIAL");
});
afterEach(async () => {
  await ctx.dispose();
});

describe("permisos por rol", () => {
  it("el comercial gestiona la academia y verifica pagos; el dinero que sale y la configuración son del superadministrador", () => {
    const yes: Permission[] = ["orders.view", "payments.verify", "catalog.manage", "cohorts.manage", "enrollments.manage", "certificates.revoke", "users.manage", "orders.cancel"];
    const no: Permission[] = ["settings.manage", "payments.refund", "orders.adjustBalance"];
    for (const p of yes) expect(can(commercial, p), p).toBe(true);
    for (const p of no) expect(can(commercial, p), p).toBe(false);
    for (const p of [...yes, ...no]) expect(can(admin, p), p).toBe(true);
    expect(can(staff, "catalog.manage")).toBe(false);
    expect(can(staff, "users.manage")).toBe(false);
    expect(can(staff, "payments.verify")).toBe(true);
  });

  it("jerarquía: el superadministrador asigna cualquier rol; el comercial solo asistentes; el asistente ninguno", () => {
    expect(assignableRoles("ADMIN")).toEqual(["ADMIN", "COMMERCIAL", "STAFF"]);
    expect(assignableRoles("COMMERCIAL")).toEqual(["STAFF"]);
    expect(assignableRoles("STAFF")).toEqual([]);
    expect(canManageRole("COMMERCIAL", "COMMERCIAL")).toBe(false);
    expect(canManageRole("ADMIN", "ADMIN")).toBe(true);
  });

  it("el comercial no cambia métodos de pago ni hace reembolsos o ajustes; sí edita el catálogo", async () => {
    await expect(updateSetting(ctx.d, commercial, SETTING_KEYS.paypal, { enabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateSetting(ctx.d, commercial, SETTING_KEYS.manualMethods, [])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adjustBalance(ctx.d, commercial, "x", -100, "descuento")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refundPayment(ctx.d, commercial, { paymentId: "x", amountUsdCents: 100, reason: "r" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const sede = await upsertSede(ctx.d, commercial, { slug: "valencia", name: "Valencia" } as never);
    expect(sede).toMatchObject({ slug: "valencia" });
  });
});

describe("equipo", () => {
  it("el comercial invita asistentes, pero no administradores", async () => {
    await expect(inviteAdminUser(ctx.d, commercial, { email: "x@ceium.net", name: "X", role: "COMMERCIAL" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(inviteAdminUser(ctx.d, commercial, { email: "x@ceium.net", name: "X", role: "ADMIN" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(inviteAdminUser(ctx.d, staff, { email: "x@ceium.net", name: "X", role: "STAFF" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await inviteAdminUser(ctx.d, commercial, { email: "Caja@CEIUM.net", name: "Caja Uno", role: "STAFF" });
    expect(r).toMatchObject({ kind: "invite", emailed: true, user: { email: "caja@ceium.net", role: "STAFF" } });
    expect(r.expiresAt.getTime() - ctx.clock.now().getTime()).toBe(INVITE_TTL_MS);
  });

  it("el comercial no desactiva, no cambia de rol ni restablece a otro comercial o al superadministrador; a un asistente sí", async () => {
    for (const target of [commercial2, admin]) {
      await expect(updateAdminUser(ctx.d, commercial, target.id, { active: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(updateAdminUser(ctx.d, commercial, target.id, { role: "STAFF" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(sendAccessLink(ctx.d, commercial, target.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(resetTwoFactorFor(ctx.d, commercial, target.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // Tampoco asciende a un asistente.
    await expect(updateAdminUser(ctx.d, commercial, staff.id, { role: "COMMERCIAL" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const off = await updateAdminUser(ctx.d, commercial, staff.id, { active: false });
    expect(off.active).toBe(false);
    await updateAdminUser(ctx.d, commercial, staff.id, { active: true });
    // El superadministrador sí gestiona a los comerciales.
    expect((await updateAdminUser(ctx.d, admin, commercial2.id, { active: false })).active).toBe(false);
  });

  it("nadie cambia su propio rol ni se desactiva; siempre queda un superadministrador activo", async () => {
    await expect(updateAdminUser(ctx.d, commercial, commercial.id, { role: "ADMIN" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(updateAdminUser(ctx.d, admin, admin.id, { active: false })).rejects.toMatchObject({ code: "CONFLICT" });
    // Su propio nombre sí.
    expect((await updateAdminUser(ctx.d, commercial, commercial.id, { name: "Ventas CEIUM" })).name).toBe("Ventas CEIUM");
    // Un superadministrador cambia el rol de otro; el que queda no puede quitárselo.
    const boss2 = await member("socio@ceium.net", "ADMIN");
    expect((await updateAdminUser(ctx.d, boss2, admin.id, { role: "COMMERCIAL" })).role).toBe("COMMERCIAL");
    await expect(updateAdminUser(ctx.d, boss2, boss2.id, { role: "STAFF" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ctx.db.adminUser.count({ where: { role: "ADMIN", active: true } })).toBe(1);
  });

  it("un cambio de rol cierra sus sesiones y le avisa por correo", async () => {
    await ctx.db.adminUser.update({ where: { id: staff.id }, data: { passwordHash: await hashPassword(PASS) } });
    const ok = await login(ctx.db, { email: staff.email, password: PASS });
    await updateAdminUser(ctx.d, admin, staff.id, { role: "COMMERCIAL" });
    expect(await getAdminSession(ctx.db, ok.token)).toBeNull();
    const mail = await ctx.db.emailOutbox.findFirst({ where: { to: staff.email, template: "admin_security" } });
    expect(mail?.subject).toBe("Cambió tu rol en el panel de CEIUM");
    expect(mail?.text).toContain("Administrador comercial");
  });

  it("listTeam: el comercial ve a todos, pero solo puede gestionar a los asistentes", async () => {
    const t = await listTeam(ctx.d, commercial);
    expect(t.assignable).toEqual(["STAFF"]);
    const byEmail = Object.fromEntries(t.users.map((u) => [u.email, u]));
    expect(byEmail[staff.email]!.manageable).toBe(true);
    expect(byEmail[commercial2.email]!.manageable).toBe(false);
    expect(byEmail[admin.email]!.manageable).toBe(false);
    expect(byEmail[commercial.email]).toMatchObject({ me: true, manageable: false });
    await expect(listTeam(ctx.d, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("enlace de acceso", () => {
  it("invitación: crea la contraseña una sola vez, luego inicia sesión; el enlace no queda guardado en ningún lado", async () => {
    const r = await inviteAdminUser(ctx.d, admin, { email: "nueva@ceium.net", name: "Ana Nueva", role: "COMMERCIAL" });
    const token = tokenOf(r.link);
    // Antes de crearla no puede entrar.
    await expect(login(ctx.db, { email: "nueva@ceium.net", password: "cualquier-cosa-123" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await readAccessLink(ctx.db, token, ctx.clock.now())).toMatchObject({ kind: "invite", email: "nueva@ceium.net", role: "COMMERCIAL" });
    await expect(setPasswordWithAccessLink(ctx.d, token, "corta")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await setPasswordWithAccessLink(ctx.d, token, "mi-clave-nueva-2026")).toEqual({ email: "nueva@ceium.net", kind: "invite" });
    await expect(setPasswordWithAccessLink(ctx.d, token, "otra-clave-2026-xx")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const s = await login(ctx.db, { email: "nueva@ceium.net", password: "mi-clave-nueva-2026" });
    expect(s.user.role).toBe("COMMERCIAL");
    const u = await ctx.db.adminUser.findUniqueOrThrow({ where: { email: "nueva@ceium.net" } });
    expect(u).toMatchObject({ invitePending: false, setupTokenHash: null });
    // Ni en la bandeja de correo ni en la copia .eml.
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { to: "nueva@ceium.net", template: "admin_access" } });
    expect(mail.status).toBe("SENT");
    expect(mail.html + mail.text).not.toContain(token);
    const emls = fs.readdirSync(ctx.mailDir).map((f) => fs.readFileSync(path.join(ctx.mailDir, f), "utf8")).join("\n");
    expect(emls).not.toContain(token);
    expect(emls).toContain("Te invitaron al panel de CEIUM");
  });

  it("el enlace vence, se anula al emitir otro o al desactivar la cuenta", async () => {
    const r = await inviteAdminUser(ctx.d, admin, { email: "tarde@ceium.net", name: "Tarde", role: "STAFF" });
    ctx.clock.advance(INVITE_TTL_MS + 1000);
    await expect(setPasswordWithAccessLink(ctx.d, tokenOf(r.link), "mi-clave-nueva-2026")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listTeam(ctx.d, admin)).users.find((u) => u.email === "tarde@ceium.net")).toMatchObject({ invitePending: true, inviteExpired: true });
    const again = await sendAccessLink(ctx.d, admin, r.user.id);
    expect(again.kind).toBe("invite");
    const third = await sendAccessLink(ctx.d, admin, r.user.id);
    expect(await readAccessLink(ctx.db, tokenOf(again.link), ctx.clock.now())).toBeNull();
    await updateAdminUser(ctx.d, admin, r.user.id, { active: false });
    expect(await readAccessLink(ctx.db, tokenOf(third.link), ctx.clock.now())).toBeNull();
    await expect(sendAccessLink(ctx.d, admin, r.user.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("restablecer: la contraseña actual sirve hasta usar el enlace; al usarlo se cierran sus sesiones y se le avisa", async () => {
    const before = await login(ctx.db, { email: commercial.email, password: PASS });
    const r = await sendAccessLink(ctx.d, admin, commercial.id);
    expect(r.kind).toBe("reset");
    expect(await login(ctx.db, { email: commercial.email, password: PASS })).toMatchObject({ kind: "session" });
    await setPasswordWithAccessLink(ctx.d, tokenOf(r.link), "clave-nueva-de-ventas-9");
    expect(await getAdminSession(ctx.db, before.token)).toBeNull();
    await expect(login(ctx.db, { email: commercial.email, password: PASS })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await login(ctx.db, { email: commercial.email, password: "clave-nueva-de-ventas-9" })).toMatchObject({ kind: "session" });
    const notice = await ctx.db.emailOutbox.findFirst({ where: { to: commercial.email, template: "admin_security" } });
    expect(notice?.subject).toBe("Cambiaste la contraseña del panel");
  });

  it("si el envío falla, el reintento emite otro enlace (el original nunca se guardó)", async () => {
    const r = await inviteAdminUser(ctx.d, admin, { email: "reintento@ceium.net", name: "Reintento", role: "STAFF" });
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { to: "reintento@ceium.net", template: "admin_access" } });
    await ctx.db.emailOutbox.update({ where: { id: mail.id }, data: { status: "FAILED" } });
    const { deliverOutboxEmail } = await import("@/server/email");
    expect(await deliverOutboxEmail(ctx.d, mail.id)).toBe("SENT");
    // El enlace que vio quien invitó ya no sirve: vale el del correo reenviado.
    expect(await readAccessLink(ctx.db, tokenOf(r.link), ctx.clock.now())).toBeNull();
    expect((await ctx.db.adminUser.findUniqueOrThrow({ where: { id: r.user.id } })).setupTokenHash).not.toBeNull();
    // Usado (o cancelado) el enlace, un reintento ya no envía nada.
    await cancelInvitation(ctx.d, admin, r.user.id);
    await ctx.db.emailOutbox.update({ where: { id: mail.id }, data: { status: "FAILED" } });
    expect(await deliverOutboxEmail(ctx.d, mail.id)).toBe("FAILED");
  });

  it("cancelar invitación: solo si nunca creó su contraseña, y respetando la jerarquía", async () => {
    const r = await inviteAdminUser(ctx.d, admin, { email: "jefe2@ceium.net", name: "Jefe Dos", role: "COMMERCIAL" });
    await expect(cancelInvitation(ctx.d, commercial, r.user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cancelInvitation(ctx.d, admin, staff.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await cancelInvitation(ctx.d, admin, r.user.id);
    expect(await ctx.db.adminUser.findUnique({ where: { id: r.user.id } })).toBeNull();
    const log = await ctx.db.auditLog.findMany({ where: { entityId: r.user.id }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => l.action)).toEqual(["admin_user.invite", "admin_user.invite_cancel"]);
  });
});
