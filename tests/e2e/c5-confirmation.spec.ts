import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PAYPAL, emails, fixture, one, q, uniqueEmail, waitForOrderStatus } from "./support/purchase";

// c5 · Confirmación y correos al médico: la página del pedido (/pedido/<token>) tras pagar con PayPal y tras
// registrar un pago manual, y los correos que recibe el médico (confirmación, en verificación, acceso…).
const SEMI = { product: "curso-universitario-ecografia-obstetrica", q: "modality=SEMIPRESENCIAL&sede=barquisimeto&plan=FULL" };
const COURSE_MANUAL = { product: "curso-universitario-ecografia-de-abdomen", q: "modality=SEMIPRESENCIAL&sede=maracaibo&plan=FULL" };
const PROOF = path.join(__dirname, "fixtures", "c4", "comprobante-transferencia.png");
const SHOTS = process.env.C5_SHOTS; // carpeta opcional para capturas de comparación

const MANUAL_METHODS = [
  { method: "PAGO_MOVIL", enabled: true, label: "Pago Móvil", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
  { method: "TRANSFERENCIA", enabled: true, label: "Transferencia bancaria", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", cuenta: "0191-0123-45-2100012345", tipo: "Corriente", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Transfiere el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
];

const created: string[] = [];
test.beforeAll(() => {
  fixture("setting", { key: "payments.manualMethods", value: MANUAL_METHODS });
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: 186.47, source: "BCV", updatedAt: new Date().toISOString() } });
});
test.afterAll(() => {
  for (const id of created) {
    const o = one<{ status: string }>(`SELECT status FROM "Order" WHERE id = ?`, id);
    if (o && ["PENDING_PAYMENT", "AWAITING_VERIFICATION"].includes(o.status)) fixture("age-order", { orderId: id, minutes: 80 * 60 });
  }
});

type OrderRow = { id: string; token: string; number: number; status: string; dueNowCents: number; totalCents: number };
const ordersOf = (email: string) => q<OrderRow>(`SELECT o.* FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`, email);
const usd = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(new Date());

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const vp = (page.viewportSize()?.width ?? 0) < 600 ? "mobile" : "desktop";
  await page.screenshot({ path: path.join(SHOTS, `${vp}__${name}.png`), fullPage: true, animations: "disabled", caret: "hide" });
}

async function fillDoctor(page: Page, email: string) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill("María José");
  await page.getByLabel("Apellidos").fill("Pérez Rodríguez");
  await page.getByLabel("Cédula de identidad").fill("V-12345678");
  await page.getByLabel("Especialidad").selectOption("Ginecología y obstetricia");
}

/** Carrito → checkout → PayPal (mock) → aprobar → página del pedido. */
async function buyWithPaypal(page: Page, email: string) {
  expect((await page.goto(`/cart/add?product=${SEMI.product}&${SEMI.q}`))?.url()).not.toContain("error=");
  await page.goto("/checkout");
  await fillDoctor(page, email);
  await page.getByRole("button", { name: "Pagar con PayPal" }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const [o] = ordersOf(email);
  created.push(o.id);
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=completado$/, { timeout: 60_000 });
  return o;
}

/** Carrito → checkout con transferencia (reserva) → registrar el pago con comprobante → página del pedido. */
async function buyWithTransfer(page: Page, email: string) {
  expect((await page.goto(`/cart/add?product=${COURSE_MANUAL.product}&${COURSE_MANUAL.q}`))?.url()).not.toContain("error=");
  await page.goto("/checkout");
  await fillDoctor(page, email);
  await page.getByText("Transferencia bancaria", { exact: true }).click();
  await page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click();
  await page.waitForURL(/\/checkout\?pedido=creado$/);
  const [o] = ordersOf(email);
  created.push(o.id);
  const reference = `${Date.now()}`.slice(-9) + String(Math.floor(Math.random() * 900) + 100);
  const form = page.getByTestId("manual-form");
  await form.getByLabel("Número de referencia").fill(reference);
  await form.getByLabel("Banco de origen").selectOption("Banesco (0134)");
  await form.getByLabel("Fecha del pago").fill(today());
  await form.getByLabel("Fecha del pago").blur();
  await form.getByLabel("Comprobante de pago").setInputFiles(PROOF);
  await expect(form.getByTestId("proof-file")).toContainText("comprobante-transferencia.png");
  await page.getByRole("button", { name: "Enviar comprobante" }).click();
  await page.waitForURL(new RegExp(`/pedido/${o.token}\\?pago=registrado$`));
  return { ...o, reference };
}

type Mail = ReturnType<typeof emails>[number];
const mailOf = (orderId: string, template: string) => emails(orderId).find((e) => e.template === template);

/** Abre el HTML guardado de un correo como lo vería el médico y comprueba cabecera, logo y enlaces. */
async function openEmail(page: Page, mail: Mail, name: string) {
  await page.setContent(mail.html, { waitUntil: "load" });
  const logo = page.getByRole("img", { name: "CEIUM" });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(100);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByText(/registroceium@gmail\.com/).first()).toBeVisible();
  await shot(page, `correo-${name}`);
}

test.describe("c5 confirmación y correos", () => {
  test("PayPal: página de gracias con acceso, cohorte, calendario y novedades; el correo lleva al pedido", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const email = uniqueEmail("c5pp");
    const o = await buyWithPaypal(page, email);
    await waitForOrderStatus(o.id, "ENROLLED");
    await expect.poll(() => emails(o.id).map((e) => e.template).sort(), { timeout: 20_000 }).toEqual(expect.arrayContaining(["cohort_details", "order_confirmation", "platform_access"]));
    await page.reload();

    await expect(page.getByTestId("order-title")).toHaveText("¡Gracias, María!");
    await expect(page.getByText(`Pedido #${o.number}`)).toBeVisible();

    // Acceso: usuario de Moodle con «Copiar».
    const username = one<{ moodleUsername: string }>(`SELECT c.moodleUsername FROM Customer c JOIN "Order" o ON o.customerId = c.id WHERE o.id = ?`, o.id)!.moodleUsername;
    await expect(page.getByTestId("moodle-username")).toHaveText(username);
    await page.getByTestId("step-access").getByRole("button", { name: "Copiar usuario" }).click();
    await expect(page.getByTestId("step-access").getByRole("button", { name: "Copiado: Usuario" })).toBeVisible();

    // Cohorte: fechas, dirección de la sede (de la BD), sesiones, «Cómo llegar» y calendario .ics.
    const item = one<{ address: string; cohortName: string; sessions: string | null }>(
      `SELECT s.address, c.name AS cohortName, c.sessions FROM OrderItem i JOIN Cohort c ON c.id = i.cohortId JOIN Sede s ON s.id = c.sedeId WHERE i.orderId = ?`,
      o.id,
    )!;
    const cohort = page.getByTestId("order-cohort");
    await expect(cohort).toContainText("Tu cohorte");
    await expect(cohort).toContainText(item.cohortName);
    await expect(cohort).toContainText(item.address);
    await expect(cohort.getByRole("link", { name: "Cómo llegar" })).toHaveAttribute("href", /google\.com\/maps|maps/);
    const sessions = (JSON.parse(item.sessions ?? "[]") as unknown[]).length;
    if (sessions) await expect(cohort.locator(".co-sessions li")).toHaveCount(sessions);
    const ics = await page.request.get(`/pedido/${o.token}/calendario`);
    expect(ics.status()).toBe(200);
    expect(ics.headers()["content-type"]).toContain("text/calendar");
    const cal = await ics.text();
    expect(cal).toContain("BEGIN:VCALENDAR");
    expect((cal.match(/BEGIN:VEVENT/g) ?? []).length).toBe(Math.max(1, sessions));
    expect(cal.replace(/\r\n /g, "")).toContain(item.address.split(" ")[0]);

    // Datos del pedido: método con distintivo; resumen pagado por completo.
    await expect(page.getByTestId("order-details").locator(".co-pm-paypal")).toBeVisible();
    await expect(page.getByTestId("order-details")).toContainText(`PayPal · ${usd(o.dueNowCents)}`);
    await expect(page.getByTestId("order-balance").first()).toContainText("Pagado por completo");

    // Novedades: los correos que ya le llegaron, con su asunto.
    const updates = page.getByTestId("order-updates");
    await expect(updates).toContainText(email);
    await expect(updates).toContainText("Compra confirmada");
    await expect(updates).toContainText("Tus datos de acceso a la plataforma CEIUM");
    await expect(updates.getByTestId("order-update")).toHaveCount(emails(o.id).filter((e) => e.status === "SENT").length);
    await shot(page, "pedido-paypal");

    // Correo de confirmación: título, pedido, programa con miniatura, total y «Ver mi pedido» → esta página.
    const conf = mailOf(o.id, "order_confirmation")!;
    expect(conf.subject).toBe(`Compra confirmada — Pedido #${o.number}`);
    await openEmail(page, conf, "confirmacion-pagado");
    await expect(page.getByRole("heading", { name: "¡Gracias por tu compra!" })).toBeVisible();
    await expect(page.getByText(`Pedido #${o.number}`, { exact: true })).toBeVisible();
    const title = one<{ productTitle: string }>(`SELECT productTitle FROM OrderItem WHERE orderId = ?`, o.id)!.productTitle;
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText("Datos del médico")).toBeVisible();
    await expect(page.getByText("María José Pérez Rodríguez")).toBeVisible();
    const thumbs = page.locator('img[width="60"]');
    await expect(thumbs).toHaveCount(1);
    const viewOrder = page.getByRole("link", { name: "Ver mi pedido" });
    await expect(viewOrder).toHaveAttribute("href", `${baseURL}/pedido/${o.token}`);

    // Correos de acceso y de cohorte.
    await openEmail(page, mailOf(o.id, "platform_access")!, "acceso");
    await expect(page.getByText(username, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ingresar a la plataforma" })).toBeVisible();
    await openEmail(page, mailOf(o.id, "cohort_details")!, "cohorte");
    await expect(page.getByText(item.address)).toBeVisible();
    await expect(page.getByRole("link", { name: /Cómo llegar/ })).toBeVisible();

    // Volver al pedido desde el correo.
    await page.goto(`${baseURL}/pedido/${o.token}`);
    await expect(page.getByTestId("order-title")).toHaveText("¡Gracias, María!");
  });

  test("manual: pedido en verificación con cupo apartado; correos con datos de pago y comprobante", async ({ page }) => {
    const email = uniqueEmail("c5tr");
    const o = await buyWithTransfer(page, email);
    await expect(page.getByTestId("order-title")).toHaveText("Pago en verificación");
    await expect(page.getByTestId("order-cohort")).toContainText("Cupo apartado");
    await expect(page.getByTestId("order-details")).toContainText("Transferencia bancaria · en verificación");
    await expect.poll(() => emails(o.id).map((e) => e.template)).toEqual(expect.arrayContaining(["order_confirmation", "payment_under_verification"]));
    await page.reload();
    const updates = page.getByTestId("order-updates");
    await expect(updates).toContainText("Recibimos tu pedido");
    await expect(updates).toContainText("Estamos verificando tu pago");
    await shot(page, "pedido-manual");

    // Pedido recibido: monto en Bs., datos de CEIUM para transferir y plazo de la reserva.
    const recv = mailOf(o.id, "order_confirmation")!;
    await openEmail(page, recv, "pedido-recibido");
    await expect(page.getByRole("heading", { name: "Recibimos tu pedido" })).toBeVisible();
    await expect(page.getByText(/Monto a pagar por Transferencia bancaria/i)).toBeVisible();
    await expect(page.getByText("0191-0123-45-2100012345")).toBeVisible();
    await expect(page.getByText(/Tu cupo queda reservado hasta el/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Registrar mi pago" })).toHaveAttribute("href", new RegExp(`/pedido/${o.token}$`));

    // En verificación: progreso con la verificación en curso y la referencia del comprobante.
    const verif = mailOf(o.id, "payment_under_verification")!;
    await openEmail(page, verif, "en-verificacion");
    await expect(page.getByRole("heading", { name: "Estamos verificando tu pago" })).toBeVisible();
    await expect(page.getByText(o.reference, { exact: true })).toBeVisible();
    await expect(page.getByText("Comprobante", { exact: true })).toBeVisible();
  });

  test("el calendario solo existe para pedidos con cohorte", async ({ request }) => {
    expect((await request.get("/pedido/no-existe/calendario")).status()).toBe(404);
  });
});
