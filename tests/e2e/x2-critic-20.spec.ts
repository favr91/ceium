// x2 critic 20 — re-verificación por HTTP del arreglo de x2 critic 19 (PayPal retiene la captura) y su otra mitad:
//   1. PayPal RETIENE la captura, la revisión dura más que el plazo del pedido (el job de vencimientos corre y NO
//      libera el cupo), el médico intenta pagar con pago móvil y se le dice que PayPal está revisando; al final PayPal
//      RECHAZA la captura. Antes: ningún correo (se le había prometido «te avisaremos por correo») y el job vencía el
//      pedido y liberaba el cupo en la corrida siguiente. Ahora: correo «no pudimos verificar tu pago… no se te cobró»,
//      plazo nuevo con SU cupo; paga con pago móvil + comprobante → el admin aprueba → Moodle, cupo CONFIRMED, correos.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-20.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { PAYPAL, cohort, customerOf, emails, enrollments, fixture, moodleState, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { todayCaracas } from "./support/dates";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const COURSE = "curso-universitario-ecografia-de-abdomen";
const RATE = 187.25;
const ADMIN_EMAIL = "admin@ceium.net";
const ADMIN_PASSWORD = (() => {
  try {
    return parseDotenv(fs.readFileSync(path.join(__dirname, "../../.env"))).ADMIN_PASSWORD || "ceium-admin-2026";
  } catch {
    return "ceium-admin-2026";
  }
})();
const PAGO_MOVIL_REAL = {
  method: "PAGO_MOVIL",
  enabled: true,
  label: "Pago Móvil",
  currency: "VES",
  details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." },
  instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra la referencia y el comprobante.",
};
const OTHERS_OFF = [
  { method: "TRANSFERENCIA", enabled: false, label: "Transferencia bancaria", currency: "VES", details: { banco: "TODO: banco" }, instructions: "" },
  { method: "ZELLE", enabled: false, label: "Zelle", currency: "USD", details: { correo: "TODO: correo Zelle" }, instructions: "" },
  { method: "EFECTIVO", enabled: false, label: "Efectivo en sede", currency: "USD", details: { lugar: "TODO: sede y horario" }, instructions: "" },
];

interface CourseCohort { productId: string; moodleCourseId: number; sedeSlug: string; cohortId: string; capacity: number }
interface Placed { orderId: string; token: string; number: number; dueNowCents: number; totalCents: number }
let settingsBefore: unknown = null;

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
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(8 * 25))), chunk("IEND", Buffer.alloc(0))]);
}
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c20 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();

/** Rellena y envía el formulario de pago móvil de una pestaña de /pedido/<token> YA ABIERTA (sin recargarla). */
async function submitManualOnOpenTab(page: Page, opts: { reference: string; amountBs: number }) {
  await page.getByLabel("Número de referencia").fill(opts.reference);
  await page.getByLabel(/Monto pagado/).fill(ves(opts.amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  return new URL(page.url()).searchParams;
}
async function startPaypal(page: Page, token: string): Promise<string> {
  await page.goto(`/pedido/${token}`);
  const pay = page.getByRole("button", { name: /con PayPal/ });
  await expect(pay).toBeVisible();
  await pay.click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  return new URL(page.url()).searchParams.get("token")!;
}
async function adminLogin(browser: Browser) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/admin/login?next=${encodeURIComponent("/admin/orders")}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === "/admin/orders");
  return { ctx, page };
}
const paymentRows = (orderId: string) =>
  q<{ id: string; method: string; status: string; providerStatus: string | null; amountUsdCents: number; paypalOrderId: string | null; paypalCaptureId: string | null; reference: string | null }>(
    `SELECT id, method, status, providerStatus, amountUsdCents, paypalOrderId, paypalCaptureId, reference FROM Payment WHERE orderId = ? ORDER BY createdAt`,
    orderId,
  );
const liveHeld = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
const liveConfirmed = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: liveHeld(cohortId), confirmed: liveConfirmed(cohortId) });
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
}
async function ppCaptureOf(request: APIRequestContext, paypalOrderId: string): Promise<{ id: string; status: string } | null> {
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { orders: { id: string; purchase_units: { payments?: { captures?: { id: string; status: string }[] } }[] }[] };
  return st.orders.find((o) => o.id === paypalOrderId)?.purchase_units[0]?.payments?.captures?.[0] ?? null;
}

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});
test.afterAll(() => {
  if (Array.isArray(settingsBefore)) {
    try {
      fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
    } catch {
      /* datos previos no válidos para updateSetting */
    }
  }
});

test("PayPal retiene la captura más allá del plazo y luego la RECHAZA → cupo protegido, correo al médico, plazo nuevo; paga con pago móvil y el admin aprueba → Moodle, cupo, correos", async ({ browser, page, request }) => {
  const C = newCohort(1); // el último cupo
  const email = uniqueEmail("x2c20deny");
  const o = checkout(C, email, "PAGO_MOVIL");

  // PayPal retiene la captura.
  const pp = await startPaypal(page, o.token);
  await page.goto(`${PAYPAL}/__mock/approve/${pp}?capture=PENDING`);
  await expect.poll(() => paymentRows(o.orderId).find((p) => p.paypalOrderId === pp)?.providerStatus, { timeout: 30_000 }).toBe("CAPTURE_PENDING");
  const capture = await ppCaptureOf(request, pp);
  expect(capture?.status).toBe("PENDING");

  // La revisión dura días: pasa el plazo del pedido y corre el job de vencimientos → el cupo sigue siendo suyo.
  fixture("age-order", { orderId: o.orderId, minutes: 80 * 60 });
  await runCron(request, "expire");
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  expectCohortConsistent(C.cohortId);

  // Mientras tanto no puede registrar otro pago: se le dice que PayPal está revisando el suyo.
  await page.goto(`/pedido/${o.token}`);
  if (await page.getByLabel("Número de referencia").isVisible()) {
    const r = await submitManualOnOpenTab(page, { reference: newRef("0134"), amountBs: bs(o.dueNowCents) });
    expect(r.get("pago")).toBe("error");
    expect(r.get("motivo")).toMatch(/PayPal está revisando/);
  }
  expect(paymentRows(o.orderId).filter((p) => p.method === "PAGO_MOVIL")).toHaveLength(0);

  // PayPal rechaza la captura retenida (webhook PAYMENT.CAPTURE.DENIED).
  const denied = await request.post(`${PAYPAL}/__mock/captures/${capture!.id}/deny`);
  expect(denied.ok()).toBe(true);
  await expect.poll(() => paymentRows(o.orderId).find((p) => p.paypalOrderId === pp)?.status, { timeout: 30_000 }).toBe("FAILED");
  // Se le avisa (se le había prometido un correo) y no se le cobró nada.
  await expect.poll(() => emails(o.orderId).filter((m) => m.template === "payment_rejected").length, { timeout: 15_000 }).toBe(1);
  const rej = emails(o.orderId).find((m) => m.template === "payment_rejected")!;
  expect(rej.text).toMatch(/no se te cobró/);
  expect(rej.text).toMatch(/registrar nuevamente el pago/);
  expect(rej.text).toContain(`/pedido/${o.token}`);
  expect(emails(o.orderId).map((m) => m.template)).not.toContain("payment_approved");
  // El plazo original venció durante la revisión: la corrida siguiente del job NO le quita el cupo.
  await runCron(request, "expire");
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  let otherGotSeat = true;
  try {
    checkout(C, uniqueEmail("x2c20other"), "PAGO_MOVIL");
  } catch {
    otherGotSeat = false;
  }
  expect(otherGotSeat, "otro comprador tomó el cupo del médico recién avisado").toBe(false);

  // Paga con pago móvil + comprobante desde la página del pedido (enlace del correo).
  await page.goto(`/pedido/${o.token}`);
  const ref = newRef("0102");
  const r = await submitManualOnOpenTab(page, { reference: ref, amountBs: bs(o.dueNowCents) });
  expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  await expect.poll(() => emails(o.orderId).map((m) => m.template), { timeout: 15_000 }).toContain("payment_under_verification");

  // El admin ve el comprobante y aprueba → Moodle, cupo CONFIRMED, correos.
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    const card = admin.getByTestId("payment").filter({ hasText: ref });
    await expect(card.locator("img").first()).toBeVisible();
    await card.getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible({ timeout: 60_000 });
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "ENROLLED" }]);
  const uid = customerOf(o.orderId).moodleUserId;
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  const mails = emails(o.orderId).map((m) => m.template);
  expect(mails).toEqual(expect.arrayContaining(["payment_approved", "platform_access", "cohort_details"]));
  expectCohortConsistent(C.cohortId);
  expect(await ppCaptureOf(request, pp)).toMatchObject({ status: "DECLINED" });
});
