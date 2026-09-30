import { expect, test } from "@playwright/test";

test("home lista productos desde la BD", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Centro de Enseñanza e Investigación de Ultrasonido en Medicina", level: 1 })).toBeVisible();
  // Dentro del contenido (el menú del header también lista los diplomados, oculto hasta abrirlo).
  await expect(page.locator("#MainContent").getByText("Diplomado Universitario Avanzado de Medicina Materno-Fetal").first()).toBeVisible();
});
