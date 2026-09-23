import { expect, test } from "@playwright/test";

test("home lista productos desde la BD", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CEIUM", level: 1 })).toBeVisible();
  await expect(page.getByText("Diplomado Universitario Avanzado de Medicina Materno Fetal").first()).toBeVisible();
});
