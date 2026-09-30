// Pieza x4 — integración total: el recorrido real de punta a punta, SOLO por la interfaz del navegador (tienda,
// correo y panel), contra la app y los mocks de Moodle y PayPal del carril. La BD solo se LEE para verificar; los
// mocks solo se usan como lo haría el mundo real (aprobar en PayPal, marcar un curso completado en Moodle).
//   0. El admin configura Pago Móvil (datos bancarios reales) y la tasa BCV en /admin/settings.
//   1. Doctor A: / → menú Educación 2026 → Diplomado Avanzado de Medicina Materno Fetal → Semipresencial +
//      Barquisimeto + cohorte con cupo + «Paga mes a mes» → carrito → checkout (cédula, especialidad) → Pago Móvil
//      con comprobante. El admin lo ve en «Por verificar», abre el comprobante y aprueba → Moodle: cuenta nueva y
//      SOLO el curso 1; cupo confirmado +1; correos: confirmación, en verificación, aprobado, acceso, cohorte.
//      Cuotas 2..9 desde el enlace del correo de recordatorio (el admin lo envía desde el pedido), alternando
//      PayPal y Pago Móvil (el admin aprueba cada pago móvil): cada cuota matricula exactamente el curso siguiente.
//      Los 9 cursos completados en Moodle + job de certificados → un certificado, verificable en
//      /certificados/<código>, y correo con el PDF.
//   2. Doctor B compra un curso online con PayPal → matriculado al instante, sin paso del admin.
//   3. El admin reembolsa a B desde el panel → reembolso en PayPal, desmatriculado, rastro en la cronología.
//   4. El admin cambia el precio de un curso y el cupo de una cohorte → la tienda lo refleja al instante.
// Carril: E2E_LANE=final E2E_PORT=3106 npx playwright test tests/e2e/x4-journey.spec.ts --project=desktop
// (sobre un carril recién creado: node scripts/lane.mjs final 3106 --reset)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, events, one, order, paypalConfig, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { todayCaracas } from "./support/dates";
import { e2eEnv } from "../../playwright.config";
import sharp from "sharp";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "recorrido de servidor: una vez basta (las vistas móviles tienen sus propias pruebas)");
});

const APP_DIR = path.resolve(__dirname, "../..");
const DIPLOMA = "diplomado-universitario-avanzado-de-medicina-materno-fetal";
const DIPLOMA_TITLE = "Diplomado Universitario Avanzado de Medicina Materno Fetal";
const COURSE_B = "curso-universitario-enfermedades-materno-fetales";
const COURSE_PRICE = "curso-universitario-ecografia-pediatrica";
const RATE = "187,25";
const RATE_NUM = 187.25;
const ADMIN_EMAIL = "admin@ceium.net";
const ADMIN_PASSWORD = (() => {
  try {
    return parseDotenv(fs.readFileSync(path.join(APP_DIR, ".env"))).ADMIN_PASSWORD || "ceium-admin-2026";
  } catch {
    return "ceium-admin-2026";
  }
})();

// ───────────── utilidades ─────────────

function proofPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // Cada fila empieza con el byte de filtro (0 = ninguno); 0x7f no es un filtro válido y la imagen no se podía leer.
  const raw = Buffer.concat(Array.from({ length: 16 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(16 * 3, 0x7f)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PROOF = { name: "comprobante-pago-movil.png", mimeType: "image/png", buffer: proofPng() };
const bs = (usdCents: number) => (Math.round(usdCents * RATE_NUM) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let refSeq = 0;
const newRef = () => `${(Date.now() % 1e6).toString().padStart(6, "0")}${(refSeq++).toString().padStart(2, "0")}`;

async function adminSession(browser: Browser, next = "/admin"): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next.split("?")[0], { timeout: 60_000 });
  return { ctx, page };
}

interface MoodleSnapshot {
  users: { id: number; email: string; deleted?: number }[];
  enrolments: { userid: number; courseid: number; status: number }[];
  completions: { userid: number; courseid: number }[];
}
const moodle = async (request: APIRequestContext): Promise<MoodleSnapshot> => (await request.get(`${MOODLE}/__mock/state`)).json();
async function moodleCoursesOf(request: APIRequestContext, userId: number): Promise<number[]> {
  const st = await moodle(request);
  return st.enrolments.filter((e) => e.userid === userId && e.status === 0).map((e) => e.courseid).sort((a, b) => a - b);
}

const templatesOf = (orderId: string) => emails(orderId).map((e) => e.template);
/** Enlaces del ÚLTIMO recordatorio de cuota que recibió el médico (lo que ve en su bandeja). */
function reminderLinks(orderId: string) {
  const list = emails(orderId).filter((e) => e.template === "installment_reminder");
  expect(list.length, "llegó un recordatorio").toBeGreaterThan(0);
  const last = list[list.length - 1];
  const html = last.html.replace(/&amp;/g, "&");
  const paypal = html.match(/href="([^"]*\/cuota\/[^"/]+\/paypal)"/)?.[1] ?? null;
  const manual = html.match(/href="([^"]*\?cuota=[^"#]+#pagar)"/)?.[1] ?? null;
  return { subject: last.subject, text: last.text, paypal, manual };
}

// ───────────── estado compartido del recorrido ─────────────

const A = { email: uniqueEmail("x4a"), first: "Mariana Isabel", last: "Colmenárez Torres", cedula: "V-15678432", orderId: "", token: "", moodleUserId: 0, cohortId: "", courses: [] as { title: string; moodleCourseId: number }[] };
const B = { email: uniqueEmail("x4b"), first: "José Gregorio", last: "Pérez Álvarez", cedula: "V-18234567", orderId: "", moodleCourseId: 0 };
let seatsBefore = { held: 0, confirmed: 0 };

/** El admin abre el pedido desde la cola «Por verificar» y aprueba el pago móvil con esa referencia, tras mirar el comprobante. */
async function adminApprove(browser: Browser, orderId: string, reference: string, opts: { fromQueue?: boolean } = {}) {
  const { ctx, page } = await adminSession(browser, "/admin/orders");
  try {
    // Cola de verificación del listado de pedidos; la primera vez se llega desde el aviso del listado.
    if (opts.fromQueue) await page.getByRole("link", { name: "Verificar pagos" }).click();
    else await page.getByRole("tab", { name: /Por verificar/ }).click();
    await expect(page.getByRole("tab", { name: /Por verificar/ })).toHaveAttribute("aria-selected", "true");
    const n = one<{ number: number }>(`SELECT number FROM "Order" WHERE id = ?`, orderId).number;
    await page.getByRole("link", { name: `#${n}`, exact: true }).click();
    await page.waitForURL(`**/admin/orders/${orderId}`);
    const card = page.getByTestId("payment").filter({ hasText: reference });
    await expect(card).toBeVisible();
    // Abre el comprobante (ampliado) y comprueba que es la imagen que subió el médico.
    await card.getByRole("button", { name: "Ampliar comprobante" }).click();
    const box = page.getByRole("dialog", { name: "Comprobante ampliado" });
    await expect(box.getByRole("img")).toBeVisible();
    const src = await box.getByRole("img").getAttribute("src");
    const proof = await page.request.get(src!);
    expect(proof.status()).toBe(200);
    // Se guarda re-codificado (sin metadatos): la misma imagen, no los mismos bytes.
    const served = await sharp(await proof.body()).metadata();
    expect([served.format, served.width, served.height], "el panel sirve el comprobante").toEqual(["png", 16, 16]);
    await box.getByRole("button", { name: "Cerrar" }).click();
    await card.getByRole("button", { name: "Aprobar pago" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Pago aprobado/ })).toBeVisible({ timeout: 60_000 });
  } finally {
    await ctx.close();
  }
}

/** El admin pulsa «Recordar» en la siguiente cuota del pedido (envía el correo con el enlace de pago). */
async function adminRemind(browser: Browser, orderId: string, sequence: number) {
  const { ctx, page } = await adminSession(browser, `/admin/orders/${orderId}`);
  try {
    const btn = page.getByTestId("installments").getByRole("button", { name: `Enviar recordatorio de la cuota ${sequence}` });
    await expect(btn).toBeVisible();
    // Solo la siguiente cuota ofrece el recordatorio.
    await expect(page.getByTestId("installments").getByRole("button", { name: /Enviar recordatorio/ })).toHaveCount(1);
    await btn.click();
    await expect(page.getByRole("status").filter({ hasText: `Recordatorio de la cuota ${sequence} enviado` })).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close();
  }
}

async function payManualInstallment(page: Page, url: string, amountUsdCents: number, reference: string) {
  await page.goto(url);
  const pay = page.getByTestId("order-pay");
  await expect(pay.getByRole("heading", { level: 2 })).toContainText("Pagar la cuota");
  await pay.getByLabel("Número de referencia").fill(reference);
  await pay.getByLabel(/Monto pagado/).fill(bs(amountUsdCents));
  await pay.getByLabel("Banco de origen").fill("Banesco (0134)");
  await pay.getByLabel("Fecha del pago").fill(todayCaracas());
  await pay.getByLabel("Cédula del titular").fill(A.cedula);
  await pay.getByLabel(/Comprobante/).setInputFiles(PROOF);
  await pay.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/, { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("pago"), new URL(page.url()).searchParams.get("motivo") ?? "").toBe("registrado");
}

async function payPaypalInstallment(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=completado/, { timeout: 60_000 });
}

// Mocks en su comportamiento normal (otra spec del mismo carril pudo dejar fallos de Moodle inyectados o PayPal sin
// webhooks automáticos): el recorrido prueba el camino real, no la recuperación de fallos.
test.beforeAll(async ({ request }) => {
  expect((await request.post(`${MOODLE}/__mock/fail-clear`)).ok()).toBe(true);
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});

// ───────────── 0. configuración ─────────────

test("0 · el admin activa Pago Móvil con los datos bancarios y fija la tasa BCV en Configuración", async ({ browser, page }) => {
  // Tienda recién creada: sin datos bancarios reales, solo PayPal.
  await page.goto(`/products/${DIPLOMA}`);
  const { ctx, page: admin } = await adminSession(browser, "/admin");
  try {
    await admin.getByRole("navigation", { name: "Navegación del panel" }).getByRole("link", { name: "Configuración" }).click();
    await admin.waitForURL("**/admin/settings");
    await expect(admin.getByRole("heading", { name: "Configuración", level: 1 })).toBeVisible();

    const pm = admin.locator('fieldset[data-method="PAGO_MOVIL"]');
    await pm.getByRole("switch", { name: /Activar Pago/ }).check();
    if (!(await pm.getByLabel(/^Banco \(/).inputValue())) {
      // Datos de ejemplo del seed: habilitarlo sin completarlos → el panel no lo deja.
      await admin.getByRole("button", { name: "Guardar pagos manuales" }).click();
      await expect(admin.getByRole("alert").filter({ hasText: "Completa los datos" })).toBeVisible();
    }

    await pm.getByLabel(/^Banco \(/).selectOption("Banco Nacional de Crédito, BNC (0191)");
    await pm.getByLabel(/^Teléfono \(/).fill("0412-0840407");
    await pm.getByLabel(/^Cédula \/ RIF \(/).fill("J-50123456-0");
    await pm.getByLabel(/^Titular \(/).fill("CEIUM, C.A.");
    await admin.getByRole("button", { name: "Guardar pagos manuales" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Métodos de pago manuales guardados" })).toBeVisible();

    await admin.getByLabel("Bolívares por dólar").fill(RATE);
    await admin.getByLabel("Fuente de la tasa").fill("BCV");
    await admin.getByRole("button", { name: "Actualizar tasa" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Tasa de cambio actualizada" })).toBeVisible();
    await admin.reload();
    await expect(admin.getByLabel("Bolívares por dólar")).toHaveValue(RATE);
    await expect(admin.locator('fieldset[data-method="PAGO_MOVIL"]').getByRole("switch")).toBeChecked();
  } finally {
    await ctx.close();
  }
  const audit = q<{ action: string; entityId: string }>(`SELECT action, entityId FROM AuditLog WHERE entityType = 'Setting' ORDER BY createdAt`);
  expect(audit.map((a) => a.entityId)).toEqual(expect.arrayContaining(["payments.manualMethods", "exchangeRate.vesPerUsd"]));
});

// ───────────── 1. Doctor A ─────────────

test("1a · Doctor A: menú → diplomado → Semipresencial/Barquisimeto/cohorte/mes a mes → carrito → checkout → Pago Móvil con comprobante", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Menú principal" });
  await nav.locator("summary", { hasText: "Educación 2026" }).click();
  await nav.locator(".list-menu--disclosure").getByRole("link", { name: DIPLOMA_TITLE }).click();
  await page.waitForURL(`**/products/${DIPLOMA}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DIPLOMA_TITLE);

  const form = page.getByTestId("buy-form");
  await form.getByRole("group", { name: "Modalidad" }).getByRole("radio", { name: "Semipresencial" }).check();
  await form.getByRole("group", { name: "Sede" }).getByRole("radio", { name: "Barquisimeto" }).check();
  const cohorts = form.getByRole("group", { name: "Cohorte" }).getByRole("radio", { disabled: false });
  const withSeats = form.getByRole("group", { name: "Cohorte" }).getByRole("radio", { name: /cupos? disponibles?/ }).first();
  await expect(cohorts.first()).toBeVisible();
  await withSeats.check();
  const cohortLabel = (await withSeats.getAttribute("aria-label")) ?? (await withSeats.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? ""));
  const cohortName = /Cohorte [IVX]+ - \d{4}/.exec(cohortLabel)?.[0];
  expect(cohortName, cohortLabel).toBeTruthy();
  await form.getByRole("group", { name: "Forma de pago" }).getByRole("radio", { name: "Paga mes a mes" }).check();
  await expect(form).toContainText("9 cuotas de $180.00");
  const c = one<{ id: string; seatsHeld: number; seatsConfirmed: number }>(
    `SELECT c.id, c.seatsHeld, c.seatsConfirmed FROM Cohort c JOIN Product p ON p.id = c.productId JOIN Sede s ON s.id = c.sedeId WHERE p.slug = ? AND s.slug = 'barquisimeto' AND c.name = ?`,
    DIPLOMA,
    cohortName,
  );
  A.cohortId = c.id;
  seatsBefore = { held: c.seatsHeld, confirmed: c.seatsConfirmed };
  await form.getByRole("button", { name: "Agregar al carrito" }).click();

  await page.waitForURL("**/cart");
  const cart = page.getByRole("table", { name: "Tu carrito" });
  await expect(cart).toContainText(DIPLOMA_TITLE);
  await expect(cart).toContainText("Barquisimeto");
  await expect(cart).toContainText("Paga mes a mes");
  await expect(page.locator("main")).toContainText("$180.00");
  await page.getByRole("link", { name: "Pagar pedido" }).click();

  await page.waitForURL("**/checkout");
  await page.getByLabel("Correo electrónico").fill(A.email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("0414-5551234");
  await page.getByLabel("Nombre", { exact: true }).fill(A.first);
  await page.getByLabel("Apellidos").fill(A.last);
  await page.getByLabel("Cédula de identidad").fill(A.cedula);
  await page.getByLabel("Ciudad (opcional)").fill("Barquisimeto");
  await page.getByLabel("Especialidad").selectOption("Ginecología y obstetricia");
  await page.getByRole("group", { name: "Método de pago" }).getByRole("radio", { name: /Pago m[óo]vil/i }).check();
  await expect(page.getByRole("region", { name: "Pago" })).toContainText(`Bs. ${bs(18000)}`);
  await page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click();
  await page.waitForURL(/\/checkout\?pedido=creado$/, { timeout: 60_000 });
  await expect(page.getByRole("region", { name: "Tu cupo está reservado" })).toContainText(cohortName!);

  const o = one<{ id: string; token: string }>(`SELECT o.id, o.token FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, A.email);
  A.orderId = o.id;
  A.token = o.token;
  const cust = customerOf(o.id);
  expect(one<{ cedula: string; specialty: string }>(`SELECT cedula, specialty FROM Customer WHERE id = ?`, cust.id)).toEqual({ cedula: A.cedula, specialty: "Ginecología y obstetricia" });
  expect(q(`SELECT sequence, amountCents FROM Installment WHERE orderId = ? ORDER BY sequence`, o.id)).toHaveLength(9);
  A.courses = q<{ title: string; moodleCourseId: number }>(
    `SELECT p.title, p.moodleCourseId FROM Installment i JOIN Product p ON p.id = i.courseId WHERE i.orderId = ? ORDER BY i.sequence`,
    o.id,
  );
  expect(A.courses).toHaveLength(9);

  const form2 = page.getByRole("form", { name: "Registrar el pago" });
  await expect(form2.getByLabel("Monto pagado (Bs.)")).toHaveValue(bs(18000));
  const ref = newRef();
  await form2.getByLabel("Número de referencia").fill(ref);
  await form2.getByLabel("Banco de origen").selectOption({ label: "Banesco (0134)" });
  await form2.getByLabel("Fecha del pago").fill(todayCaracas());
  await form2.getByLabel("Comprobante de pago").setInputFiles(PROOF);
  await page.getByRole("button", { name: "Enviar comprobante" }).click();
  await page.waitForURL(new RegExp(`/pedido/${A.token}\\?pago=registrado$`), { timeout: 60_000 });
  expect(order(A.orderId).status).toBe("AWAITING_VERIFICATION");
  (A as { firstRef?: string }).firstRef = ref;
  expect(cohort(A.cohortId).seatsHeld).toBe(seatsBefore.held + 1);
});

test("1b · el admin lo ve en «Por verificar», abre el comprobante y aprueba → Moodle solo curso 1, cupo +1, correos", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const ref = (A as { firstRef?: string }).firstRef!;
  await adminApprove(browser, A.orderId, ref, { fromQueue: true });
  await waitForOrderStatus(A.orderId, "ENROLLED", 60_000);

  const cust = customerOf(A.orderId);
  expect(cust.moodleUserId, "cuenta de Moodle creada").toBeTruthy();
  A.moodleUserId = cust.moodleUserId!;
  const st = await moodle(request);
  expect(st.users.filter((u) => u.email.toLowerCase() === A.email.toLowerCase())).toHaveLength(1);
  expect(await moodleCoursesOf(request, A.moodleUserId), "SOLO el curso 1").toEqual([A.courses[0].moodleCourseId]);

  const c = cohort(A.cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: seatsBefore.held, confirmed: seatsBefore.confirmed + 1 });
  expect(reservationOf(A.orderId).status).toBe("CONFIRMED");
  expect(order(A.orderId)).toMatchObject({ amountPaidCents: 18000, balanceCents: 8 * 18000 });

  await expect.poll(() => templatesOf(A.orderId).sort(), { timeout: 30_000 }).toEqual(
    ["cohort_details", "order_confirmation", "payment_approved", "payment_under_verification", "platform_access"].sort(),
  );
  const mails = emails(A.orderId);
  expect(mails.every((m) => m.status === "SENT" && m.to.toLowerCase() === A.email.toLowerCase())).toBe(true);
  const access = mails.find((m) => m.template === "platform_access")!;
  expect(access.secretRef, "contraseña temporal: cuenta nueva").not.toBeNull();
  expect(access.text).toContain(A.courses[0].title);
  expect(mails.find((m) => m.template === "cohort_details")!.text).toContain("Barquisimeto");
});

test("1c · cuotas 2..9 desde el enlace del recordatorio, alternando PayPal y Pago Móvil: cada una matricula SOLO el curso siguiente", async ({ browser, request, page }) => {
  test.setTimeout(900_000);
  for (let seq = 2; seq <= 9; seq++) {
    await adminRemind(browser, A.orderId, seq);
    const links = reminderLinks(A.orderId);
    expect(links.subject + links.text).toContain(A.courses[seq - 1].title);
    expect(links.paypal, "enlace PayPal de la cuota").toBeTruthy();
    expect(links.manual, "enlace de pago manual de la cuota").toBeTruthy();
    const insId = one<{ id: string }>(`SELECT id FROM Installment WHERE orderId = ? AND sequence = ?`, A.orderId, seq).id;
    expect(links.paypal).toContain(`/cuota/${insId}/paypal`);
    expect(links.manual).toContain(`cuota=${insId}`);

    if (seq % 2 === 0) {
      await payPaypalInstallment(page, links.paypal!);
    } else {
      const ref = newRef();
      await payManualInstallment(page, links.manual!, 18000, ref);
      expect(one<{ status: string }>(`SELECT status FROM Installment WHERE id = ?`, insId).status, "no se da por pagada sin verificar").not.toBe("PAID");
      expect(await moodleCoursesOf(request, A.moodleUserId)).toHaveLength(seq - 1);
      await adminApprove(browser, A.orderId, ref);
    }
    await expect.poll(() => one<{ status: string }>(`SELECT status FROM Installment WHERE id = ?`, insId).status, { timeout: 60_000 }).toBe("PAID");
    const want = A.courses.slice(0, seq).map((c) => c.moodleCourseId).sort((a, b) => a - b);
    await expect.poll(() => moodleCoursesOf(request, A.moodleUserId), { timeout: 60_000, message: `cuota ${seq}: cursos 1..${seq}` }).toEqual(want);
    expect(order(A.orderId).balanceCents).toBe((9 - seq) * 18000);
  }
  expect(order(A.orderId)).toMatchObject({ status: "ENROLLED", balanceCents: 0, amountPaidCents: 9 * 18000 });
  const pays = q<{ method: string; status: string }>(`SELECT method, status FROM Payment WHERE orderId = ? ORDER BY createdAt`, A.orderId);
  expect(pays.map((p) => p.method)).toEqual(["PAGO_MOVIL", "PAYPAL", "PAGO_MOVIL", "PAYPAL", "PAGO_MOVIL", "PAYPAL", "PAGO_MOVIL", "PAYPAL", "PAGO_MOVIL"]);
  expect(pays.every((p) => p.status === "COMPLETED")).toBe(true);
  // Un solo usuario de Moodle y un solo correo con contraseña en todo el diplomado.
  expect((await moodle(request)).users.filter((u) => u.email.toLowerCase() === A.email.toLowerCase())).toHaveLength(1);
  expect(emails(A.orderId).filter((m) => m.template === "platform_access" && m.secretRef)).toHaveLength(1);
  expect(cohort(A.cohortId).seatsConfirmed, "el cupo se ocupó una sola vez").toBe(seatsBefore.confirmed + 1);
});

test("1d · los 9 cursos completados en Moodle + job de certificados → un certificado verificable y correo con el PDF", async ({ request, page }) => {
  test.setTimeout(180_000);
  const certs = () => q<{ code: string; status: string; pdfPath: string | null }>(`SELECT code, status, pdfPath FROM Certificate WHERE customerId = ?`, customerOf(A.orderId).id);
  // 8 de 9: nada.
  for (const c of A.courses.slice(0, 8)) expect((await request.post(`${MOODLE}/__mock/complete`, { data: { userid: A.moodleUserId, courseid: c.moodleCourseId } })).ok()).toBe(true);
  await runCron(request, "certificates");
  expect(certs()).toHaveLength(0);
  expect((await request.post(`${MOODLE}/__mock/complete`, { data: { userid: A.moodleUserId, courseid: A.courses[8].moodleCourseId } })).ok()).toBe(true);
  await Promise.all([runCron(request, "certificates"), runCron(request, "certificates")]);
  await runCron(request, "certificates");
  const list = certs();
  expect(list, "exactamente un certificado").toHaveLength(1);
  expect(list[0].status).toBe("ISSUED");
  const code = list[0].code;
  expect(fs.readFileSync(path.resolve(APP_DIR, list[0].pdfPath!)).subarray(0, 5).toString()).toBe("%PDF-");

  const mail = q<{ status: string; text: string; attachments: string | null }>(`SELECT status, text, attachments FROM EmailOutbox WHERE template = 'certificate_issued' AND "to" = ?`, A.email);
  expect(mail).toHaveLength(1);
  expect(mail[0].status).toBe("SENT");
  expect(mail[0].text).toContain(`${e2eEnv.APP_URL}/certificados/${code}`);
  expect(JSON.parse(mail[0].attachments ?? "[]")).toEqual([expect.objectContaining({ filename: `Certificado-${code}.pdf`, contentType: "application/pdf" })]);

  await page.goto(`/certificados/${code}`);
  await expect(page.getByRole("status")).toHaveText("Certificado válido");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(DIPLOMA_TITLE);
  await expect(page.getByText(`${A.first} ${A.last}`)).toBeVisible();
  await expect(page.locator("ol li")).toHaveCount(9);
});

// ───────────── 2 y 3. Doctor B ─────────────

test("2 · Doctor B compra un curso online con PayPal de una vez → matriculado al instante, sin paso del admin", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.goto(`/products/${COURSE_B}`);
  const form = page.getByTestId("buy-form");
  await form.getByRole("group", { name: "Modalidad" }).getByRole("radio", { name: "Online" }).check();
  await form.getByRole("button", { name: "Agregar al carrito" }).click();
  await page.waitForURL("**/cart");
  await page.getByRole("link", { name: "Pagar pedido" }).click();
  await page.waitForURL("**/checkout");
  await page.getByLabel("Correo electrónico").fill(B.email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("0424-5559876");
  await page.getByLabel("Nombre", { exact: true }).fill(B.first);
  await page.getByLabel("Apellidos").fill(B.last);
  await page.getByLabel("Cédula de identidad").fill(B.cedula);
  await page.getByLabel("Especialidad").selectOption("Medicina general");
  await page.getByRole("group", { name: "Método de pago" }).getByRole("radio", { name: "PayPal" }).check();
  await page.getByRole("button", { name: "Pagar con PayPal" }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=completado$/, { timeout: 60_000 });

  const o = one<{ id: string }>(`SELECT o.id FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, B.email);
  B.orderId = o.id;
  await waitForOrderStatus(B.orderId, "ENROLLED", 30_000);
  B.moodleCourseId = one<{ moodleCourseId: number }>(`SELECT moodleCourseId FROM Product WHERE slug = ?`, COURSE_B).moodleCourseId;
  const uid = customerOf(B.orderId).moodleUserId!;
  expect(await moodleCoursesOf(request, uid)).toEqual([B.moodleCourseId]);
  expect(events(B.orderId).filter((e) => e.actorType === "ADMIN"), "sin ningún paso del admin").toEqual([]);
  expect(order(B.orderId)).toMatchObject({ balanceCents: 0 });
  await expect.poll(() => templatesOf(B.orderId).sort(), { timeout: 30_000 }).toEqual(["order_confirmation", "platform_access"].sort());
  const done = page.getByRole("region", { name: "¡Pago recibido!" });
  await expect(done).toContainText("Acceso al aula virtual");
  await expect(done).toContainText("Curso habilitado: Curso Universitario: Enfermedades Materno Fetales");
});

test("3 · el admin reembolsa a B desde el panel → reembolso en PayPal, desmatriculado, rastro en la cronología", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const pay = one<{ id: string; paypalCaptureId: string; amountCents: number }>(`SELECT id, paypalCaptureId, amountCents FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, B.orderId);
  const { ctx, page } = await adminSession(browser, "/admin/orders");
  try {
    await page.getByRole("button", { name: "Buscar y filtrar" }).click();
    await page.getByLabel("Buscar pedidos").fill(B.email);
    await page.getByLabel("Buscar pedidos").press("Enter");
    const n = one<{ number: number }>(`SELECT number FROM "Order" WHERE id = ?`, B.orderId).number;
    await page.getByRole("link", { name: `#${n}`, exact: true }).click();
    await page.waitForURL(`**/admin/orders/${B.orderId}`);
    await page.getByRole("button", { name: "Reembolsar", exact: true }).first().click();
    const card = page.getByTestId("payment").filter({ hasText: "PayPal" });
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await expect(form).toBeVisible();
    await form.getByLabel("Motivo").fill("No podrá cursarlo este trimestre");
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await waitForOrderStatus(B.orderId, "REFUNDED", 60_000);
    await page.reload();
    await expect(page.getByTestId("order-status")).toContainText("Reembolsado");
    const tl = page.getByRole("region", { name: "Cronología" }).or(page.locator("section.otl-sec"));
    await expect(tl).toContainText("solicitó a PayPal un reembolso");
    await expect(tl).toContainText(/Se reembolsaron \$150\.00 por PayPal/);
    await expect(tl).toContainText(/Desmatr/);
    await expect(tl).toContainText("Administrador");
  } finally {
    await ctx.close();
  }
  const pp = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds: unknown };
  const refunds = (Array.isArray(pp.refunds) ? pp.refunds : Object.values((pp.refunds ?? {}) as object)).filter((r) => JSON.stringify(r).includes(pay.paypalCaptureId));
  expect(refunds, "un reembolso en PayPal").toHaveLength(1);
  expect(q(`SELECT status, amountCents FROM Refund WHERE paymentId = ?`, pay.id)).toEqual([{ status: "COMPLETED", amountCents: pay.amountCents }]);
  const uid = customerOf(B.orderId).moodleUserId!;
  await expect.poll(() => moodleCoursesOf(request, uid), { timeout: 30_000 }).toEqual([]);
  expect(events(B.orderId).map((e) => e.type)).toEqual(expect.arrayContaining(["REFUND_REQUESTED", "REFUND", "UNENROLLMENT"]));
  expect(events(B.orderId, "REFUND_REQUESTED")[0].actorType).toBe("ADMIN");
  await expect.poll(() => templatesOf(B.orderId)).toContain("refund_issued");
});

// ───────────── 4. catálogo y cupo ─────────────

test("4 · el admin cambia el precio de un curso y el cupo de una cohorte → la tienda lo refleja al instante", async ({ browser, page }) => {
  test.setTimeout(180_000);
  const course = one<{ id: string; title: string }>(`SELECT id, title FROM Product WHERE slug = ?`, COURSE_PRICE);
  const { ctx, page: admin } = await adminSession(browser, "/admin/products");
  try {
    // Precio: Programas → buscar → ficha → matriz de precios → Guardar.
    await admin.getByLabel("Buscar programas").first().fill(course.title);
    await admin.getByLabel("Buscar programas").first().press("Enter");
    await admin.getByRole("link", { name: course.title, exact: true }).first().click();
    await admin.waitForURL(`**/admin/products/${course.id}`);
    const price = admin.getByLabel("Precio de lista Online", { exact: true });
    const was = Number(await price.inputValue());
    expect(was).toBeGreaterThan(0);
    const now = was + 25;
    await price.fill(String(now));
    await admin.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(admin.getByRole("region", { name: "Cambios sin guardar" })).toHaveCount(0, { timeout: 30_000 });

    await page.goto(`/products/${COURSE_PRICE}`);
    await page.getByTestId("buy-form").getByRole("group", { name: "Modalidad" }).getByRole("radio", { name: "Online" }).check();
    await expect(page.getByTestId("price")).toContainText(`$${now}.00`);

    // Cupo: Cohortes → la cohorte que compró A → Cupo máximo → Guardar.
    const c = one<{ name: string; capacity: number; seatsConfirmed: number; seatsHeld: number }>(`SELECT name, capacity, seatsConfirmed, seatsHeld FROM Cohort WHERE id = ?`, A.cohortId);
    await admin.goto(`/admin/cohorts/${A.cohortId}`);
    await admin.getByLabel("Cupo máximo", { exact: true }).fill(String(c.capacity + 4));
    await admin.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(admin.getByRole("region", { name: "Cambios sin guardar" })).toHaveCount(0, { timeout: 30_000 });
    const free = c.capacity + 4 - c.seatsConfirmed - c.seatsHeld;

    await page.goto(`/products/${DIPLOMA}`);
    const form = page.getByTestId("buy-form");
    await form.getByRole("group", { name: "Modalidad" }).getByRole("radio", { name: "Semipresencial" }).check();
    await form.getByRole("group", { name: "Sede" }).getByRole("radio", { name: "Barquisimeto" }).check();
    await expect(form.getByRole("group", { name: "Cohorte" }).getByRole("radio", { name: new RegExp(`${c.name}.*${free} cupos disponibles`) })).toBeVisible();
  } finally {
    await ctx.close();
  }
  expect(cohort(A.cohortId).capacity).toBeGreaterThan(0);
  expect(q(`SELECT action FROM AuditLog WHERE entityType IN ('PriceEntry','Cohort','Product') ORDER BY createdAt DESC LIMIT 5`).length).toBeGreaterThan(0);
});

// ───────────── 5. panel completo ─────────────

test("5 · cada sección de la navegación del panel abre (sin 404) y Clientes encuentra a Doctor A con su certificado", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page } = await adminSession(browser, "/admin");
  try {
    const nav = page.getByRole("navigation", { name: "Navegación del panel" });
    await nav.getByRole("link", { name: "Programas" }).click();
    await page.waitForURL("**/admin/products");
    const hrefs = await nav.getByRole("link").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href")!).filter((h) => h.startsWith("/admin")));
    expect(hrefs).toEqual(expect.arrayContaining(["/admin/orders", "/admin/products", "/admin/collections", "/admin/cohorts", "/admin/sedes", "/admin/customers", "/admin/settings"]));
    for (const h of hrefs) {
      const r = await page.goto(h);
      expect(r?.status(), h).toBe(200);
      await expect(page.getByRole("heading", { level: 1 }).first(), h).toBeVisible();
    }

    await page.goto("/admin/customers");
    await page.getByLabel("Buscar clientes").fill(A.email);
    await page.getByLabel("Buscar clientes").press("Enter");
    await page.getByRole("table", { name: "Clientes" }).getByRole("link", { name: `${A.first} ${A.last}` }).click();
    await page.waitForURL(`**/admin/customers/${customerOf(A.orderId).id}`);
    await expect(page.locator("main")).toContainText(DIPLOMA_TITLE);

    await page.goto("/admin/collections");
    const row = page.locator('tr[data-collection="diplomados"]');
    await expect(row).toContainText("Diplomados");
    await row.getByRole("button", { name: "Editar Diplomados" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("list", { name: "Programas de la colección" })).toContainText(DIPLOMA_TITLE);
  } finally {
    await ctx.close();
  }
});
