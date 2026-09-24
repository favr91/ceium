// x2 critic 19 — sondas adversariales nuevas contra pago móvil → verificación → Moodle → cupo → correos y el
// reembolso PayPal, por HTTP contra el carril (app + mocks), mirando el resultado REAL (BD, mocks, correos).
//   1. PayPal RETIENE la captura (PAYMENT.CAPTURE.PENDING: revisión/eCheck; el dinero del médico está retenido) y el
//      médico, desde la pestaña del pedido que tenía abierta, registra además un pago móvil. El admin rechaza ese
//      comprobante (no aparece en el banco). El pedido NO debe quedar «Rechazado» con el cupo liberado: PayPal sigue
//      reteniendo su dinero. Si se libera, otro médico toma el último cupo y cuando PayPal confirma la captura el
//      primero queda COBRADO SIN CUPO (y el correo de rechazo le dijo que su cupo quedó libre).
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-19.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { PAYPAL, cohort, emails, events, fixture, one, order, q, reservationOf, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c19 ${Date.now().toString(36)}` });
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

test("PayPal retiene la captura y el médico registra además un pago móvil; el admin lo rechaza → el cupo sigue protegido y, al confirmar PayPal, el médico queda con su cupo (nunca cobrado sin cupo)", async ({ browser, page, request }) => {
  const C = newCohort(1); // el último cupo
  const email = uniqueEmail("x2c19hold");
  const o = checkout(C, email, "PAGO_MOVIL");
  expect(cohort(C.cohortId)).toMatchObject({ seatsHeld: 1, seatsConfirmed: 0 });

  // Pestaña 1: la página del pedido abierta con el formulario de pago móvil (antes de ir a PayPal).
  await page.goto(`/pedido/${o.token}`);
  await expect(page.getByLabel("Número de referencia")).toBeVisible();

  // Pestaña 2: paga con PayPal; PayPal retiene la captura (PENDING) → el pedido queda «PayPal está revisando tu pago».
  const ctx2 = await browser.newContext({ locale: "es-VE" });
  const p2 = await ctx2.newPage();
  const pp = await startPaypal(p2, o.token);
  await p2.goto(`${PAYPAL}/__mock/approve/${pp}?capture=PENDING`);
  await expect.poll(() => paymentRows(o.orderId).find((p) => p.paypalOrderId === pp)?.providerStatus, { timeout: 30_000 }).toBe("CAPTURE_PENDING");
  await ctx2.close();
  const capture = await ppCaptureOf(request, pp);
  expect(capture?.status).toBe("PENDING");
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
  expect(reservationOf(o.orderId).status).toBe("HELD");

  // Pestaña 1 (sin recargar): el médico registra también un pago móvil.
  const ref = newRef("0134");
  const r = await submitManualOnOpenTab(page, { reference: ref, amountBs: bs(o.dueNowCents) });
  const manualRegistered = r.get("pago") === "registrado";

  if (manualRegistered) {
    // El admin no encuentra ese pago móvil en el banco y lo rechaza.
    const { ctx, page: admin } = await adminLogin(browser);
    try {
      await admin.goto(`/admin/orders/${o.orderId}`);
      const card = admin.getByTestId("payment").filter({ hasText: ref });
      await card.getByRole("button", { name: "Rechazar pago" }).click(); // abre el formulario del motivo
      await card.getByRole("form", { name: "Rechazar pago" }).getByLabel("Motivo del rechazo").fill("La referencia no aparece en el banco.");
      await card.getByRole("form", { name: "Rechazar pago" }).getByRole("button", { name: "Rechazar pago" }).click();
      await expect(admin.getByRole("status").filter({ hasText: "Pago rechazado" })).toBeVisible({ timeout: 60_000 });
    } finally {
      await ctx.close();
    }
    // PayPal sigue reteniendo el dinero del médico: el pedido no se da por rechazado ni se libera su cupo.
    expect(order(o.orderId).status, "pedido con PayPal retenido tras rechazar el pago móvil").not.toBe("REJECTED");
    expect(reservationOf(o.orderId).status, "reserva con PayPal retenido tras rechazar el pago móvil").toBe("HELD");
    const rej = emails(o.orderId).filter((m) => m.template === "payment_rejected");
    expect(rej).toHaveLength(1);
    expect(rej[0].text, "el correo de rechazo no debe decir que su cupo quedó libre mientras PayPal retiene su pago").not.toMatch(/cupo (reservado )?(fue |qued[óo] )?(libre|liberado)|liber(amos|ó) (tu|el) cupo/i);
  } else {
    // Rechazado al registrar (PayPal está revisando su pago): nada queda en verificación ni se le pide pagar otra vez.
    expect(r.get("motivo")).toMatch(/PayPal está revisando/);
    expect(paymentRows(o.orderId).filter((p) => p.method === "PAGO_MOVIL")).toHaveLength(0);
    expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
    expect(emails(o.orderId).map((m) => m.template)).not.toContain("payment_under_verification");
  }
  expectCohortConsistent(C.cohortId);

  // Otro médico intenta tomar el último cupo: no hay.
  let otherGotSeat = false;
  try {
    checkout(C, uniqueEmail("x2c19other"), "PAGO_MOVIL");
    otherGotSeat = true;
  } catch {
    otherGotSeat = false;
  }
  expect(otherGotSeat, "otro comprador tomó el cupo del médico cuyo pago PayPal está retenido").toBe(false);

  // PayPal libera la captura → el médico queda pagado, con SU cupo y matriculado.
  const done = await request.post(`${PAYPAL}/__mock/captures/${capture!.id}/complete`);
  expect(done.ok()).toBe(true);
  await waitForOrderStatus(o.orderId, ["PAID", "ENROLLED"]);
  expect(events(o.orderId, "SEAT_UNAVAILABLE"), "cobrado sin cupo").toHaveLength(0);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  await waitForOrderStatus(o.orderId, "ENROLLED");
  expectCohortConsistent(C.cohortId);
});
