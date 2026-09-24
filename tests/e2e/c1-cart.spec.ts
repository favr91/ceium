import { expect, test, type Locator, type Page } from "@playwright/test";

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

/** Valor de una opción de la línea (lista etiqueta → valor). */
function option(line: Locator, name: string): Locator {
  return line.locator(".ck-option").filter({ has: line.page().locator("dt", { hasText: new RegExp(`^${name}$`) }) }).locator("dd");
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
    await expect(option(course, "Modalidad")).toHaveText("Online");
    await expect(option(course, "Sede")).toHaveCount(0); // «Sede: Online» sobra
    await expect(option(course, "Forma de pago")).toHaveText("Paga todo el curso");
    await expect(course).toContainText("$150.00");
    await expect(course.getByTestId("cart-line-discount")).toHaveCount(0);

    await expect(diploma.getByRole("link", { name: "Diplomado Universitario Avanzado de Medicina Materno Fetal" })).toHaveAttribute("href", `/products/${DIPLOMA}`);
    await expect(option(diploma, "Modalidad")).toHaveText("Semipresencial");
    await expect(option(diploma, "Sede")).toHaveText("Barquisimeto");
    await expect(option(diploma, "Cohorte")).toHaveText(/\S/);
    await expect(option(diploma, "Inicio")).toHaveText(/\d{4}$/);
    await expect(option(diploma, "Forma de pago")).toHaveText("Paga todo");
    await expect(diploma).toContainText("$1,278.00");
    // El 10% del plan se muestra con su monto: precio de lista tachado + «Ahorras».
    await expect(diploma.getByTestId("cart-unit-price").locator("s")).toHaveText("$1,420.00");
    await expect(diploma.getByTestId("cart-line-discount")).toHaveText("Ahorras $142.00 (−10%)");
    await expect(diploma.locator("img")).toHaveAttribute("src", /cdn\.shopify\.com/);

    await expect(page.getByTestId("cart-summary")).toContainText("Subtotal$1,570.00");
    await expect(page.getByTestId("cart-discount")).toHaveText("−$142.00");
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
    await expect(option(diploma, "Forma de pago")).toHaveText("Paga mes a mes");
    await expect(diploma).toContainText(/cuotas mensuales de \$180\.00/);
    await expect(page.getByTestId("cart-total")).toHaveText("$330.00 USD");
    await expect(page.getByText(/Total de los programas:/)).toBeVisible();
  });

  test("móvil: el WhatsApp flotante nunca tapa los botones de pago", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fillCart(page);
    const wa = page.locator(".whatsapp-widget");
    await expect(wa).toBeVisible();
    for (const name of ["Pagar pedido", "Pagar con PayPal"]) {
      const cta = page.getByRole("link", { name });
      // Deja el botón justo al pie de la pantalla, donde vive el WhatsApp.
      await cta.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - window.innerHeight + 20));
      await expect(wa).toBeHidden();
      // Clic real en el borde derecho del botón (donde estaría el WhatsApp): llega al botón.
      const box = (await cta.boundingBox())!;
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("a")?.getAttribute("aria-label") ?? document.elementFromPoint(x, y)?.closest("a")?.textContent, [box.x + box.width - 20, box.y + box.height / 2]);
      expect(hit).toContain(name === "Pagar pedido" ? "Pagar pedido" : "Pagar con PayPal");
    }
    // Lejos de los botones (al pie de la página) vuelve a aparecer.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(wa).toBeVisible();
  });

  test("móvil: el título usa todo el ancho y el WhatsApp no tapa el ahorro", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fillCart(page);
    const diploma = page.getByTestId("cart-line").filter({ hasText: "Medicina Materno Fetal" });
    const name = diploma.locator(".ck-name");
    const lines = await name.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines).toBeLessThanOrEqual(3);
    const pill = diploma.getByTestId("cart-line-discount");
    const wa = page.locator(".whatsapp-widget");
    await pill.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - window.innerHeight + 20));
    await page.waitForTimeout(400); // transición de ocultarse
    const box = (await pill.boundingBox())!;
    if (await wa.isVisible()) {
      const w = (await wa.boundingBox())!;
      const overlap = w.x < box.x + box.width && w.x + w.width > box.x && w.y < box.y + box.height && w.y + w.height > box.y;
      expect(overlap).toBe(false);
    }
  });

  test("un enlace inválido no agrega nada y explica por qué", async ({ page }) => {
    await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&plan=FULL`);
    // Solo el aviso del carrito (Next también monta su anunciador de rutas con role="alert").
    await expect(page.getByRole("alert").filter({ hasText: "Selecciona una sede" })).toHaveCount(1);
    await expect(page.locator(".ck-banner")).toContainText("Selecciona una sede");
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
