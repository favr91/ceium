import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SESSION_TTL_MS, assertCan, can, changePassword, getAdminSession, hashPassword, hashToken, login, logout } from "@/server/auth";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("auth");
  await ctx.db.adminUser.create({ data: { email: "staff@ceium.net", name: "Staff", role: "STAFF", passwordHash: await hashPassword("clave-staff-123") } });
});
afterEach(async () => {
  await ctx.dispose();
});

describe("auth del panel", () => {
  it("login correcto crea sesión (solo el hash del token en BD); errores idénticos para correo/clave/inactivo", async () => {
    const r = await login(ctx.db, { email: " Staff@CEIUM.net ", password: "clave-staff-123", ip: "1.2.3.4" }, ctx.clock.now());
    expect(r.user).toMatchObject({ email: "staff@ceium.net", role: "STAFF" });
    const row = await ctx.db.adminSession.findFirstOrThrow();
    expect(row.tokenHash).toBe(hashToken(r.token));
    expect(row.tokenHash).not.toContain(r.token);
    for (const bad of [{ email: "staff@ceium.net", password: "nope" }, { email: "nadie@ceium.net", password: "clave-staff-123" }]) {
      await expect(login(ctx.db, bad)).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "Correo o contraseña incorrectos." });
    }
    await ctx.db.adminUser.update({ where: { email: "staff@ceium.net" }, data: { active: false } });
    await expect(login(ctx.db, { email: "staff@ceium.net", password: "clave-staff-123" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // la sesión existente deja de valer al desactivar
    expect(await getAdminSession(ctx.db, r.token, ctx.clock.now())).toBeNull();
  });

  it("sesión vence, se renueva al pasar la mitad y logout / cambio de clave la revocan", async () => {
    const r = await login(ctx.db, { email: "staff@ceium.net", password: "clave-staff-123" }, ctx.clock.now());
    expect((await getAdminSession(ctx.db, r.token, ctx.clock.now()))?.renewedUntil).toBeUndefined();
    ctx.clock.advance(ADMIN_SESSION_TTL_MS * 0.75);
    const renewed = await getAdminSession(ctx.db, r.token, ctx.clock.now());
    expect(renewed?.renewedUntil?.getTime()).toBe(ctx.clock.now().getTime() + ADMIN_SESSION_TTL_MS);
    ctx.clock.advance(ADMIN_SESSION_TTL_MS + 1);
    expect(await getAdminSession(ctx.db, r.token, ctx.clock.now())).toBeNull();
    expect(await ctx.db.adminSession.count()).toBe(0);

    const r2 = await login(ctx.db, { email: "staff@ceium.net", password: "clave-staff-123" }, ctx.clock.now());
    await logout(ctx.db, r2.token);
    expect(await getAdminSession(ctx.db, r2.token, ctx.clock.now())).toBeNull();
    const r3 = await login(ctx.db, { email: "staff@ceium.net", password: "clave-staff-123" }, ctx.clock.now());
    await changePassword(ctx.db, r3.user.id, "otra-clave-larga");
    expect(await getAdminSession(ctx.db, r3.token, ctx.clock.now())).toBeNull();
    await expect(hashPassword("corta")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getAdminSession(ctx.db, "token-inventado", ctx.clock.now())).toBeNull();
  });

  it("roles: STAFF verifica pagos pero no reembolsa ni toca catálogo; ADMIN todo", () => {
    expect(can({ role: "STAFF" }, "payments.verify")).toBe(true);
    expect(can({ role: "STAFF" }, "payments.refund")).toBe(false);
    expect(can({ role: "STAFF" }, "catalog.manage")).toBe(false);
    expect(can({ role: "ADMIN" }, "payments.refund")).toBe(true);
    expect(() => assertCan(null, "orders.view")).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    expect(() => assertCan({ role: "STAFF" }, "orders.adjustBalance")).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
