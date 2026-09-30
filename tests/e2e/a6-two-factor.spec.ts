// Panel · Verificación en dos pasos, de punta a punta con el usuario de personal (staff@ceium.net):
// activar desde Mi cuenta (QR + código) → códigos de recuperación → iniciar sesión en dos pasos → «recordar este
// equipo» → entrar con un código de recuperación. Al final se desactiva (y se limpia por SQL si algo falló) para no
// afectar a otras pruebas que entran como personal.
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";

const EMAIL = "staff@ceium.net";
const PASS = "ceium-staff-2026";

// TOTP propio de la prueba (RFC 6238), independiente del de la app.
function b32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, v = 0;
  const out: number[] = [];
  for (const c of s.replace(/\s/g, "").toUpperCase()) {
    v = (v << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(key: Buffer, offset = 0): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const h = crypto.createHmac("sha1", key).update(msg).digest();
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}

async function password(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(EMAIL);
  await page.getByLabel("Contraseña", { exact: true }).fill(PASS);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
}

test.describe("panel · verificación en dos pasos", () => {
  test.afterAll(() => {
    const db = new Database(e2eEnv.DATABASE_URL.replace(/^file:/, ""));
    try {
      const id = (db.prepare(`SELECT id FROM AdminUser WHERE email = ?`).get(EMAIL) as { id: string } | undefined)?.id;
      if (id) {
        db.prepare(`UPDATE AdminUser SET totpSecret = NULL, totpPendingSecret = NULL, totpEnabledAt = NULL, totpLastStep = NULL, recoveryCodes = NULL, failedLogins = 0, lockedUntil = NULL WHERE id = ?`).run(id);
        db.prepare(`DELETE FROM AdminTrustedDevice WHERE adminUserId = ?`).run(id);
        db.prepare(`DELETE FROM AdminLoginChallenge WHERE adminUserId = ?`).run(id);
      }
    } finally {
      db.close();
    }
  });

  test("activar, entrar con código, recordar el equipo y entrar con un código de recuperación", async ({ browser }, info) => {
    test.skip(info.project.name !== "desktop", "un solo recorrido basta");
    test.setTimeout(120_000);
    const ctxA = await browser.newContext();
    const page = await ctxA.newPage();

    // 1) Activar desde Mi cuenta
    await password(page);
    await page.waitForURL(/\/admin(?!\/login)/);
    await page.getByRole("button", { name: /Personal CEIUM/ }).click();
    await page.getByRole("menuitem", { name: "Mi cuenta y seguridad" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Mi cuenta" })).toBeVisible();
    await expect(page.getByTestId("2fa-status")).toHaveText("Desactivada");
    await page.getByRole("button", { name: "Activar la verificación en dos pasos" }).click();
    await expect(page.getByTestId("2fa-qr")).toBeVisible();
    const key = b32((await page.getByTestId("2fa-key").textContent()) ?? "");
    await page.getByLabel("Código de verificación").fill("000000");
    await page.getByRole("button", { name: "Activar", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "no coincide" })).toBeVisible();
    await page.getByLabel("Código de verificación").fill(totp(key));
    await page.getByRole("button", { name: "Activar", exact: true }).click();
    const list = page.getByTestId("recovery-codes").locator("li");
    await expect(list).toHaveCount(10);
    const codes = await list.allTextContents();
    await expect(page.getByRole("button", { name: "Listo" })).toBeDisabled();
    await page.getByLabel("Guardé mis códigos en un lugar seguro").check();
    await page.getByRole("button", { name: "Listo" }).click();
    await expect(page.getByTestId("2fa-status")).toHaveText("Activada");
    await expect(page.getByText("Quedan 10 sin usar")).toBeVisible();
    await ctxA.close();

    // 2) Iniciar sesión: contraseña → código (el siguiente paso: el de la activación ya se usó) y recordar el equipo
    const ctxB = await browser.newContext();
    const p2 = await ctxB.newPage();
    await password(p2);
    await p2.waitForURL(/\/admin\/login\/verificar/);
    await expect(p2.getByRole("heading", { name: "Verificación en dos pasos" })).toBeVisible();
    await p2.getByLabel("Código de verificación").fill("123456");
    await p2.getByRole("button", { name: "Verificar" }).click();
    await expect(p2.locator(".banner[role=alert]")).toContainText("Código incorrecto");
    await p2.getByLabel("Código de verificación").fill(totp(key, 1));
    await p2.getByLabel("No volver a pedir el código en este equipo durante 30 días").check();
    await p2.getByRole("button", { name: "Verificar" }).click();
    await p2.waitForURL(/\/admin(?!\/login)/);
    // Equipo recordado: cerrar sesión y volver a entrar pide solo la contraseña.
    await p2.getByRole("button", { name: /Personal CEIUM/ }).click();
    await p2.getByRole("menuitem", { name: "Cerrar sesión" }).click();
    await p2.waitForURL(/\/admin\/login/);
    await password(p2);
    await p2.waitForURL((u) => u.pathname.startsWith("/admin") && !u.pathname.startsWith("/admin/login"));
    await p2.goto("/admin/account");
    await expect(p2.getByRole("list", { name: "Equipos recordados" }).locator("li")).toHaveCount(1);
    await ctxB.close();

    // 3) Otro navegador, sin el teléfono: código de recuperación (sirve una vez)
    const ctxC = await browser.newContext();
    const p3 = await ctxC.newPage();
    await password(p3);
    await p3.waitForURL(/\/admin\/login\/verificar/);
    await p3.getByRole("button", { name: /Usa un código de recuperación/ }).click();
    await p3.getByLabel("Código de recuperación").fill(codes[0].toUpperCase());
    await p3.getByRole("button", { name: "Verificar" }).click();
    await p3.waitForURL(/\/admin\/account\?recuperacion=9/);
    await expect(p3.getByRole("status").filter({ hasText: "Entraste con un código de recuperación" })).toContainText("quedan 9");

    // 4) Desactivar (contraseña + código de recuperación) y comprobar que ya no se pide el código
    await p3.getByRole("button", { name: "Desactivar" }).click();
    const dlg = p3.getByRole("dialog", { name: "Desactivar la verificación en dos pasos" });
    await dlg.getByLabel("Contraseña").fill(PASS);
    await dlg.getByLabel("Código de la app o de recuperación").fill(codes[0]);
    await dlg.getByRole("button", { name: "Desactivar" }).click();
    await expect(dlg.locator(".banner[role=alert]")).toContainText("no es válido"); // ya se usó
    await dlg.getByLabel("Código de la app o de recuperación").fill(codes[1]);
    await dlg.getByRole("button", { name: "Desactivar" }).click();
    await expect(p3.getByTestId("2fa-status")).toHaveText("Desactivada");
    await ctxC.close();
    const ctxD = await browser.newContext();
    const p4 = await ctxD.newPage();
    await password(p4);
    await p4.waitForURL((u) => u.pathname.startsWith("/admin") && !u.pathname.startsWith("/admin/login"));
    await ctxD.close();
  });

  test("Configuración: exigirla requiere tenerla activada uno mismo", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "un solo recorrido basta");
    await page.goto("/admin/login?next=/admin/settings");
    await page.getByLabel("Correo electrónico", { exact: true }).fill("admin@ceium.net");
    await page.getByLabel("Contraseña", { exact: true }).fill("ceium-admin-2026");
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL(/\/admin\/settings/);
    await expect(page.getByRole("switch", { name: "Exigir la verificación en dos pasos a todo el equipo" })).toBeDisabled();
    await expect(page.getByText("Para exigirla, primero actívala en tu cuenta")).toBeVisible();
    await expect(page.getByTestId("team-2fa")).toContainText(/Faltan?: /);
  });
});
