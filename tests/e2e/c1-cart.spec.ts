import { expect, test, type Page } from "@playwright/test";

// Carrito (/cart): líneas cotizadas desde la BD (catálogo real sembrado), cantidad, eliminar, totales y CTAs.
const DIPLOMA = "diplomado-universitario-avanzado-de-medicina-materno-fetal";
const COURSE = "curso-universitario-ecografia-obstetrica";

async function add(page: Page, qs: string) {
  const res = await page.goto(`/cart/add?${qs}`);
  expect(res?.url()).toContain("/cart");
}

async function fillCart(page: Page) {
  await add(page, `product=${DIPLOMA}&modality=SEMIPRESENCIAL&sede=barquisimeto&plan=FULL`);
  await add(page, `product=${COURSE}&modality=ONLINE&plan=FULL`);
}

test.describe("c1 carrito", () => {
  test("muestra diplomado semipresencial Barquisimeto + curso online con precios y total de la BD", async ({ page }) => {
    await fillCart(page);
    await expect(page.getByRole("heading", { name: "Tu carrito", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Seguir comprando" })).toBeVisible();

    const lines = page.getByTestId("cart-line");
    await expect(lines).toHaveCount(2);
    // Lo último agregado va arriba (como Shopify).
    const course = lines.nth(0);
    const diploma = lines.nth(1);
    await expect(course.getByRole("link", { name: "Curso Universitario: Ecografía Obstétrica" })).toBeVisible();
    await expect(course).toContainText("Modalidad: Online");
    await expect(course).toContainText("Forma de pago: Paga todo el curso");
    await expect(course).toContainText("$150.00");

    await expect(diploma.getByRole("link", { name: "Diplomado Universitario Avanzado de Medicina Materno Fetal" })).toHaveAttribute("href", `/products/${DIPLOMA}`);
    await expect(diploma).toContainText("Modalidad: Semipresencial");
    await expect(diploma).toContainText("Sede: Barquisimeto");
    await expect(diploma).toContainText(/Cohorte: .*inicia el/);
    await expect(diploma).toContainText("Forma de pago: Paga todo (10% de descuento)");
    await expect(diploma).toContainText("$1,278.00");
    await expect(diploma.locator("img")).toHaveAttribute("src", /cdn\.shopify\.com/);

    await expect(page.getByTestId("cart-total")).toHaveText("$1,428.00 USD");
    await expect(page.getByRole("link", { name: "Pagar pedido" })).toHaveAttribute("href", "/checkout");
    await expect(page.getByRole("link", { name: "Pagar con PayPal" })).toHaveAttribute("href", "/checkout?metodo=paypal");
  });

  test("cantidad: la inscripción es personal (máx. 1) y «−» elimina la línea", async ({ page }) => {
    await fillCart(page);
    const course = page.getByTestId("cart-line").filter({ hasText: "Ecografía Obstétrica" });
    await course.getByRole("button", { name: /Aumentar cantidad/ }).click();
    await expect(course.getByRole("alert")).toContainText("solo puedes agregar 1 por programa");
    await expect(course.getByRole("spinbutton")).toHaveValue("1");
    await expect(page.getByTestId("cart-total")).toHaveText("$1,428.00 USD");

    await course.getByRole("button", { name: /Reducir cantidad/ }).click();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await expect(page.getByTestId("cart-total")).toHaveText("$1,278.00 USD");

    // Sigue igual tras recargar (la cookie se actualizó en el servidor).
    await page.reload();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
  });

  test("eliminar todo deja el carrito vacío", async ({ page }) => {
    await fillCart(page);
    await page.getByRole("button", { name: /^Eliminar Curso Universitario/ }).click();
    await expect(page.getByTestId("cart-line")).toHaveCount(1);
    await page.getByRole("button", { name: /^Eliminar Diplomado/ }).click();
    await expect(page.getByTestId("cart-empty")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tu carrito esta vacío" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Seguir comprando" })).toBeVisible();
  });

  test("volver a agregar un programa reemplaza su línea; mes a mes muestra la cuota y el saldo", async ({ page }) => {
    await fillCart(page);
    await add(page, `product=${DIPLOMA}&modality=SEMIPRESENCIAL&sede=barquisimeto&plan=MONTHLY`);
    const lines = page.getByTestId("cart-line");
    await expect(lines).toHaveCount(2);
    const diploma = lines.filter({ hasText: "Medicina Materno Fetal" });
    await expect(diploma).toContainText("Forma de pago: Paga mes a mes");
    await expect(diploma).toContainText(/cuotas mensuales de \$180\.00/);
    await expect(page.getByTestId("cart-total")).toHaveText("$330.00 USD");
    await expect(page.getByText(/Total de los programas:/)).toBeVisible();
  });

  test("un enlace inválido no agrega nada y explica por qué", async ({ page }) => {
    await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&plan=FULL`);
    await expect(page.getByRole("alert")).toContainText("Selecciona una sede");
    await expect(page.getByTestId("cart-empty")).toBeVisible();
  });

  test("API JSON: agrega, lista, rechaza cantidad > 1 y vacía", async ({ page }) => {
    const api = page.request;
    const product = (await (await api.get(`/cart/add?product=${COURSE}&modality=ONLINE&plan=HALF`, { maxRedirects: 0 })).status());
    expect(product).toBe(303);
    let cart = (await (await api.get("/api/cart")).json()).cart;
    expect(cart.count).toBe(1);
    expect(cart.lines[0].planLabel).toBe("Paga la mitad");
    expect(cart.dueNowCents).toBe(7500);
    expect(cart.programTotalCents).toBe(15000);

    const bad = await api.patch("/api/cart", { data: { key: cart.lines[0].key, quantity: 2 } });
    expect(bad.status()).toBe(422);
    const noProduct = await api.post("/api/cart", { data: { productId: "nope", modality: "ONLINE", planKind: "FULL" } });
    expect(noProduct.status()).toBe(404);

    expect((await api.delete("/api/cart")).ok()).toBe(true);
    cart = (await (await api.get("/api/cart")).json()).cart;
    expect(cart.count).toBe(0);
  });
});
