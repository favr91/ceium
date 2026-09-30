// Panel · Tienda en línea › Quiénes somos: el administrador comercial reordena, oculta, edita y agrega personas (con
// foto subida) y la página de la tienda lo refleja al guardar; el asistente solo lo ve. Deja la Setting como estaba.
//   E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/a8-about-team.spec.ts
import Database from "better-sqlite3";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { one } from "./support/purchase";

const DB_FILE = e2eEnv.DATABASE_URL.replace(/^file:/, "");

function restoreSetting(key: string, prev: { value: string } | undefined) {
  const db = new Database(DB_FILE);
  try {
    db.pragma("busy_timeout = 5000");
    if (prev) db.prepare(`UPDATE Setting SET value = ? WHERE key = ?`).run(prev.value, key);
    else db.prepare(`DELETE FROM Setting WHERE key = ?`).run(key);
  } finally {
    db.close();
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel("Correo electrónico", { exact: true }).fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/admin") && !u.pathname.startsWith("/admin/login"));
}

test.describe("panel · personal de Quiénes somos", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "desktop", "un solo recorrido basta");
  });

  test("el comercial reordena, oculta, edita y agrega con foto; la tienda lo muestra al guardar", async ({ page }) => {
    test.setTimeout(120_000);
    const prev = one<{ value: string }>(`SELECT value FROM Setting WHERE key = ?`, "store.pages");
    try {
      await signIn(page, "comercial@ceium.net", "ceium-comercial-2026");
      await page.getByRole("navigation", { name: "Navegación del panel" }).getByRole("link", { name: "Quiénes somos" }).click();
      await page.waitForURL(/\/admin\/pages\/quienes-somos$/);
      const list = page.getByRole("list", { name: "Personal" });
      await expect(list.getByRole("listitem")).toHaveCount(8);
      await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toHaveCount(0);

      // Ocultar, subir de posición y editar el cargo: todo queda en el borrador.
      await page.getByRole("switch", { name: "Mostrar a Ing. William Polanco en la tienda" }).uncheck();
      await expect(list.locator('[data-person="william-polanco"]')).toContainText("Oculta");
      await page.getByRole("button", { name: "Subir a Licdo. David Toledo" }).click();
      await page.getByRole("button", { name: "Editar a Prof. Nerza Roa" }).click();
      const dlg = page.getByRole("dialog", { name: "Editar a Prof. Nerza Roa" });
      await dlg.getByLabel("Cargo").fill("Asesora pedagógica");
      await dlg.getByRole("button", { name: "Listo" }).click();

      // Agregar a alguien con foto: sin foto y visible, no se deja publicar.
      await page.getByRole("button", { name: "Agregar persona" }).click();
      const add = page.getByRole("dialog", { name: "Agregar persona" });
      await add.getByRole("button", { name: "Agregar" }).click();
      await expect(add.getByText("El nombre es obligatorio.")).toBeVisible();
      await add.getByLabel("Nombre").fill("Dra. Prueba Equipo");
      await add.getByLabel("Cargo").fill("Docente invitada");
      await expect(add.getByRole("note")).toContainText("Sube una foto");
      const jpg = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#2a6f97" } }).jpeg().toBuffer();
      await add.getByLabel("Foto").setInputFiles({ name: "prueba.jpg", mimeType: "image/jpeg", buffer: jpg });
      await expect(add.getByRole("button", { name: "Cambiar foto" })).toBeVisible();
      await expect(add.locator("img.ab-photo")).toHaveAttribute("src", /^\/uploads\/team\/dra-prueba-equipo-[0-9a-f]{8}-w\d+\.webp$/);
      await add.getByRole("button", { name: "Agregar" }).click();
      await expect(list.getByRole("listitem")).toHaveCount(9);

      await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Cambios publicados" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toHaveCount(0);

      // La tienda: sin la persona oculta, con el nuevo orden, el cargo editado y la foto subida.
      await page.goto("/pages/quienes-somos");
      const members = page.locator(".pg-member");
      await expect(members).toHaveCount(8);
      await expect(page.locator(".pg-member__name")).toHaveText([
        "Dr. Carlos Roa",
        "Dra. Mireya Montes de Oca",
        "Ing. Flor Montes de Oca",
        "Prof. Nancy Montes de Oca",
        "Licda. Rosmary Pinto",
        "Licdo. David Toledo",
        "Prof. Nerza Roa",
        "Dra. Prueba Equipo",
      ]);
      await expect(members.nth(6).locator(".pg-member__role")).toHaveText("Asesora pedagógica");
      const photo = members.nth(7).locator("img");
      await expect(photo).toHaveAttribute("alt", "Dra. Prueba Equipo");
      await expect(photo).toHaveAttribute("src", /^\/uploads\/team\/dra-prueba-equipo-[0-9a-f]{8}-w\d+\.webp$/);
      await expect.poll(() => photo.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).toBe(true);
    } finally {
      restoreSetting("store.pages", prev);
    }
  });

  test("el asistente ve el personal pero no puede editarlo", async ({ page }) => {
    await signIn(page, "staff@ceium.net", "ceium-staff-2026");
    await page.goto("/admin/pages/quienes-somos");
    await expect(page.getByText("editarlo es del administrador comercial o del superadministrador")).toBeVisible();
    await expect(page.getByRole("list", { name: "Personal" }).getByRole("listitem")).toHaveCount(8);
    await expect(page.getByRole("button", { name: "Agregar persona" })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(page.getByLabel("Título de la sección")).toBeDisabled();
  });
});
