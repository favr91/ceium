// Panel · Programas (pieza a1): listado, edición de diplomado con matriz de precios y cursos, alta y baja.
// Corre contra cualquier app sembrada: E2E_BASE_URL=http://localhost:3103 npx playwright test tests/e2e/a1-products.spec.ts
import { expect, test, type Page } from "@playwright/test";

const DIPLOMA = "Diplomado Universitario Avanzado de Medicina Materno Fetal";

async function login(page: Page, next = "/admin/products") {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico").fill("admin@ceium.net");
  await page.getByLabel("Contraseña").fill("ceium-admin-2026");
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next);
}

async function openDiploma(page: Page) {
  await login(page);
  await page.getByRole("link", { name: DIPLOMA }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: DIPLOMA })).toBeVisible();
}

test.describe("panel · programas", () => {
  test("sin sesión redirige al login y rechaza credenciales malas", async ({ page }) => {
    await page.goto("/admin/products");
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.getByLabel("Correo electrónico").fill("admin@ceium.net");
    await page.getByLabel("Contraseña").fill("mala-clave-123");
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await expect(page.locator(".banner[role=alert]")).toContainText("Correo o contraseña incorrectos");
  });

  test("listado desde la BD: vistas, búsqueda y filtro de categoría", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { level: 1, name: "Programas" })).toBeVisible();
    const todos = page.getByRole("tab", { name: /Todos/ });
    await expect(todos).toHaveAttribute("aria-selected", "true");
    const total = Number((await todos.locator(".n").textContent())?.trim());
    expect(total).toBeGreaterThanOrEqual(28);
    await expect(page.getByText(`${total} programas`)).toBeVisible();

    await page.getByRole("searchbox", { name: "Buscar programas" }).filter({ visible: true }).last().fill("materno fetal");
    await expect(page).toHaveURL(/q=materno\+fetal/);
    await expect(page.getByRole("link", { name: DIPLOMA }).filter({ visible: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Taller de Ecografía Facial" }).filter({ visible: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Borrar todo" }).click();
    await page.getByRole("button", { name: /^Categoría/ }).click();
    await page.getByRole("option", { name: "Diplomado" }).click();
    await expect(page).toHaveURL(/category=DIPLOMA/);
    await expect(page.getByText(/^2 de \d+ programas$/)).toBeVisible();
  });

  test("diplomado: la matriz recalcula en vivo y guarda precio y cuota", async ({ page }) => {
    await openDiploma(page);
    const price = page.getByLabel("Precio de lista Semipresencial Barquisimeto", { exact: true });
    const inst = page.getByLabel("Cuota mensual Semipresencial Barquisimeto", { exact: true });
    const origPrice = await price.inputValue();
    const origInst = await inst.inputValue();
    const row = page.locator('tr[data-scope="SEMIPRESENCIAL:Barquisimeto"]');

    await price.fill("1500");
    await inst.fill("190");
    // 10 % de descuento del plan «Paga todo»; mitad (5 %) = ⌈1425/2⌉; mes a mes = 9 × 190.
    await expect(row).toContainText("$1,350.00");
    await expect(row).toContainText("$712.50");
    await expect(row).toContainText("9 × $190.00");
    await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toBeVisible();
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Programa guardado" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toBeHidden();

    await page.reload();
    await expect(price).toHaveValue("1500");
    await expect(inst).toHaveValue("190");
    await expect(page.locator(".tl")).toContainText("Precio actualizado");

    // Descartar vuelve al valor guardado; luego restaurar el original.
    await price.fill("999");
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Descartar" }).click();
    await expect(price).toHaveValue("1500");
    await price.fill(origPrice);
    await inst.fill(origInst);
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toBeHidden();
    await page.reload();
    await expect(price).toHaveValue(origPrice);
  });

  test("diplomado: precio de grupo semipresencial aplica a todas las sedes", async ({ page }) => {
    await openDiploma(page);
    const group = page.getByLabel("Precio de lista para todas las sedes", { exact: true });
    await group.fill("1600");
    for (const sede of ["Barquisimeto", "Caracas", "Maracaibo"]) await expect(page.getByLabel(`Precio de lista Semipresencial ${sede}`, { exact: true })).toHaveValue("1600");
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Descartar" }).click();
    await expect(page.getByLabel("Precio de lista Semipresencial Caracas", { exact: true })).not.toHaveValue("1600");
  });

  test("diplomado: reordenar cursos y guardar (mes a mes = nº de cursos)", async ({ page }) => {
    await openDiploma(page);
    const list = page.getByRole("list", { name: "Cursos del diplomado" });
    const items = list.locator("li");
    await expect(items).toHaveCount(9);
    const first = await items.nth(0).getAttribute("data-course-id");
    const second = await items.nth(1).getAttribute("data-course-id");
    await items.nth(0).getByRole("button", { name: /^Bajar/ }).click();
    await expect(items.nth(0)).toHaveAttribute("data-course-id", second!);
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Programa guardado" })).toBeVisible();
    await page.reload();
    await expect(items.nth(0)).toHaveAttribute("data-course-id", second!);
    await expect(items.nth(1)).toHaveAttribute("data-course-id", first!);
    await expect(page.locator('[data-plan="MONTHLY"]')).toContainText("9 cuotas");
    // restaurar
    await items.nth(0).getByRole("button", { name: /^Bajar/ }).click();
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("region", { name: "Cambios sin guardar" })).toBeHidden();
    await page.reload();
    await expect(items.nth(0)).toHaveAttribute("data-course-id", first!);
  });

  test("alta de un taller: validación, guardado como borrador, publicar en lote y eliminar", async ({ page }, info) => {
    await login(page);
    await page.getByRole("link", { name: "Agregar programa" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Agregar programa" })).toBeVisible();

    // Sin título no se envía
    await page.getByRole("button", { name: "Guardar" }).last().click();
    await expect(page.locator(".banner[role=alert]")).toContainText("El título es obligatorio");

    const stamp = `${Date.now().toString(36)}${info.project.name.slice(0, 1)}`;
    const title = `Taller de prueba e2e ${stamp}`;
    await page.getByLabel("Título", { exact: true }).fill(title);
    await page.getByLabel("Categoría").selectOption("WORKSHOP");
    await page.getByLabel("ID del curso en Moodle").fill(String(70000 + Math.floor(Math.random() * 20000)));
    await page.getByLabel("Precio de lista Online", { exact: true }).fill("120");
    await expect(page.locator('tr[data-scope="ONLINE"]')).toContainText("$120.00");
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();

    await page.waitForURL(/\/admin\/products\/(?!new)[a-z0-9]+/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator('.adm-ph [data-status="DRAFT"]')).toHaveText("Borrador");
    await expect(page.getByLabel("Precio de lista Online", { exact: true })).toHaveValue("120");
    await expect(page.getByLabel("Categoría")).toHaveValue("WORKSHOP");

    // Listado: vista Borradores + publicar en lote
    await page.goto("/admin/products?status=DRAFT");
    await expect(page.getByRole("link", { name: title }).filter({ visible: true })).toBeVisible();
    await page.getByRole("checkbox", { name: `Seleccionar ${title}` }).filter({ visible: true }).check();
    await page.getByRole("toolbar", { name: "Acciones masivas" }).getByRole("button", { name: "Publicar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 programa publicado" })).toBeVisible();
    await expect(page.getByRole("link", { name: title }).filter({ visible: true })).toHaveCount(0);

    // Eliminar desde el editor
    await page.goto(`/admin/products?q=${encodeURIComponent(stamp)}`);
    await page.getByRole("link", { name: title }).filter({ visible: true }).click();
    await expect(page.locator('.adm-ph [data-status="ACTIVE"]')).toHaveText("Activo");
    await page.getByRole("button", { name: "Eliminar programa" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar programa" }).click();
    await page.waitForURL((u) => u.pathname === "/admin/products");
    await page.goto(`/admin/products?q=${encodeURIComponent(stamp)}`);
    await expect(page.getByText("No se encontraron programas")).toBeVisible();
  });

  test("el personal (STAFF) ve el catálogo en solo lectura", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel("Correo electrónico").fill("staff@ceium.net");
    await page.getByLabel("Contraseña").fill("ceium-staff-2026");
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL(/\/admin\/products/);
    await expect(page.getByRole("link", { name: "Agregar programa" })).toHaveCount(0);
    await page.getByRole("link", { name: DIPLOMA }).filter({ visible: true }).first().click();
    await expect(page.getByText("Solo lectura")).toBeVisible();
    await expect(page.getByLabel("Precio de lista Online", { exact: true })).toBeDisabled();
  });
});
