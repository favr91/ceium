// Verificación en dos pasos del panel: TOTP (vectores de la RFC 6238), cifrado del secreto, códigos de recuperación,
// inicio de sesión en dos pasos, equipos recordados, bloqueo por intentos, política del equipo y Mi cuenta.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_CHALLENGE_TTL_MS, completeLoginChallenge, getAdminSession, hashPassword, login, requireAdmin, type SessionUser } from "@/server/auth";
import { beginTwoFactorSetup, changeOwnPassword, confirmTwoFactorSetup, disableTwoFactor, getAccountOverview, regenerateRecoveryCodes, resetTwoFactorFor } from "@/server/admin-account";
import { updateSetting } from "@/server/admin-settings";
import {
  base32Decode,
  base32Encode,
  consumeRecoveryCode,
  newRecoveryCodes,
  openSecret,
  otpauthUri,
  sealSecret,
  totpCode,
  totpStep,
  verifyTotp,
} from "@/server/two-factor";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let user: SessionUser;
const PASS = "clave-admin-larga-123";

beforeEach(async () => {
  ctx = await setupContext("two-factor");
  const u = await ctx.db.adminUser.create({ data: { email: "dueno@ceium.net", name: "Dueña Pérez", role: "ADMIN", passwordHash: await hashPassword(PASS) } });
  user = { id: u.id, email: u.email, name: u.name, role: u.role };
});
afterEach(async () => {
  await ctx.dispose();
});

/** Activa la verificación leyendo el secreto pendiente (como haría la app con el QR). */
async function enable(sessionId = "ninguna") {
  const setup = await beginTwoFactorSetup(ctx.d, user.id);
  const secret = base32Decode(setup.manualKey);
  const r = await confirmTwoFactorSetup(ctx.d, user.id, totpCode(secret, totpStep(ctx.clock.now())), sessionId);
  return { secret, codes: r.recoveryCodes, setup };
}
const codeAt = (secret: Buffer, offsetSteps = 0) => totpCode(secret, totpStep(ctx.clock.now()) + offsetSteps);

describe("TOTP (RFC 6238) y secretos", () => {
  it("vectores de la RFC 6238 (SHA-1, últimos 6 dígitos) y base32", () => {
    const k = Buffer.from("12345678901234567890");
    expect(totpCode(k, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(k, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(k, Math.floor(2000000000 / 30))).toBe("279037");
    expect(base32Encode(k)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(k);
    expect(otpauthUri("a@ceium.net", k)).toBe("otpauth://totp/CEIUM%3Aa%40ceium.net?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=CEIUM&algorithm=SHA1&digits=6&period=30");
  });

  it("acepta ±30 s, no repite un paso ya usado y rechaza formatos raros", () => {
    const k = Buffer.from("12345678901234567890");
    const now = new Date(1111111109_000);
    const step = totpStep(now);
    expect(verifyTotp(k, "081 804", now)).toBe(step);
    expect(verifyTotp(k, totpCode(k, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(k, totpCode(k, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(k, totpCode(k, step + 2), now)).toBeNull();
    expect(verifyTotp(k, "081804", now, step)).toBeNull(); // ya usado
    expect(verifyTotp(k, "12345", now)).toBeNull();
  });

  it("el secreto se guarda cifrado (AES-GCM): alterado no abre; en producción exige SESSION_SECRET real", () => {
    const k = Buffer.from("secreto-de-20-bytes!");
    const sealed = sealSecret(k);
    expect(sealed).not.toContain(base32Encode(k));
    expect(openSecret(sealed)).toEqual(k);
    const parts = sealed.split(".");
    expect(() => openSecret([...parts.slice(0, 3), Buffer.from("x").toString("base64url")].join("."))).toThrow();
    expect(() => sealSecret(k, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    expect(() => sealSecret(k, { NODE_ENV: "production", SESSION_SECRET: "dev-only-change-me-dev-only-change-me-000" } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    const prod = { NODE_ENV: "production", SESSION_SECRET: "x".repeat(40) } as NodeJS.ProcessEnv;
    expect(() => openSecret(sealed, prod)).toThrow(/código de recuperación/); // otra clave: no abre
    expect(openSecret(sealSecret(k, prod), prod)).toEqual(k);
  });

  it("10 códigos de recuperación distintos; cada uno sirve una vez (sin importar guion ni mayúsculas)", () => {
    const { codes, hashes } = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const stored = JSON.stringify(hashes);
    expect(stored).not.toContain(codes[0].slice(0, 5));
    const rest = consumeRecoveryCode(stored, ` ${codes[3].toUpperCase().replace("-", "")} `)!;
    expect(rest).toHaveLength(9);
    expect(consumeRecoveryCode(JSON.stringify(rest), codes[3])).toBeNull();
  });
});

describe("inicio de sesión en dos pasos", () => {
  it("sin verificación: sesión directa; con verificación: desafío y el código abre la sesión (una sola vez)", async () => {
    expect((await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now())).kind).toBe("session");
    const { secret } = await enable();
    ctx.clock.advance(60_000);

    const ch = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    expect(ch.kind).toBe("challenge");
    expect(await getAdminSession(ctx.db, ch.token, ctx.clock.now())).toBeNull(); // el desafío no es una sesión
    await expect(completeLoginChallenge(ctx.db, { token: ch.token, code: "000000" }, ctx.clock.now())).rejects.toMatchObject({ code: "UNAUTHORIZED", message: expect.stringContaining("Código incorrecto") });
    const code = codeAt(secret);
    const ok = await completeLoginChallenge(ctx.db, { token: ch.token, code, ip: "1.2.3.4" }, ctx.clock.now());
    expect(await getAdminSession(ctx.db, ok.token, ctx.clock.now())).not.toBeNull();
    expect(await ctx.db.adminLoginChallenge.count()).toBe(0);

    // El mismo código no sirve en otro inicio de sesión (repetición).
    const ch2 = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    await expect(completeLoginChallenge(ctx.db, { token: ch2.token, code }, ctx.clock.now())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Desafío vencido (10 min): de vuelta a la contraseña.
    ctx.clock.advance(ADMIN_CHALLENGE_TTL_MS + 1);
    await expect(completeLoginChallenge(ctx.db, { token: ch2.token, code: codeAt(secret) }, ctx.clock.now())).rejects.toMatchObject({ message: expect.stringContaining("venció") });
  });

  it("código de recuperación: entra una vez y descuenta; «recordar este equipo» omite el código solo para ese usuario", async () => {
    const { secret, codes } = await enable();
    const ch = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    const r = await completeLoginChallenge(ctx.db, { token: ch.token, code: codes[0], recovery: true, remember: true, userAgent: "Mozilla/5.0 (iPhone) Safari/604.1" }, ctx.clock.now());
    expect(r.recoveryLeft).toBe(9);
    expect(r.device?.token).toBeTruthy();
    const ch2 = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    await expect(completeLoginChallenge(ctx.db, { token: ch2.token, code: codes[0], recovery: true }, ctx.clock.now())).rejects.toMatchObject({ message: expect.stringContaining("ya se usó") });

    // Equipo recordado: contraseña sí, código no.
    expect((await login(ctx.db, { email: user.email, password: PASS, deviceToken: r.device!.token }, ctx.clock.now())).kind).toBe("session");
    await expect(login(ctx.db, { email: user.email, password: "otra-cosa-mal", deviceToken: r.device!.token }, ctx.clock.now())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // El token de equipo de un usuario no sirve para otro.
    const other = await ctx.db.adminUser.create({ data: { email: "otro@ceium.net", name: "Otro", role: "STAFF", passwordHash: await hashPassword(PASS) } });
    const s2 = await beginTwoFactorSetup(ctx.d, other.id);
    await confirmTwoFactorSetup(ctx.d, other.id, totpCode(base32Decode(s2.manualKey), totpStep(ctx.clock.now())), "x");
    expect((await login(ctx.db, { email: "otro@ceium.net", password: PASS, deviceToken: r.device!.token }, ctx.clock.now())).kind).toBe("challenge");
    // Vence a los 30 días.
    ctx.clock.advance(31 * 24 * 3600_000);
    expect((await login(ctx.db, { email: user.email, password: PASS, deviceToken: r.device!.token }, ctx.clock.now())).kind).toBe("challenge");
    void secret;
  });

  it("5 intentos fallidos seguidos bloquean 15 minutos (aunque luego la clave sea correcta); 5 códigos malos anulan el desafío", async () => {
    for (let i = 0; i < 5; i++) await expect(login(ctx.db, { email: user.email, password: "clave-equivocada" }, ctx.clock.now())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now())).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("espera 15 minutos") });
    ctx.clock.advance(15 * 60_000 + 1);
    expect((await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now())).kind).toBe("session");

    await enable();
    const ch = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    for (let i = 0; i < 4; i++) await expect(completeLoginChallenge(ctx.db, { token: ch.token, code: "111111" }, ctx.clock.now())).rejects.toMatchObject({ message: expect.stringContaining("Código incorrecto") });
    await expect(completeLoginChallenge(ctx.db, { token: ch.token, code: "111111" }, ctx.clock.now())).rejects.toMatchObject({ message: expect.stringContaining("Demasiados códigos") });
    expect(await ctx.db.adminLoginChallenge.count()).toBe(0);
    // Esos 5 fallos también bloquean la cuenta.
    await expect(login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("política del equipo y Mi cuenta", () => {
  it("exigir la verificación: solo quien la tiene puede activarla; quien no la tiene queda fuera de los servicios", async () => {
    await expect(updateSetting(ctx.d, user, "security.require2fa", { enabled: true })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("Activa primero") });
    await enable();
    await updateSetting(ctx.d, user, "security.require2fa", { enabled: true });
    await expect(requireAdmin(ctx.db, user, "orders.view")).resolves.toMatchObject({ id: user.id });
    await expect(requireAdmin(ctx.db, ctx.fx.staff, "orders.view")).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("dos pasos") });
  });

  it("activar cierra las otras sesiones, avisa por correo y no deja secretos en la auditoría; desactivar pide clave y código", async () => {
    const a = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    const b = await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now());
    if (a.kind !== "session" || b.kind !== "session") throw new Error("esperaba sesiones");
    const sa = (await getAdminSession(ctx.db, a.token, ctx.clock.now()))!;
    const { secret, codes } = await enable(sa.session.id);
    expect(codes).toHaveLength(10);
    expect(await getAdminSession(ctx.db, a.token, ctx.clock.now())).not.toBeNull();
    expect(await getAdminSession(ctx.db, b.token, ctx.clock.now())).toBeNull();
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { template: "admin_security" } });
    expect(mail.to).toBe(user.email);
    expect(mail.subject).toBe("Activaste la verificación en dos pasos");
    const audit = await ctx.db.auditLog.findMany({ where: { entityType: "AdminUser" } });
    expect(audit.map((x) => x.action)).toContain("admin_user.2fa_enable");
    expect(JSON.stringify(audit)).not.toMatch(/totpSecret|recoveryCodes|v1\./);
    const row = await ctx.db.adminUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.totpSecret).toMatch(/^v1\./);
    expect(row.recoveryCodes).not.toContain(codes[0]);

    const ov = await getAccountOverview(ctx.d, user.id, sa.session.id);
    expect(ov.twoFactor).toMatchObject({ enabled: true, recoveryLeft: 10 });
    expect(ov.sessions.find((s) => s.current)).toBeTruthy();

    ctx.clock.advance(60_000);
    await expect(disableTwoFactor(ctx.d, user.id, { password: "mala-clave-123", code: codeAt(secret) })).rejects.toMatchObject({ message: expect.stringContaining("contraseña") });
    await expect(disableTwoFactor(ctx.d, user.id, { password: PASS, code: "000000" })).rejects.toMatchObject({ message: expect.stringContaining("código") });
    const fresh = await regenerateRecoveryCodes(ctx.d, user.id, PASS);
    await expect(disableTwoFactor(ctx.d, user.id, { password: PASS, code: codes[0] })).rejects.toMatchObject({ code: "VALIDATION" }); // los viejos ya no sirven
    await disableTwoFactor(ctx.d, user.id, { password: PASS, code: fresh.recoveryCodes[0] });
    expect((await login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now())).kind).toBe("session");
  });

  it("cambiar la propia contraseña pide la actual; el restablecimiento de emergencia quita la verificación y desbloquea", async () => {
    await expect(changeOwnPassword(ctx.d, user.id, { current: "no-es-esta-clave", next: "nueva-clave-larga-1" })).rejects.toMatchObject({ message: expect.stringContaining("actual") });
    await expect(changeOwnPassword(ctx.d, user.id, { current: PASS, next: PASS })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(changeOwnPassword(ctx.d, user.id, { current: PASS, next: "corta" })).rejects.toMatchObject({ code: "VALIDATION" });
    await changeOwnPassword(ctx.d, user.id, { current: PASS, next: "nueva-clave-larga-1" });
    await expect(login(ctx.db, { email: user.email, password: PASS }, ctx.clock.now())).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await enable();
    await ctx.db.adminUser.update({ where: { id: user.id }, data: { lockedUntil: new Date(ctx.clock.now().getTime() + 600_000) } });
    await resetTwoFactorFor(ctx.d, null, user.id, "perdió el teléfono");
    expect((await login(ctx.db, { email: user.email, password: "nueva-clave-larga-1" }, ctx.clock.now())).kind).toBe("session");
    await expect(resetTwoFactorFor(ctx.d, ctx.fx.staff, user.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
