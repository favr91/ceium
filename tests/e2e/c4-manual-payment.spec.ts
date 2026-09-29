import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixture, one, q, uniqueEmail } from "./support/purchase";

// c4 · Pago móvil y transferencia con comprobante, en el checkout (/checkout con el pedido en curso y el cupo
// reservado): monto en Bs. a la tasa del panel y su equivalente en USD, datos de CEIUM con «Copiar», y registro del
// pago (referencia, banco de origen, monto, fecha, comprobante) → /api/checkout/comprobante → pedido «en verificación».
const COURSE = "curso-universitario-ecografia-de-abdomen";
const RATE = 186.47;
const PROOF = path.join(__dirname, "fixtures", "c4", "comprobante-transferencia.png");
const SHOTS = process.env.C4_SHOTS; // carpeta para capturas de comparación con la referencia (opcional)

const MANUAL_METHODS = [
  { method: "PAGO_MOVIL", enabled: true, label: "Pago Móvil", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
  { method: "TRANSFERENCIA", enabled: true, label: "Transferencia bancaria", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", cuenta: "0191-0123-45-2100012345", tipo: "Corriente", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Transfiere el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
  { method: "ZELLE", enabled: true, label: "Zelle", currency: "USD", details: { correo: "pagos@ceium.net", titular: "CEIUM LLC" }, instructions: "Envía el monto en dólares por Zelle y registra el número de confirmación." },
];

const created: string[] = [];

test.beforeAll(() => {
  fixture("setting", { key: "payments.manualMethods", value: MANUAL_METHODS });
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV", updatedAt: new Date().toISOString() } });
});

// Los pedidos de prueba que quedaron pendientes vencen (reloj simulado) para no ocupar cupos del carril.
test.afterAll(() => {
  for (const id of created) fixture("age-order", { orderId: id, minutes: 80 * 60 });
});

const ordersOf = (email: string) =>
  q<{ id: string; token: string; number: number; status: string; paymentMethod: string; dueNowCents: number }>(`SELECT o.* FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`, email);
const bs = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());
const uniqueRef = () => `${Date.now()}`.slice(-9) + String(Math.floor(Math.random() * 900) + 100);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const vp = (page.viewportSize()?.width ?? 0) < 600 ? "mobile" : "desktop";
  await page.screenshot({ path: path.join(SHOTS, `${vp}__${name}.png`), fullPage: true, animations: "disabled", caret: "hide" });
}

/** Carrito con un curso semipresencial → checkout → datos del médico → método → reserva (pedido en curso). */
async function reserveWith(page: Page, method: "Pago Móvil" | "Transferencia bancaria", email: string) {
  const res = await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=maracaibo&plan=FULL`);
  expect(res?.url()).not.toContain("error=");
  await page.goto("/checkout");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill("Andreína");
  await page.getByLabel("Apellidos").fill("Colmenárez Durán");
  await page.getByLabel("Cédula de identidad").fill("V-17654321");
  await page.getByLabel("Ciudad (opcional)").fill("Maracaibo");
  await page.getByLabel("Especialidad").selectOption("Radiología e imágenes");
  await page.getByText(method, { exact: true }).click();
  await page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click();
  await page.waitForURL(/\/checkout\?pedido=creado$/);
  const [o] = ordersOf(email);
  created.push(o.id);
  return o;
}

async function fillPayment(page: Page, reference: string, bank = "Banesco (0134)") {
  const form = page.getByTestId("manual-form");
  await form.getByLabel("Número de referencia").fill(reference);
  await form.getByLabel("Banco de origen").selectOption(bank);
  await form.getByLabel("Fecha del pago").fill(today());
  await form.getByLabel("Fecha del pago").blur();
  await form.getByLabel("Comprobante de pago").setInputFiles(PROOF);
  await expect(form.getByTestId("proof-file")).toContainText("comprobante-transferencia.png");
}

test.describe("c4 pago móvil y transferencia con comprobante", () => {
  test("antes de reservar: el panel del método muestra el monto en Bs. a la tasa del panel y su equivalente en USD", async ({ page }) => {
    await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=maracaibo&plan=FULL`);
    await page.goto("/checkout");
    await page.getByText("Pago Móvil", { exact: true }).click();
    const body = page.getByTestId("method-PAGO_MOVIL").getByTestId("method-body");
    await expect(body).toContainText("Al confirmar, apartamos tu cupo por 72 horas y te mostramos los datos para pagar por pago móvil.");
    const usdText = (await body.getByTestId("method-usd").textContent())!;
    const dueCents = Math.round(Number(usdText.replace(/[^0-9.]/g, "")) * 100);
    expect(dueCents).toBeGreaterThan(0);
    await expect(body.getByTestId("method-amount")).toHaveText(`Bs. ${bs(Math.round(dueCents * RATE))}`);
    await expect(body.getByTestId("method-rate")).toHaveText("Bs. 186,47 por USD");
    await expect(body).toContainText(/Tasa BCV · \d+ \w+ \d{4}/);
    await shot(page, "c4-0-pago-movil-seleccionado");

    await page.getByText("Transferencia bancaria", { exact: true }).click();
    await expect(page.getByTestId("method-TRANSFERENCIA").getByTestId("method-body")).toContainText("para pagar por transferencia bancaria");
    await expect(page.getByTestId("method-PAGO_MOVIL").getByTestId("method-body")).toHaveCount(0);
  });

  test("con el cupo reservado: datos con copiar, cambio de método, validación y envío del comprobante → en verificación", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const email = uniqueEmail("c4tr");
    const o = await reserveWith(page, "Pago Móvil", email);
    const dueBs = Math.round(o.dueNowCents * RATE);

    // Pago Móvil seleccionado: monto Bs./USD/tasa y los datos de pago móvil de CEIUM, cada uno con «Copiar».
    const pm = page.getByTestId("method-PAGO_MOVIL").getByTestId("method-body");
    await expect(pm.getByTestId("method-amount")).toHaveText(`Bs. ${bs(dueBs)}`);
    await expect(pm.getByTestId("method-usd")).toHaveText(`${usd(o.dueNowCents)} USD`);
    await expect(pm.getByTestId("method-rate")).toHaveText("Bs. 186,47 por USD");
    const details = pm.getByTestId("method-details");
    for (const v of ["Banco Nacional de Crédito (0191)", "0412-0840407", "J-50123456-0", "CEIUM, C.A."]) await expect(details).toContainText(v);
    await details.getByRole("button", { name: "Copiar teléfono" }).click();
    await expect(details.getByRole("button", { name: "Teléfono copiado" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("0412-0840407");
    await pm.getByRole("button", { name: "Copiar monto" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe((dueBs / 100).toFixed(2).replace(".", ","));
    await pm.getByRole("button", { name: "Copiar todos los datos" }).click();
    const all = await page.evaluate(() => navigator.clipboard.readText());
    expect(all).toContain("Teléfono: 0412-0840407");
    expect(all).toContain(`Monto: Bs. ${bs(dueBs)}`);
    // El monto del formulario viene precargado con lo que corresponde pagar.
    await expect(pm.getByLabel("Monto pagado (Bs.)")).toHaveValue(bs(dueBs));
    await shot(page, "c4-1-pago-movil-reservado");

    // Transferencia: otros datos (cuenta), mismo monto; lo escrito se conserva al cambiar de método.
    await pm.getByLabel("Número de referencia").fill("123");
    await page.getByText("Transferencia bancaria", { exact: true }).click();
    const tr = page.getByTestId("method-TRANSFERENCIA").getByTestId("method-body");
    await expect(page.getByTestId("method-PAGO_MOVIL").getByTestId("method-body")).toHaveCount(0);
    await expect(tr.getByTestId("method-details")).toContainText("0191-0123-45-2100012345");
    await expect(tr.getByTestId("method-details")).toContainText("Corriente");
    await expect(tr.getByLabel("Número de referencia")).toHaveValue("123");

    // Validación en línea (sin salir del checkout): referencia corta, sin banco, sin comprobante, fecha futura.
    await tr.getByLabel("Fecha del pago").fill("2099-01-01");
    await page.getByRole("button", { name: "Enviar comprobante" }).click();
    await expect(tr.getByText("La referencia debe tener entre 4 y 30 dígitos o letras.")).toBeVisible();
    await expect(tr.getByText("Selecciona el banco desde el que pagaste.")).toBeVisible();
    await expect(tr.getByText("La fecha del pago no puede ser posterior a hoy.")).toBeVisible();
    await expect(tr.getByText("Adjunta el comprobante del pago (captura o PDF).")).toBeVisible();
    await expect(tr.getByLabel("Número de referencia")).toBeFocused();
    await expect(tr.getByLabel("Número de referencia")).toHaveAttribute("aria-invalid", "true");
    expect(q(`SELECT id FROM Payment WHERE orderId = ?`, o.id)).toHaveLength(0);

    // Monto menor al que corresponde: aviso (no bloquea).
    await tr.getByLabel("Monto pagado (Bs.)").fill("100,00");
    await expect(tr.getByTestId("amount-short")).toContainText(`Es menos que el monto a pagar (Bs. ${bs(dueBs)})`);
    await tr.getByLabel("Monto pagado (Bs.)").fill(bs(dueBs));
    await expect(tr.getByTestId("amount-short")).toHaveCount(0);

    const reference = uniqueRef();
    await fillPayment(page, reference);
    await expect(tr.getByTestId("proof-file")).toContainText("listo para enviar");
    await expect(tr.getByTestId("proof-file").locator("img")).toBeVisible(); // vista previa local
    await shot(page, "c4-2-transferencia-con-comprobante");

    await page.getByRole("button", { name: "Enviar comprobante" }).click();
    await page.waitForURL(new RegExp(`/pedido/${o.token}\\?pago=registrado$`));

    // «En verificación»: título, aviso, pasos con los datos del comprobante y cupo apartado.
    await expect(page.getByTestId("order-title")).toHaveText("Pago en verificación");
    await expect(page.getByTestId("order-banner")).toContainText(`Recibimos tu pago por Transferencia bancaria y su comprobante. Te enviamos la confirmación a ${email}.`);
    const verifying = page.getByTestId("order-verifying");
    await expect(verifying.getByTestId("step-proof")).toContainText(`Transferencia bancaria · ref. ${reference}`);
    await expect(verifying.getByTestId("step-proof")).toContainText(`Bs. ${bs(dueBs)}`);
    await expect(verifying.getByTestId("step-proof")).toContainText("desde Banesco (0134)");
    await expect(verifying.getByTestId("step-verify")).toHaveAttribute("aria-current", "step");
    await expect(verifying).toContainText("Cupo apartado");
    await expect(page.getByTestId("order-details")).toContainText("Transferencia bancaria · en verificación");
    await expect(page.getByTestId("order-pay")).toHaveCount(0); // mientras se verifica no se ofrece pagar otra vez
    await shot(page, "c4-3-en-verificacion");

    // BD: pago en verificación con los datos declarados, equivalente en USD con la tasa del panel, comprobante guardado.
    const p = one<{ method: string; status: string; currency: string; amountCents: number; amountUsdCents: number; exchangeRate: string; reference: string; bank: string; paidAt: number | string; proofFile: string }>(`SELECT * FROM Payment WHERE orderId = ?`, o.id);
    expect(p).toMatchObject({ method: "TRANSFERENCIA", status: "AWAITING_VERIFICATION", currency: "VES", amountCents: dueBs, reference, bank: "Banesco (0134)" });
    expect(Number(p.exchangeRate)).toBe(RATE);
    expect(Math.abs(p.amountUsdCents - o.dueNowCents)).toBeLessThanOrEqual(1);
    expect(new Date(typeof p.paidAt === "number" ? p.paidAt : Date.parse(String(p.paidAt))).toISOString().slice(0, 10)).toBe(today());
    const proofPath = path.isAbsolute(p.proofFile) ? p.proofFile : path.resolve(__dirname, "../..", p.proofFile);
    expect(fs.readFileSync(proofPath).equals(fs.readFileSync(PROOF))).toBe(true);
    expect(one<{ status: string; paymentMethod: string }>(`SELECT status, paymentMethod FROM "Order" WHERE id = ?`, o.id)).toMatchObject({ status: "AWAITING_VERIFICATION", paymentMethod: "TRANSFERENCIA" });
    expect(one<{ status: string }>(`SELECT status FROM SeatReservation WHERE orderId = ?`, o.id).status).toBe("HELD");
    await expect.poll(() => q(`SELECT id FROM EmailOutbox WHERE template = 'payment_under_verification' AND "to" = ?`, email).length).toBe(1);

    // La compra terminó: el carrito quedó vacío (el checkout vuelve al carrito).
    await page.goto("/checkout");
    await expect(page).toHaveURL(/\/cart$/);
  });

  test("referencia ya registrada: error en el campo, sin salir del checkout y sin perder el comprobante", async ({ page, browser }) => {
    const reference = uniqueRef();
    // Otro médico ya registró esa referencia de pago móvil.
    const first = await browser.newContext({ locale: "es-VE" });
    const p1 = await first.newPage();
    await reserveWith(p1, "Pago Móvil", uniqueEmail("c4dup1"));
    await fillPayment(p1, reference);
    await p1.getByRole("button", { name: "Enviar comprobante" }).click();
    await p1.waitForURL(/[?&]pago=registrado/);
    await first.close();

    const email = uniqueEmail("c4dup2");
    const o = await reserveWith(page, "Pago Móvil", email);
    await fillPayment(page, reference, "Mercantil (0105)");
    await page.getByRole("button", { name: "Enviar comprobante" }).click();
    const form = page.getByTestId("manual-form");
    await expect(form.getByText("Esa referencia de pago ya fue registrada.")).toBeVisible();
    await expect(form.getByLabel("Número de referencia")).toBeFocused();
    await expect(page).toHaveURL(/\/checkout\?pedido=creado$/);
    await expect(form.getByTestId("proof-file")).toContainText("comprobante-transferencia.png");
    expect(q(`SELECT id FROM Payment WHERE orderId = ?`, o.id)).toHaveLength(0);

    // Corrige la referencia y envía: mismo pedido, mismo comprobante.
    await form.getByLabel("Número de referencia").fill(uniqueRef());
    await page.getByRole("button", { name: "Enviar comprobante" }).click();
    await page.waitForURL(new RegExp(`/pedido/${o.token}\\?pago=registrado$`));
    await expect(page.getByTestId("order-title")).toHaveText("Pago en verificación");
    expect(ordersOf(email)).toHaveLength(1);
  });

  test("comprobante que no es imagen ni PDF: se rechaza antes de enviar", async ({ page }) => {
    const o = await reserveWith(page, "Pago Móvil", uniqueEmail("c4file"));
    const form = page.getByTestId("manual-form");
    await form.getByLabel("Número de referencia").fill(uniqueRef());
    await form.getByLabel("Banco de origen").selectOption("Banco de Venezuela (0102)");
    await form.getByLabel("Comprobante de pago").setInputFiles({ name: "notas.txt", mimeType: "text/plain", buffer: Buffer.from("hola") });
    await page.getByRole("button", { name: "Enviar comprobante" }).click();
    await expect(form.getByText("El comprobante debe ser una imagen (JPG, PNG o WEBP) o un PDF.")).toBeVisible();
    await form.getByRole("button", { name: "Quitar el comprobante" }).click();
    await expect(form.getByText("Sube el comprobante")).toBeVisible();
    expect(q(`SELECT id FROM Payment WHERE orderId = ?`, o.id)).toHaveLength(0);
  });

  test("la ruta del comprobante solo acepta el pedido en curso de este navegador", async ({ request }) => {
    const res = await request.post("/api/checkout/comprobante", {
      headers: { accept: "application/json" },
      multipart: { method: "PAGO_MOVIL", reference: "12345678", bank: "Banesco (0134)", amount: "100,00", paidAt: today(), proof: { name: "c.png", mimeType: "image/png", buffer: fs.readFileSync(PROOF) } },
    });
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, expired: true });
    // Sin JavaScript: vuelve al checkout con el aviso.
    const nojs = await request.post("/api/checkout/comprobante", { multipart: { method: "PAGO_MOVIL" }, maxRedirects: 0 });
    expect(nojs.status()).toBe(303);
    expect(nojs.headers()["location"]).toMatch(/\/checkout\?pago=vencido/);
  });
});
