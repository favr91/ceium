// Panel · Cohortes, sedes, fechas y cupos (pieza a2): alta de cohorte, cupos confirmados / reservados / libres
// que reflejan un checkout real, cupo editable (en el detalle y en línea en el listado) que nunca baja de lo
// ocupado, filtro por sede, acciones masivas, borrado solo sin ventas y edición de sedes.
// En el carril del panel (usa su BD y los mismos servicios que la tienda para el checkout):
//   E2E_LANE=panel E2E_PORT=3103 npx playwright test tests/e2e/a2-cohorts.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { cohort, fixture, one, uniqueEmail, type Checkout } from "./support/purchase";

const DIPLOMA = "Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico";

async function login(page: Page, next = "/admin/cohorts") {
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico", { exact: true }).fill("admin@ceium.net");
  await page.getByLabel("Contraseña", { exact: true }).fill("ceium-admin-2026");
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next.split("?")[0]);
}

const seat = (page: Page, k: "confirmed" | "held" | "free" | "capacity") => page.getByTestId(`seats-${k}`);

/** Crea una cohorte desde el formulario del panel y devuelve su id. */
async function createCohort(page: Page, name: string, capacity: number, status = "Inscripciones abiertas") {
  await page.goto("/admin/cohorts/new");
  await expect(page.getByRole("heading", { level: 1, name: "Crear cohorte" })).toBeVisible();
  await page.getByLabel("Programa", { exact: true }).selectOption({ label: DIPLOMA });
  await page.getByLabel("Sede", { exact: true }).selectOption({ label: "Maracaibo" });
  await page.getByLabel("Fecha de inicio", { exact: true }).fill("2027-02-06");
  await page.getByLabel("Nombre", { exact: true }).fill(name);
  // El cronograma se genera con los cursos del diplomado (1 por mes) y ajusta el fin.
  await page.getByRole("button", { name: /^Generar \d+ cursos/ }).click();
  await expect(page.getByLabel("Fecha de la sesión 1", { exact: true })).toHaveValue("2027-02-06");
  await expect(page.getByLabel("Fecha de fin", { exact: true })).not.toHaveValue("");
  await page.getByLabel("Cupo máximo", { exact: true }).fill(String(capacity));
  await page.getByLabel("Estado", { exact: true }).selectOption({ label: status });
  await page.getByRole("button", { name: "Crear cohorte" }).last().click();
  await page.waitForURL(/\/admin\/cohorts\/(?!new)[a-z0-9]+$/);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.url().split("/").pop()!;
}

test.describe("panel · cohortes y cupos", () => {
  test("listado: resumen de cupos, selector de sede y vistas", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { level: 1, name: "Cohortes" })).toBeVisible();
    const total = Number(await page.getByTestId("sum-capacity").textContent());
    const parts = await Promise.all(["sum-confirmed", "sum-held", "sum-free"].map(async (t) => Number(await page.getByTestId(t).textContent())));
    expect(parts[0] + parts[1] + parts[2]).toBe(total);

    await page.getByRole("button", { name: /Todas las sedes/ }).click();
    await page.getByRole("option", { name: /Caracas/ }).click();
    await expect(page).toHaveURL(/sede=caracas/);
    await expect(page.getByRole("button", { name: /Caracas/ }).first()).toBeVisible();
    const sedes = page.locator("table.ix-cohorts tbody tr td:nth-child(3)").filter({ visible: true });
    for (const t of await sedes.allTextContents()) expect(t).toBe("Caracas");

    await page.getByRole("tab", { name: /^Abiertas/ }).click();
    await expect(page).toHaveURL(/view=OPEN/);
    await expect(page.getByRole("tab", { name: /^Abiertas/ })).toHaveAttribute("aria-selected", "true");
  });

  test("cupo: alta, checkout reserva un cupo, el cupo no baja de lo ocupado y se edita en línea", async ({ page }) => {
    await login(page);
    const name = `Cohorte e2e ${Date.now().toString(36)}`;
    const id = await createCohort(page, name, 3);
    await expect(seat(page, "confirmed")).toHaveText("0");
    await expect(seat(page, "held")).toHaveText("0");
    await expect(seat(page, "free")).toHaveText("3");
    await expect(page.getByTestId("sell-state")).toContainText("Se puede comprar");
    const productId = one<{ productId: string }>("SELECT productId FROM Cohort WHERE id = ?", id)!.productId;

    // Un checkout real (mismos servicios que la tienda) toma 1 cupo como reserva.
    fixture<Checkout>("checkout", { productId, cohortId: id, planKind: "FULL", email: uniqueEmail("a2") });
    await page.reload();
    await expect(seat(page, "held")).toHaveText("1");
    await expect(seat(page, "free")).toHaveText("2");
    await expect(page.locator(".seat-bar.lg")).toHaveAttribute("data-held", "1");
    await expect(page.getByRole("table", { name: "Reservas que ocupan cupo" }).getByText("Reservado")).toBeVisible();

    // Bajar el cupo por debajo de lo ocupado: el formulario lo impide.
    await page.getByLabel("Cupo máximo", { exact: true }).fill("0");
    await expect(page.getByRole("alert").filter({ hasText: "No puede ser menor que el cupo ocupado" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Quitar un cupo" })).toBeDisabled();
    // Subirlo: vista previa en vivo y guardado.
    await page.getByLabel("Cupo máximo", { exact: true }).fill("5");
    await expect(seat(page, "free")).toHaveText("4");
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Cohorte guardada")).toBeVisible();
    await expect.poll(() => cohort(id).capacity).toBe(5);
    await expect(page.locator(".tl")).toContainText("cupo");

    // En línea desde el listado (como «Disponible» en el inventario de Shopify).
    await page.goto(`/admin/cohorts?q=${encodeURIComponent(name)}`);
    const cap = page.getByLabel(new RegExp(`^Cupo de ${name}`)).filter({ visible: true });
    await expect(cap).toHaveValue("5");
    await cap.fill("0");
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Mínimo 1 (ocupados)" }).filter({ visible: true })).toBeVisible();
    expect(cohort(id).capacity).toBe(5);
    await cap.fill("8");
    await page.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Cupo actualizado")).toBeVisible();
    await expect.poll(() => cohort(id).capacity).toBe(8);
    const row = page.locator(`[data-cohort-id="${id}"]`).filter({ visible: true });
    await expect(row.locator(".seat-bar")).toHaveAttribute("data-free", "7");

    // Con ventas no se puede borrar.
    await page.goto(`/admin/cohorts/${id}`);
    await page.getByRole("button", { name: "Eliminar cohorte" }).click();
    await expect(page.getByRole("dialog")).toContainText("no se puede borrar");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Eliminar cohorte" })).toHaveCount(0);
  });

  test("acciones masivas de estado y borrado de una cohorte sin ventas", async ({ page }) => {
    await login(page);
    const name = `Cohorte borrador ${Date.now().toString(36)}`;
    const id = await createCohort(page, name, 10, "Borrador");
    await page.goto(`/admin/cohorts?q=${encodeURIComponent(name)}`);
    await page.getByLabel(new RegExp(`^Seleccionar ${name}`)).filter({ visible: true }).check();
    await page.getByRole("button", { name: "Abrir inscripciones" }).click();
    await expect(page.getByText(/1 cohorte: inscripciones abiertas/)).toBeVisible();
    await expect.poll(() => one<{ status: string }>("SELECT status FROM Cohort WHERE id = ?", id)!.status).toBe("OPEN");

    await page.goto(`/admin/cohorts/${id}`);
    await page.getByRole("button", { name: "Eliminar cohorte" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar cohorte" }).click();
    await page.waitForURL(/\/admin\/cohorts$/);
    expect(one("SELECT id FROM Cohort WHERE id = ?", id)).toBeUndefined();
  });

  test("duplicar corre las fechas al siguiente ciclo", async ({ page }) => {
    await login(page);
    const name = `Cohorte dup ${Date.now().toString(36)}`;
    const id = await createCohort(page, name, 12, "Borrador");
    await page.getByRole("link", { name: "Duplicar" }).click();
    await expect(page.getByLabel("Nombre", { exact: true })).toHaveValue(`${name} (copia)`);
    const start = await page.getByLabel("Fecha de inicio", { exact: true }).inputValue();
    const srcEnd = one<{ endDate: string }>("SELECT endDate FROM Cohort WHERE id = ?", id)!.endDate;
    expect(start > String(srcEnd).slice(0, 10)).toBe(true);
    await expect(page.getByLabel("Cupo máximo", { exact: true })).toHaveValue("12");
    await expect(page.getByLabel("Fecha de la sesión 1", { exact: true })).toHaveValue(start);
  });
});

test.describe("panel · sedes", () => {
  test("inventario por sede y edición de una sede", async ({ page }) => {
    await login(page, "/admin/sedes");
    await expect(page.getByRole("heading", { level: 1, name: "Sedes" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Cupos por sede" })).toContainText("Barquisimeto");
    const before = one<{ phone: string | null }>("SELECT phone FROM Sede WHERE slug = 'maracaibo'")!.phone;

    await page.getByRole("button", { name: "Editar Maracaibo" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Identificador", { exact: true }).fill("caracas");
    await dlg.getByRole("button", { name: "Guardar" }).click();
    await expect(dlg.getByText("Ya existe una sede con ese identificador.")).toBeVisible();
    await dlg.getByLabel("Identificador", { exact: true }).fill("maracaibo");
    const phone = `0261-${Date.now().toString().slice(-7)}`;
    await dlg.getByLabel("Teléfono", { exact: true }).fill(phone);
    await dlg.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Sede guardada")).toBeVisible();
    await expect(page.locator('[data-sede="maracaibo"]')).toContainText(phone);
    expect(one<{ phone: string }>("SELECT phone FROM Sede WHERE slug = 'maracaibo'")!.phone).toBe(phone);

    // Restaurar.
    await page.getByRole("button", { name: "Editar Maracaibo" }).click();
    await page.getByRole("dialog").getByLabel("Teléfono", { exact: true }).fill(before ?? "");
    await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
