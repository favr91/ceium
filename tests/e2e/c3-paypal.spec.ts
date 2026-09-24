import { expect, test, type Page } from "@playwright/test";
import { captureIdOf, fixture, one, q, uniqueEmail, PAYPAL } from "./support/purchase";

// c3 · Pago con PayPal: selección del método, salida a PayPal («Te estamos llevando a PayPal»), retorno con la
// pantalla «Confirmando tu pago» y la página de gracias del pedido; también cancelar en PayPal, pago retenido por
// PayPal (PENDING → se confirma solo) y pago rechazado. PayPal = mock con el protocolo real (Orders v2 + webhooks).
const SEMI = { product: "curso-universitario-ecografia-obstetrica", q: "modality=SEMIPRESENCIAL&sede=barquisimeto&plan=FULL" };
const ONLINE = { product: "curso-universitario-ecografia-de-abdomen", q: "modality=ONLINE&plan=FULL" };

const created: string[] = [];
test.beforeAll(() => {
  // Métodos manuales como los deja el panel (el seed los trae deshabilitados hasta cargar datos reales).
  fixture("setting", {
    key: "payments.manualMethods",
    value: [
      { method: "PAGO_MOVIL", enabled: true, label: "Pago Móvil", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
      { method: "ZELLE", enabled: true, label: "Zelle", currency: "USD", details: { correo: "pagos@ceium.net", titular: "CEIUM LLC" }, instructions: "Envía el monto en dólares por Zelle y registra el número de confirmación." },
    ],
  });
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: 186.47, source: "BCV" } });
});
// Pedidos que quedan pendientes: su reserva se vence (reloj simulado) para no ocupar cupos del carril.
test.afterAll(() => {
  for (const id of created) {
    const o = one<{ status: string }>(`SELECT status FROM "Order" WHERE id = ?`, id);
    if (o?.status === "PENDING_PAYMENT") fixture("age-order", { orderId: id, minutes: 80 * 60 });
  }
});

type OrderRow = { id: string; token: string; number: number; status: string; dueNowCents: number; amountPaidCents: number };
const ordersOf = (email: string) => q<OrderRow>(`SELECT o.* FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`, email);
const paymentsOf = (orderId: string) => q<{ status: string; providerStatus: string | null; paypalOrderId: string | null }>(`SELECT status, providerStatus, paypalOrderId FROM Payment WHERE orderId = ?`, orderId);
const usd = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function toCheckout(page: Page, item: { product: string; q: string }) {
  const res = await page.goto(`/cart/add?product=${item.product}&${item.q}`);
  expect(res?.url()).not.toContain("error=");
  await page.goto("/checkout");
}

async function fillDoctor(page: Page, email: string) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill("María José");
  await page.getByLabel("Apellidos").fill("Pérez Rodríguez");
  await page.getByLabel("Cédula de identidad").fill("V-12345678");
  await page.getByLabel("Especialidad").selectOption("Ginecología y obstetricia");
}

/** Checkout → «Pagar con PayPal» → página de PayPal. Devuelve el id de la orden PayPal y el pedido. */
async function goToPaypal(page: Page, email: string, item = ONLINE) {
  await toCheckout(page, item);
  await fillDoctor(page, email);
  await page.getByRole("button", { name: "Pagar con PayPal" }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const [o] = ordersOf(email);
  created.push(o.id);
  return { paypalOrderId: new URL(page.url()).searchParams.get("token")!, order: o };
}

test.describe("c3 pago con PayPal", () => {
  test("PayPal seleccionado: aviso de redirección como Shopify y botón amarillo con el monto a pagar", async ({ page }) => {
    await toCheckout(page, SEMI);
    const paypal = page.getByTestId("method-PAYPAL");
    await expect(page.getByRole("radio", { name: "PayPal" })).toBeChecked();
    await expect(paypal.getByTestId("method-body")).toContainText("Se te redirigirá a PayPal para que completes la compra.");
    await expect(paypal.getByTestId("method-body")).toContainText("tarjeta de débito o crédito");
    const total = (await page.getByTestId("summary-total").first().textContent())!.trim();
    await expect(page.getByRole("button", { name: "Pagar con PayPal" })).toBeVisible();
    await expect(page.locator(".co-secure")).toContainText(`Pagarás ${total} USD en el sitio seguro de PayPal`);

    // Otro método: el aviso de PayPal desaparece y el botón cambia; volver a PayPal lo restaura.
    await page.getByText("Pago Móvil", { exact: true }).click();
    await expect(page.getByRole("radio", { name: "Pago Móvil" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Pagar con PayPal" })).toHaveCount(0);
    await expect(page.getByText("Se te redirigirá a PayPal")).toHaveCount(0);
    await page.getByRole("radio", { name: "PayPal" }).check();
    await expect(page.getByRole("radio", { name: "PayPal" })).toBeChecked();
    await expect(page.getByText("Se te redirigirá a PayPal para que completes la compra.")).toBeVisible();
  });

  test("salida a PayPal → aprobar → «Confirmando tu pago» → página de gracias; el carrito queda vacío", async ({ page }) => {
    const email = uniqueEmail("c3ok");
    await toCheckout(page, SEMI);
    await fillDoctor(page, email);
    const total = (await page.getByTestId("summary-total").first().textContent())!.trim();

    // Mientras el servidor crea la orden PayPal: pantalla de salida con el monto y la reserva del cupo.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/checkout", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    const handoff = page.getByTestId("paypal-handoff");
    await expect(handoff).toBeVisible();
    await expect(handoff).toContainText("Te estamos llevando a PayPal");
    await expect(handoff).toContainText(`Pagarás ${total} USD en el sitio seguro de PayPal`);
    await expect(handoff).toContainText("Tu cupo queda reservado 30 minutos");
    await expect(page.getByTestId("paypal-button")).toBeDisabled();
    release();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await page.unroute("**/checkout");
    const [o] = ordersOf(email);
    created.push(o.id);
    await expect(page.getByTestId("pp-total")).toContainText((o.dueNowCents / 100).toFixed(2));

    // Aprobar: el retorno pasa por «Confirmando tu pago» (la captura ocurre mientras se ve) y llega a gracias.
    const seen: string[] = [];
    page.on("framenavigated", (f) => f === page.mainFrame() && seen.push(f.url()));
    await page.getByTestId("pp-approve").click();
    await page.waitForURL(/\/pedido\/[^/?]+\?paypal=completado$/, { timeout: 60_000 });
    expect(seen.some((u) => u.includes(`/pedido/${o.token}/paypal/procesando?token=`))).toBe(true);

    await expect(page.getByTestId("order-title")).toHaveText("¡Gracias, María!");
    await expect(page.getByText(`Pedido #${o.number}`)).toBeVisible();
    const confirm = page.getByTestId("order-confirmation");
    await expect(confirm.getByRole("heading", { name: "¡Pago recibido!" })).toBeVisible();
    await expect(confirm).toContainText(email);
    await expect(confirm.getByTestId("step-payment")).toContainText(`${usd(o.dueNowCents)} con PayPal`);
    await expect(confirm.getByTestId("step-access")).toContainText("Acceso al aula virtual");
    await expect(confirm).toContainText("Cupo confirmado");
    await expect(confirm.getByRole("link", { name: "Ir al aula virtual" })).toBeVisible();
    await expect(page.getByTestId("order-details")).toContainText("María José Pérez Rodríguez");
    await expect(page.getByTestId("order-details")).toContainText(`PayPal · ${usd(o.dueNowCents)}`);
    await expect(page.getByRole("button", { name: /con PayPal/ })).toHaveCount(0);

    // Un solo cobro, pedido inscrito, cupo ocupado.
    expect(ordersOf(email)[0]).toMatchObject({ status: "ENROLLED", amountPaidCents: o.dueNowCents });
    expect(paymentsOf(o.id).filter((p) => p.status === "COMPLETED")).toHaveLength(1);
    expect(one<{ status: string }>(`SELECT status FROM SeatReservation WHERE orderId = ?`, o.id)?.status).toBe("CONFIRMED");

    // Recargar la confirmación no cobra otra vez; el carrito quedó vacío.
    await page.reload();
    await expect(page.getByTestId("order-title")).toHaveText("¡Gracias, María!");
    expect(paymentsOf(o.id)).toHaveLength(1);
    await page.goto("/cart");
    await expect(page.getByText("Tu carrito esta vacío")).toBeVisible();
  });

  test("cancelar en PayPal vuelve al checkout con el pedido y el cupo intactos, sin cobro", async ({ page }) => {
    const email = uniqueEmail("c3cancel");
    await toCheckout(page, SEMI);
    await fillDoctor(page, email);
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    const [o] = ordersOf(email);
    created.push(o.id);

    await page.getByTestId("pp-cancel").click();
    await page.waitForURL(/\/checkout\?paypal=cancelado/);
    await expect(page.getByTestId("paypal-cancelled")).toContainText("No se completó el pago en PayPal y no se te cobró nada. Tu cupo sigue reservado");
    await expect(page.getByTestId("hold-countdown")).toHaveText(/^(2\d|30):\d\d$/);
    await expect(page.getByRole("radio", { name: "PayPal" })).toBeChecked();
    expect(ordersOf(email)).toMatchObject([{ id: o.id, status: "PENDING_PAYMENT", amountPaidCents: 0 }]);
    expect(one<{ status: string }>(`SELECT status FROM SeatReservation WHERE orderId = ?`, o.id)?.status).toBe("HELD");

    // Reintentar usa el mismo pedido.
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    expect(ordersOf(email)).toHaveLength(1);
  });

  test("PayPal retiene el pago: «en revisión» sin botón de pagar, y la página se actualiza sola al confirmarse", async ({ page, request }) => {
    const email = uniqueEmail("c3pend");
    const { paypalOrderId, order: o } = await goToPaypal(page, email);
    await page.goto(`${PAYPAL}/__mock/approve/${paypalOrderId}?capture=PENDING`);
    await page.waitForURL(/\/pedido\/[^/?]+\?paypal=pendiente$/, { timeout: 60_000 });
    await expect(page.getByTestId("order-title")).toHaveText("Tu pago está en revisión");
    await expect(page.getByTestId("order-reviewing")).toContainText("PayPal está revisando tu pago");
    await expect(page.getByTestId("order-reviewing")).toContainText("No hace falta pagar de nuevo.");
    await expect(page.getByRole("button", { name: /con PayPal/ })).toHaveCount(0);

    // PayPal libera la captura (webhook PAYMENT.CAPTURE.COMPLETED): sin recargar, la página pasa a «Gracias».
    const captureId = await captureIdOf(request, paypalOrderId);
    expect((await request.post(`${PAYPAL}/__mock/captures/${captureId}/complete`)).ok()).toBe(true);
    await expect(page.getByTestId("order-title")).toHaveText("¡Gracias, María!", { timeout: 30_000 });
    await expect(page.getByTestId("order-confirmation")).toContainText("Pago confirmado");
    expect(ordersOf(email)[0].amountPaidCents).toBe(o.dueNowCents);
  });

  test("PayPal rechaza el pago: aviso claro, sin cobro y botón para reintentar", async ({ page }) => {
    const email = uniqueEmail("c3deny");
    const { paypalOrderId, order: o } = await goToPaypal(page, email);
    await page.goto(`${PAYPAL}/__mock/approve/${paypalOrderId}?capture=DECLINED`);
    await page.waitForURL(/\/pedido\/[^/?]+\?paypal=fallido$/, { timeout: 60_000 });
    await expect(page.getByTestId("order-banner")).toContainText("PayPal no aprobó el pago y no se te cobró nada.");
    await expect(page.getByRole("heading", { name: "Completa tu pago" })).toBeVisible();
    await expect(page.getByTestId("amount-due")).toHaveText(`${usd(o.dueNowCents)} USD`);
    expect(ordersOf(email)[0]).toMatchObject({ status: "PENDING_PAYMENT", amountPaidCents: 0 });

    // Reintentar desde el pedido: nueva orden PayPal por el mismo monto.
    await page.getByRole("button", { name: `Pagar ${usd(o.dueNowCents)} con PayPal` }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get("token")).not.toBe(paypalOrderId);
  });
});
