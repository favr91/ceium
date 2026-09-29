import { expect, test, type Page } from "@playwright/test";
import { fixture, one, q, uniqueEmail, PAYPAL } from "./support/purchase";

// Checkout (/checkout): datos del médico, elección de método y reserva de cupo con cuenta regresiva.
// El carrito se llena con el enlace /cart/add (catálogo real sembrado); los métodos manuales se configuran como
// lo hace el panel (updateSetting, auditado) porque el seed los deja deshabilitados hasta cargar datos reales.
const COURSE = "curso-universitario-ecografia-de-abdomen";
const ONLINE_COURSE = "curso-universitario-ecografia-obstetrica";
const RATE = 186.47;

const MANUAL_METHODS = [
  { method: "PAGO_MOVIL", enabled: true, label: "Pago Móvil", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
  { method: "TRANSFERENCIA", enabled: true, label: "Transferencia bancaria", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", cuenta: "0191-0123-45-2100012345", tipo: "Corriente", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Transfiere el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
  { method: "ZELLE", enabled: true, label: "Zelle", currency: "USD", details: { correo: "pagos@ceium.net", titular: "CEIUM LLC" }, instructions: "Envía el monto en dólares por Zelle y registra el número de confirmación." },
  { method: "EFECTIVO", enabled: true, label: "Pago en efectivo", currency: "USD", details: { lugar: "Sede Barquisimeto, de lunes a viernes de 8:00 a. m. a 4:00 p. m." }, instructions: "Paga en dólares en efectivo en la sede; el personal registra tu pago y te entrega el recibo." },
];

const created: string[] = [];

test.beforeAll(() => {
  fixture("setting", { key: "payments.manualMethods", value: MANUAL_METHODS });
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});

// Los pedidos de prueba dejan su reserva vencida (reloj simulado) para no ocupar cupos del carril.
test.afterAll(() => {
  for (const id of created) fixture("age-order", { orderId: id, minutes: 80 * 60 });
});

const ordersOf = (email: string) =>
  q<{ id: string; token: string; status: string; paymentMethod: string; dueNowCents: number; buyerFirstName: string }>(`SELECT o.* FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`, email);

async function cartWithSemipresencial(page: Page) {
  const res = await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=maracaibo&plan=FULL`);
  expect(res?.url()).not.toContain("error=");
}

async function fillDoctor(page: Page, email: string) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill("María José");
  await page.getByLabel("Apellidos").fill("Pérez Rodríguez");
  await page.getByLabel("Cédula de identidad").fill("v12.345.678");
  await page.getByLabel("Ciudad (opcional)").fill("Maracaibo");
  await page.getByLabel("Especialidad").selectOption("Ginecología y obstetricia");
}

/** Resumen del pedido visible: columna gris en escritorio; en móvil, el desplegable «Resumen del pedido». */
async function summary(page: Page) {
  const toggle = page.getByText("Resumen del pedido", { exact: true });
  if (await toggle.isVisible()) {
    await toggle.click();
    return page.locator(".co-msum-body");
  }
  return page.getByRole("complementary", { name: "Resumen del pedido" });
}

const cents = (usd: string) => Math.round(Number(usd.replace(/[^0-9.]/g, "")) * 100);
const ves = (c: number) => "Bs. " + (c / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test.describe("c2 checkout", () => {
  test("muestra el resumen de la BD, la reserva de cupo y los métodos configurados", async ({ page }) => {
    await cartWithSemipresencial(page);
    await page.goto("/checkout");
    await expect(page).toHaveTitle(/Pantalla de pago/);

    // Resumen: el programa del carrito, cotizado desde la BD, con su cohorte y cupos.
    const aside = await summary(page);
    const line = aside.getByTestId("summary-line");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("Curso Universitario: Ecografía de Abdomen");
    await expect(line).toContainText("Semipresencial / Maracaibo /");
    await expect(line.getByTestId("summary-cohort")).toContainText(/Cohorte .* · \d+ \w+ \d{4} – \d+ \w+ \d{4}/);
    await expect(line.getByTestId("summary-cohort")).toContainText(/Quedan? \d+ cupos?/);
    const total = (await aside.getByTestId("summary-total").textContent())!;
    expect(cents(total)).toBeGreaterThan(0);

    // Reserva: el cupo se aparta al confirmar, 30 min con PayPal y 72 h con pago manual.
    const hold = page.getByTestId("hold-card");
    await expect(hold).toContainText("Tu cupo se reserva al confirmar");
    await expect(hold).toContainText("Maracaibo");
    await expect(page.getByTestId("hold-ttl")).toHaveText("30:00");

    // Métodos: PayPal + los manuales habilitados, en el orden del panel.
    const radios = page.getByRole("radio");
    await expect(radios).toHaveCount(5);
    await expect(page.getByRole("radio", { name: "PayPal" })).toBeChecked();
    await expect(page.getByTestId("method-PAYPAL").getByTestId("method-body")).toContainText("Se te redirigirá a PayPal");
    await expect(page.getByRole("button", { name: "Pagar con PayPal" })).toBeVisible();

    // Pago móvil: monto en bolívares a la tasa configurada, reserva de 72 h y botón que reserva el cupo.
    await page.getByText("Pago Móvil", { exact: true }).click();
    await expect(page.getByRole("radio", { name: "Pago Móvil" })).toBeChecked();
    await expect(page.getByTestId("method-PAYPAL").getByTestId("method-body")).toHaveCount(0);
    await expect(page.getByTestId("method-PAGO_MOVIL").getByTestId("method-amount")).toHaveText(ves(Math.round(cents(total) * RATE)));
    await expect(page.getByTestId("hold-ttl")).toHaveText("72 h");
    await expect(page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" })).toBeVisible();
    // Los datos bancarios se muestran después de reservar, no antes.
    await expect(page.getByText("0191-0123-45-2100012345")).toHaveCount(0);

    await page.getByText("Zelle", { exact: true }).click();
    await expect(page.getByTestId("method-ZELLE").getByTestId("method-amount")).toHaveText(total.trim());
  });

  test("valida en línea los datos del médico y no crea pedidos con datos inválidos", async ({ page }) => {
    const email = uniqueEmail("c2val");
    await cartWithSemipresencial(page);
    await page.goto("/checkout");
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await expect(page.getByText("Ingresa tu correo electrónico.")).toBeVisible();
    await expect(page.getByText("Ingresa tu teléfono.")).toBeVisible();
    await expect(page.getByText("Ingresa tu nombre.")).toBeVisible();
    await expect(page.getByText("Ingresa tus apellidos.")).toBeVisible();
    await expect(page.getByText("Ingresa tu cédula de identidad.")).toBeVisible();
    await expect(page.getByText("Selecciona tu especialidad.")).toBeVisible();
    await expect(page.getByLabel("Correo electrónico")).toBeFocused();
    await expect(page.getByLabel("Correo electrónico")).toHaveAttribute("aria-invalid", "true");
    expect(page.url()).toMatch(/\/checkout$/);

    await fillDoctor(page, "maria@correo");
    await page.getByLabel("Cédula de identidad").fill("abc");
    await page.getByLabel("Especialidad").selectOption("Otra");
    await expect(page.getByText("Ingresa tu correo electrónico.")).toHaveCount(0); // se limpia al escribir
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await expect(page.getByText("Ingresa un correo electrónico válido, p. ej. nombre@correo.com.")).toBeVisible();
    await expect(page.getByText("Ingresa una cédula válida, p. ej. V-12345678.")).toBeVisible();
    await expect(page.getByText("Escribe tu especialidad.")).toBeVisible();

    // El servidor también valida (sin JavaScript de por medio): mismo mensaje, ningún pedido creado.
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("¿Cuál es tu especialidad?").fill("Medicina deportiva");
    await page.getByLabel("Cédula de identidad").fill("V-12345678");
    await page.evaluate(() => {
      (document.querySelector('form.co-form [name="cedula"]') as HTMLInputElement).value = "abc"; // salta la validación del navegador
    });
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await expect(page.getByRole("form", { name: "Pantalla de pago" }).getByRole("alert")).toContainText("Revisa los campos marcados.");
    await expect(page.getByText("Ingresa una cédula válida, p. ej. V-12345678.")).toBeVisible();
    await expect(page.getByLabel("Cédula de identidad")).toBeFocused();
    expect(page.url()).toMatch(/\/checkout$/);
    expect(ordersOf(email)).toHaveLength(0);
  });

  test("PayPal: crea el pedido con los datos del médico, reserva el cupo y va a PayPal; al volver muestra la cuenta regresiva y reutiliza el pedido", async ({ page }) => {
    const email = uniqueEmail("c2pp");
    await cartWithSemipresencial(page);
    await page.goto("/checkout");
    await fillDoctor(page, email);
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });

    const orders = ordersOf(email);
    expect(orders).toHaveLength(1);
    const o = orders[0];
    created.push(o.id);
    expect(o).toMatchObject({ status: "PENDING_PAYMENT", paymentMethod: "PAYPAL", buyerFirstName: "María José" });
    const customer = one<{ firstName: string; lastName: string; cedula: string; phone: string; specialty: string; city: string; country: string }>(`SELECT * FROM Customer WHERE email = ?`, email);
    expect(customer).toMatchObject({ firstName: "María José", lastName: "Pérez Rodríguez", cedula: "V-12345678", phone: "0414-1234567", specialty: "Ginecología y obstetricia", city: "Maracaibo", country: "VE" });
    const r = one<{ status: string; expiresAt: number | string }>(`SELECT status, expiresAt FROM SeatReservation WHERE orderId = ?`, o.id);
    expect(r.status).toBe("HELD");
    const minutesLeft = ((typeof r.expiresAt === "number" ? r.expiresAt : Date.parse(r.expiresAt)) - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(25);
    expect(minutesLeft).toBeLessThanOrEqual(31);

    // Vuelve atrás desde PayPal: la reserva sigue viva y se ve la cuenta regresiva.
    await page.goto("/checkout");
    const hold = page.getByTestId("hold-card");
    await expect(hold).toContainText("Tu cupo está reservado");
    const timer = page.getByTestId("hold-countdown");
    await expect(timer).toHaveText(/^(2\d|30):\d\d$/);
    const first = await timer.textContent();
    await expect(timer).not.toHaveText(first!, { timeout: 3_000 }); // corre
    // Cédula parcial: la página del pedido es pública (el enlace es la única credencial).
    await expect(page.getByTestId("order-review")).toContainText("María José Pérez Rodríguez · V-•••••678");

    // Pagar de nuevo usa el MISMO pedido (sin otro pedido ni otra reserva).
    await page.getByRole("button", { name: "Pagar con PayPal" }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    expect(ordersOf(email)).toHaveLength(1);
    expect(q(`SELECT id FROM SeatReservation WHERE orderId = ?`, o.id)).toHaveLength(1);
  });

  test("pago manual: reserva el cupo 72 h y muestra la cuenta regresiva con los datos para pagar", async ({ page, context }) => {
    const email = uniqueEmail("c2pm");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await cartWithSemipresencial(page);
    await page.goto("/checkout");
    await fillDoctor(page, email);
    await page.getByText("Pago Móvil", { exact: true }).click();
    await page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click();
    await page.waitForURL(/\/checkout\?pedido=creado$/);

    const [o] = ordersOf(email);
    created.push(o.id);
    expect(o).toMatchObject({ status: "PENDING_PAYMENT", paymentMethod: "PAGO_MOVIL" });
    await expect(page.getByRole("status")).toContainText("Creamos tu pedido");
    await expect(page.getByTestId("hold-countdown")).toHaveText(/^7[01]:\d\d:\d\d$/);
    await expect(page.getByRole("radio", { name: "Pago Móvil" })).toBeChecked();
    const details = page.getByTestId("method-details");
    await expect(details).toContainText("Banco Nacional de Crédito (0191)");
    await expect(details).toContainText("J-50123456-0");
    await expect(page.getByTestId("method-amount")).toHaveText(ves(Math.round(o.dueNowCents * RATE)));
    await details.getByRole("button", { name: "Copiar teléfono" }).click();
    await expect(details.getByRole("button", { name: "Teléfono copiado" })).toBeVisible();
    await expect(page.getByTestId("report-payment")).toHaveAttribute("href", `/pedido/${o.token}?metodo=PAGO_MOVIL#pagar`);

    // Recargar no crea otro pedido: sigue la misma reserva.
    await page.goto("/checkout");
    await expect(page.getByTestId("hold-countdown")).toBeVisible();
    expect(ordersOf(email)).toHaveLength(1);
  });

  test("curso online: sin reserva de cupo, mismo formulario y métodos", async ({ page }) => {
    await page.goto(`/cart/add?product=${ONLINE_COURSE}&modality=ONLINE&plan=FULL`);
    await page.goto("/checkout");
    await expect((await summary(page)).getByTestId("summary-line")).toContainText("Online");
    await expect(page.getByTestId("hold-card")).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "PayPal" })).toBeChecked();
    await page.getByText("Transferencia bancaria", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirmar pedido y ver datos de pago" })).toBeVisible();
  });

  test("carrito vacío → vuelve al carrito", async ({ page }) => {
    await page.goto("/checkout");
    await expect(page).toHaveURL(/\/cart$/);
  });
});
