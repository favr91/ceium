// Panel · Roles y Equipo, de punta a punta: el administrador comercial (comercial@ceium.net del seed) ve la
// configuración en solo lectura, no puede gestionar a otros administradores, invita a un asistente y el asistente crea
// su contraseña con el enlace y entra. El superadministrador cambia el rol de alguien y lo desactiva.
import { expect, test, type Browser, type Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/admin") && !u.pathname.startsWith("/admin/login"));
}

/** Invita desde Equipo y devuelve el enlace que muestra el diálogo. */
async function invite(page: Page, name: string, email: string, role: RegExp): Promise<string> {
  await page.getByRole("button", { name: "Invitar persona" }).click();
  const dlg = page.getByRole("dialog", { name: "Invitar persona" });
  await dlg.getByLabel("Nombre").fill(name);
  await dlg.getByLabel("Correo electrónico").fill(email);
  await dlg.getByRole("radio", { name: role }).check();
  await dlg.getByRole("button", { name: "Enviar invitación" }).click();
  const done = page.getByRole("dialog", { name: "Invitación lista" });
  await expect(done).toContainText(email);
  const link = await done.getByLabel("Enlace de acceso").inputValue();
  expect(link).toMatch(/\/admin\/acceso\/[A-Za-z0-9_-]{40,}$/);
  await done.getByRole("button", { name: "Listo" }).click();
  return link;
}

async function acceptInvite(browser: Browser, link: string, password: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await page.getByLabel("Contraseña nueva").fill(password);
  await page.getByLabel("Repite la contraseña").fill(password);
  await page.getByRole("button", { name: "Crear contraseña" }).click();
  await expect(page.getByText("Listo, tu contraseña quedó creada.")).toBeVisible();
  return { ctx, page };
}

test.describe("panel · roles y equipo", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "desktop", "un solo recorrido basta");
  });

  test("el comercial ve la configuración en solo lectura, invita a un asistente y este entra con el enlace", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const stamp = Date.now().toString(36);
    await signIn(page, "comercial@ceium.net", "ceium-comercial-2026");

    await page.goto("/admin/settings");
    await expect(page.getByText("solo el superadministrador puede cambiarla")).toBeVisible();

    await page.getByRole("navigation", { name: "Navegación del panel" }).getByRole("link", { name: "Equipo" }).click();
    await page.waitForURL(/\/admin\/team$/);
    await expect(page.getByText("puedes invitar y gestionar asistentes")).toBeVisible();
    // No puede gestionar al superadministrador ni a sí mismo; al asistente, sí.
    await expect(page.locator('[data-member="admin@ceium.net"]').getByRole("button")).toHaveCount(0);
    await expect(page.locator('[data-member="comercial@ceium.net"]').getByRole("link", { name: "Mi cuenta" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gestionar a Personal CEIUM" })).toBeVisible();

    // Solo puede dar el rol de asistente.
    await page.getByRole("button", { name: "Invitar persona" }).click();
    await expect(page.getByRole("dialog", { name: "Invitar persona" }).getByRole("radio")).toHaveCount(1);
    await page.getByRole("dialog", { name: "Invitar persona" }).getByRole("button", { name: "Cancelar" }).click();

    const email = `asistente-${stamp}@ceium.net`;
    const link = await invite(page, `Asistente ${stamp}`, email, /^Asistente/);
    await expect(page.locator(`[data-member="${email}"]`)).toContainText("Invitación pendiente");

    // El asistente crea su contraseña y entra.
    const { ctx, page: p2 } = await acceptInvite(browser, link, "clave-del-asistente-1");
    await p2.getByRole("link", { name: "Iniciar sesión" }).click();
    await p2.getByLabel("Correo electrónico", { exact: true }).fill(email);
    await p2.getByLabel("Contraseña", { exact: true }).fill("clave-del-asistente-1");
    await p2.getByRole("button", { name: "Iniciar sesión" }).click();
    await p2.waitForURL(/\/admin\/products/);
    await p2.getByRole("button", { name: new RegExp(`^Asistente ${stamp}`) }).click();
    await expect(p2.getByRole("menu")).toContainText("· Asistente");
    await expect(p2.getByRole("navigation", { name: "Navegación del panel" }).getByRole("link", { name: "Equipo" })).toHaveCount(0);
    // El enlace sirve una sola vez.
    await p2.goto(link);
    await expect(p2.getByRole("heading", { name: "Este enlace ya no es válido" })).toBeVisible();
    await ctx.close();

    await page.reload();
    await expect(page.locator(`[data-member="${email}"]`)).toContainText("Activo");
  });

  test("el superadministrador invita a un comercial, le cambia el rol y lo desactiva", async ({ page }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    await signIn(page, "admin@ceium.net", "ceium-admin-2026");
    await page.goto("/admin/team");
    const email = `ventas-${stamp}@ceium.net`;
    await invite(page, `Ventas ${stamp}`, email, /^Administrador comercial/);

    await page.getByRole("button", { name: `Gestionar a Ventas ${stamp}` }).click();
    const dlg = page.getByRole("dialog", { name: `Ventas ${stamp}` });
    await expect(dlg.getByRole("radio")).toHaveCount(3);
    await dlg.getByRole("radio", { name: /^Asistente/ }).check();
    await dlg.getByRole("button", { name: "Guardar" }).click();
    await expect(page.locator(`[data-member="${email}"] [data-role]`)).toHaveText("Asistente");

    await page.getByRole("button", { name: `Gestionar a Ventas ${stamp}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar invitación" }).click();
    await expect(page.getByRole("dialog", { name: `¿Cancelar la invitación de Ventas ${stamp}?` })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar invitación" }).click();
    await expect(page.locator(`[data-member="${email}"]`)).toHaveCount(0);

    // A la cuenta del asistente del seed: desactivar y reactivar.
    await page.getByRole("button", { name: "Gestionar a Personal CEIUM" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Desactivar acceso" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Desactivar acceso" }).click();
    await expect(page.locator('[data-member="staff@ceium.net"]')).toContainText("Desactivado");
    await page.getByRole("button", { name: "Gestionar a Personal CEIUM" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reactivar acceso" }).click();
    await expect(page.locator('[data-member="staff@ceium.net"]')).toContainText("Activo");
  });
});
