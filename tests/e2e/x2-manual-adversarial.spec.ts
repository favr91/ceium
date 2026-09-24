// Pieza x2 — ataques adversariales al pago manual (pago móvil + comprobante → verificación del admin) y a los
// reembolsos, por HTTP contra la app y los mocks (formulario del pedido y panel en el navegador, job por
// /api/cron, fallos de Moodle con /__mock/fail-next, reembolsos desde PayPal por su API). Cada caso comprueba
// el resultado REAL: BD (pedido, pagos, reservas, contadores del cupo, eventos), estado del mock de Moodle y
// bandeja de correos — no solo lo que dice la pantalla.
//   1. Dos pestañas del admin aprueban a la vez → un pago imputado, una matrícula, un cupo, un correo de cada.
//   2. Aprobar y rechazar a la vez → gana uno y todo queda coherente con ese resultado.
//   3. Doble envío del comprobante (misma referencia, dos pestañas) → un solo pago.
//   3b. Pago móvil sin comprobante o con un archivo que no es imagen/PDF → rechazado por el servidor.
//   4. Moodle caído al aprobar → pagado y cupo ocupado; el job matricula una sola vez.
//   5. Comprobante tardío (pestaña abierta antes del vencimiento) con la cohorte ya llena → se rechaza al
//      enviar; nunca queda un pedido «en verificación» sin cupo ni un «pago aprobado» sin plaza.
//   6. Comprobante tardío con cupo libre → vuelve a tomar el cupo al enviar; nadie se lo quita.
//   7. Comprobante en verificación con el plazo vencido → el job no libera el cupo.
//   8. Monto incorrecto: de menos → cupo protegido y pedido pendiente; el resto → inscrito. De más → aviso de
//      saldo a favor.
//   9. Reenvío tras un rechazo (pestaña abierta) → retoma el cupo. Comprobante bajo otro pedido → 404.
//  10. Reembolsos: dos envíos a la vez → un solo reembolso en PayPal; Moodle cae al desmatricular → el job la
//      reintenta; reembolso parcial desde PayPal a la vez que el total del panel → cuadra; pago móvil → manual.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-manual-adversarial.spec.ts
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, enrolCallsFor, enrollments, events, fixture, fixtureAsync, moodleCalls, moodleState, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
interface Placed { orderId: string; token: string; number: number; dueNowCents: number }
let settingsBefore: unknown = null;
let retryBefore: unknown = null;

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
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(8 * 25))), chunk("IEND", Buffer.alloc(0))]);
}

const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2adv ${Date.now().toString(36)}` });
/** Checkout como lo hace la tienda (reserva el cupo; pago móvil → 72 h). */
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const tryCheckout = async (C: CourseCohort, email: string) => {
  const r = await fixtureAsync<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAGO_MOVIL" });
  return r.ok ? { ok: true as const, order: r.value } : { ok: false as const, error: r.error };
};
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();

/** El médico abre su pedido y rellena el formulario de pago manual (sin enviarlo). */
async function fillManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(opts.reference);
  await page.getByLabel(/Monto pagado/).fill(ves(opts.amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
}
/** Envía el formulario ya rellenado; devuelve los parámetros con los que vuelve la página (pago=registrado|error). */
async function submitManual(page: Page) {
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  return new URL(page.url()).searchParams;
}
async function reportManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
  await fillManual(page, token, opts);
  const r = await submitManual(page);
  expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
}

async function adminPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/admin/login?next=${encodeURIComponent("/admin/orders")}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === "/admin/orders");
  return { ctx, page };
}
const card = (page: Page, reference: string) => page.getByTestId("payment").filter({ hasText: reference });
/** Pulsa un botón del panel (acción de servidor) y devuelve el texto del aviso que muestra. */
async function clickForToast(page: Page, button: ReturnType<Page["getByRole"]>) {
  await button.click();
  const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta/i }).last();
  await toast.waitFor({ timeout: 30_000 });
  return (await toast.textContent()) ?? "";
}
async function approveInPanel(browser: Browser, orderId: string, ref: string) {
  const A = await adminPage(browser);
  try {
    await A.page.goto(`/admin/orders/${orderId}`);
    return await clickForToast(A.page, card(A.page, ref).getByRole("button", { name: "Aprobar pago" }));
  } finally {
    await A.ctx.close();
  }
}
async function openReject(page: Page, ref: string, reason: string) {
  await card(page, ref).getByRole("button", { name: "Rechazar pago" }).click();
  const form = card(page, ref).getByRole("form", { name: "Rechazar pago" });
  await form.getByLabel("Motivo del rechazo").fill(reason);
  return form.getByRole("button", { name: "Rechazar pago" });
}

const paymentRows = (orderId: string) =>
  q<{ id: string; status: string; reference: string | null; amountUsdCents: number; proofFile: string | null }>(`SELECT id, status, reference, amountUsdCents, proofFile FROM Payment WHERE orderId = ? ORDER BY createdAt`, orderId);
const templates = (orderId: string) => emails(orderId).map((e) => e.template);
const countOf = (xs: string[], x: string) => xs.filter((y) => y === x).length;
const eventTypes = (orderId: string) => events(orderId).map((e) => e.type);
const liveHeld = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
const liveConfirmed = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
/** Los contadores de la cohorte cuadran con sus reservas y nunca superan el cupo. */
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: liveHeld(cohortId), confirmed: liveConfirmed(cohortId) });
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
}
async function enrolmentsOf(request: APIRequestContext, orderId: string) {
  const uid = customerOf(orderId).moodleUserId;
  if (uid == null) return [];
  return (await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid);
}

// ───────────── preparación ─────────────

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  // Reintentos de Moodle rápidos (mínimo permitido) para que el job los retome en la prueba.
  retryBefore = fixture<{ before: unknown }>("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } }).before;
});
test.afterAll(() => {
  for (const [key, value] of [["payments.manualMethods", settingsBefore], ["enrollment.retry", retryBefore]] as const) {
    if (value == null) continue;
    try {
      fixture("setting", { key, value });
    } catch {
      /* valor previo no válido para updateSetting: se queda el de esta corrida */
    }
  }
});

// ───────────── 1–3. concurrencia en la verificación ─────────────

test("dos pestañas del admin aprueban el mismo pago a la vez → se imputa una vez: una matrícula, un cupo, un correo de cada", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("adv-dbl");
  const o = checkout(C, email);
  const ref = newRef("0134");
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  const A = await adminPage(browser);
  const B = await adminPage(browser);
  let toasts: string[];
  try {
    await Promise.all([A.page.goto(`/admin/orders/${o.orderId}`), B.page.goto(`/admin/orders/${o.orderId}`)]);
    toasts = await Promise.all([
      clickForToast(A.page, card(A.page, ref).getByRole("button", { name: "Aprobar pago" })),
      clickForToast(B.page, card(B.page, ref).getByRole("button", { name: "Aprobar pago" })),
    ]);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
  expect(toasts.filter((t) => /Pago aprobado/.test(t))).toHaveLength(1);
  expect(toasts.filter((t) => /ya fue verificado/.test(t))).toHaveLength(1);

  await waitForOrderStatus(o.orderId, "ENROLLED");
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.dueNowCents, balanceCents: 0 });
  expect(countOf(eventTypes(o.orderId), "PAYMENT_VERIFIED")).toBe(1);
  expect(countOf(eventTypes(o.orderId), "PAYMENT_RECEIVED")).toBe(1);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  const uid = customerOf(o.orderId).moodleUserId!;
  expect(enrolCallsFor(await moodleCalls(request), uid)).toEqual([C.moodleCourseId]);
  expect((await moodleState(request)).users.filter((u) => u.email.toLowerCase() === email)).toHaveLength(1);
  const t = templates(o.orderId);
  for (const x of ["payment_under_verification", "payment_approved", "platform_access", "cohort_details"]) expect(countOf(t, x), x).toBe(1);
});

test("aprobar y rechazar el mismo pago a la vez → gana uno y todo queda coherente con ese resultado", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("adv-race"));
  const ref = newRef("0102");
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  const A = await adminPage(browser);
  const B = await adminPage(browser);
  let toasts: string[];
  try {
    await Promise.all([A.page.goto(`/admin/orders/${o.orderId}`), B.page.goto(`/admin/orders/${o.orderId}`)]);
    const reject = await openReject(B.page, ref, "La referencia no aparece en el banco.");
    toasts = await Promise.all([clickForToast(A.page, card(A.page, ref).getByRole("button", { name: "Aprobar pago" })), clickForToast(B.page, reject)]);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
  expect(toasts.filter((t) => /ya fue verificado/.test(t))).toHaveLength(1);
  const [pay] = paymentRows(o.orderId);
  if (pay.status === "COMPLETED") {
    await waitForOrderStatus(o.orderId, "ENROLLED");
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
    expect(await enrolmentsOf(request, o.orderId)).toEqual([C.moodleCourseId]);
    expect(templates(o.orderId)).not.toContain("payment_rejected");
  } else {
    expect(pay.status).toBe("REJECTED");
    expect(order(o.orderId).status).toBe("REJECTED");
    expect(reservationOf(o.orderId).status).toBe("RELEASED");
    expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
    expect(customerOf(o.orderId).moodleUserId).toBeNull();
    expect(templates(o.orderId)).not.toContain("payment_approved");
    expect(countOf(templates(o.orderId), "payment_rejected")).toBe(1);
  }
  expect(countOf(eventTypes(o.orderId), "PAYMENT_VERIFIED") + countOf(eventTypes(o.orderId), "PAYMENT_REJECTED")).toBe(1);
});

test("doble envío del comprobante con la misma referencia (dos pestañas a la vez) → un solo pago en verificación", async ({ browser }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("adv-sub"));
  const ref = newRef("0105");
  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  try {
    const [p1, p2] = [await c1.newPage(), await c2.newPage()];
    await Promise.all([fillManual(p1, o.token, { reference: ref, amountBs: bs(o.dueNowCents) }), fillManual(p2, o.token, { reference: ref, amountBs: bs(o.dueNowCents) })]);
    const results = await Promise.all([submitManual(p1), submitManual(p2)]);
    expect(results.map((r) => r.get("pago")).sort()).toEqual(["error", "registrado"]);
    expect(results.find((r) => r.get("pago") === "error")!.get("motivo")).toMatch(/ya fue registrada/);
  } finally {
    await c1.close();
    await c2.close();
  }
  expect(paymentRows(o.orderId)).toHaveLength(1);
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(countOf(templates(o.orderId), "payment_under_verification")).toBe(1);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 1, seatsConfirmed: 0 });
});

// ───────────── 4. Moodle caído ─────────────

test("pago móvil sin comprobante (o con un archivo que no es imagen/PDF) → el servidor lo rechaza: ni pago, ni «en verificación», ni correo", async ({ page }) => {
  const C = newCohort(2);
  const o = checkout(C, uniqueEmail("adv-noproof"));
  const ref = newRef("0105");
  const fileInput = page.locator('input[type="file"][name="proof"]');
  // Se salta cualquier validación del navegador (required / accept): la regla la impone el servidor.
  const bypassBrowserChecks = () => fileInput.evaluate((el) => { el.removeAttribute("required"); el.removeAttribute("accept"); el.closest("form")?.setAttribute("novalidate", ""); });

  await fillManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  await fileInput.setInputFiles([]);
  await bypassBrowserChecks();
  let r = await submitManual(page);
  expect(r.get("pago")).toBe("error");
  expect(r.get("motivo")).toMatch(/Adjunta el comprobante/);

  await fillManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  await fileInput.setInputFiles({ name: "comprobante.txt", mimeType: "text/plain", buffer: Buffer.from("no es un comprobante") });
  await bypassBrowserChecks();
  r = await submitManual(page);
  expect(r.get("pago")).toBe("error");
  expect(r.get("motivo")).toMatch(/imagen .* o un PDF/);

  expect(paymentRows(o.orderId)).toEqual([]);
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  expect(templates(o.orderId)).not.toContain("payment_under_verification");

  // Con el comprobante sí entra, y el admin tiene el archivo para verlo.
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  const rows = paymentRows(o.orderId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "AWAITING_VERIFICATION", reference: ref });
  expect(rows[0].proofFile).toMatch(/proofs[\\/].+\.png$/);
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(countOf(templates(o.orderId), "payment_under_verification")).toBe(1);
  expectCohortConsistent(C.cohortId);
});

test("Moodle caído al aprobar → pagado y cupo ocupado; el job reintenta y matricula una sola vez", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("adv-moodle"));
  const ref = newRef("0108");
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { type: "http", status: 503, count: 1 } });
  expect(await approveInPanel(browser, o.orderId, ref)).toMatch(/Pago aprobado/);

  expect(order(o.orderId).status).toBe("PAID");
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  expect(eventTypes(o.orderId)).toContain("ENROLLMENT_FAILED");
  expect(templates(o.orderId)).not.toContain("platform_access");

  await expect
    .poll(async () => (await runCron(request, "enrollments"), order(o.orderId).status), { timeout: 45_000, intervals: [5_500] })
    .toBe("ENROLLED");
  const uid = customerOf(o.orderId).moodleUserId!;
  expect(enrolCallsFor(await moodleCalls(request), uid)).toEqual([C.moodleCourseId]);
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "ENROLLED" }]);
  for (const x of ["payment_approved", "platform_access", "cohort_details"]) expect(countOf(templates(o.orderId), x), x).toBe(1);
});

// ───────────── 5–7. reservas vencidas ─────────────

test("comprobante tardío (pestaña abierta antes del vencimiento) con la cohorte ya llena → se rechaza al enviar; nada queda en verificación sin cupo", async ({ page, request }) => {
  const C = newCohort(1);
  const late = checkout(C, uniqueEmail("adv-late"));
  const ref = newRef("0111");
  await fillManual(page, late.token, { reference: ref, amountBs: bs(late.dueNowCents) });
  fixture("age-order", { orderId: late.orderId, minutes: 73 * 60 });
  await runCron(request, "expire");
  expect(order(late.orderId).status).toBe("EXPIRED");
  expect(reservationOf(late.orderId).status).toBe("RELEASED");
  // Otro médico toma el único cupo.
  const other = checkout(C, uniqueEmail("adv-other"));
  expect(reservationOf(other.orderId).status).toBe("HELD");

  const r = await submitManual(page);
  expect(r.get("pago")).toBe("error");
  expect(r.get("motivo")).toMatch(/ya no tiene cupos/);
  expect(order(late.orderId).status).toBe("EXPIRED");
  expect(paymentRows(late.orderId)).toEqual([]);
  expect(reservationOf(late.orderId).status).toBe("RELEASED");
  expect(templates(late.orderId)).not.toContain("payment_under_verification");
  expect(cohort(C.cohortId)).toEqual({ capacity: 1, seatsHeld: 1, seatsConfirmed: 0 });
  expectCohortConsistent(C.cohortId);
});

test("comprobante tardío con cupo libre → vuelve a tomar el cupo al enviarlo y nadie se lo quita; aprobar → ocupado", async ({ browser, page, request }) => {
  const C = newCohort(2);
  const late = checkout(C, uniqueEmail("adv-late2"));
  const ref = newRef("0112");
  await fillManual(page, late.token, { reference: ref, amountBs: bs(late.dueNowCents) });
  fixture("age-order", { orderId: late.orderId, minutes: 73 * 60 });
  await runCron(request, "expire");
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 0 });

  expect((await submitManual(page)).get("pago")).toBe("registrado");
  expect(order(late.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(late.orderId).status).toBe("HELD");
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 1, seatsConfirmed: 0 });
  expect(eventTypes(late.orderId)).toContain("SEAT_REACQUIRED");

  // Dos compradores más por el cupo que queda: solo uno lo consigue.
  const buyers = await Promise.all([tryCheckout(C, uniqueEmail("adv-fill-a")), tryCheckout(C, uniqueEmail("adv-fill-b"))]);
  expect(buyers.filter((b) => b.ok)).toHaveLength(1);
  expect(buyers.find((b) => !b.ok)!.error).toMatch(/No quedan cupos/);
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 2, seatsConfirmed: 0 });

  // Aunque el plazo original venció hace mucho, en verificación el job no lo libera.
  fixture("age-order", { orderId: late.orderId, minutes: 100 * 60 });
  await runCron(request, "expire");
  expect(reservationOf(late.orderId).status).toBe("HELD");

  expect(await approveInPanel(browser, late.orderId, ref)).toMatch(/Pago aprobado/);
  await waitForOrderStatus(late.orderId, "ENROLLED");
  expect(reservationOf(late.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 1, seatsConfirmed: 1 });
  expect(eventTypes(late.orderId)).not.toContain("SEAT_UNAVAILABLE");
  expect(await enrolmentsOf(request, late.orderId)).toEqual([C.moodleCourseId]);
  expectCohortConsistent(C.cohortId);
});

test("comprobante en verificación y plazo vencido → el job no libera el cupo; otro comprador no lo toma; aprobar → ocupado", async ({ browser, page, request }) => {
  const C = newCohort(1);
  const o = checkout(C, uniqueEmail("adv-prot"));
  const ref = newRef("0113");
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  fixture("age-order", { orderId: o.orderId, minutes: 100 * 60 });
  await runCron(request, "expire");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  const other = await tryCheckout(C, uniqueEmail("adv-prot-other"));
  expect(other.ok).toBe(false);
  expect(await approveInPanel(browser, o.orderId, ref)).toMatch(/Pago aprobado/);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 1 });
  expectCohortConsistent(C.cohortId);
});

// ───────────── 8. monto incorrecto ─────────────

test("monto de menos → pedido pendiente con el cupo protegido; el resto → inscrito. Monto de más → aviso de saldo a favor", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("adv-half"));
  const ref1 = newRef("0114");
  await reportManual(page, o.token, { reference: ref1, amountBs: bs(o.dueNowCents / 2) });
  expect(await approveInPanel(browser, o.orderId, ref1)).toMatch(/Pago aprobado/);
  expect(order(o.orderId)).toMatchObject({ status: "PENDING_PAYMENT", amountPaidCents: o.dueNowCents / 2 });
  expect(customerOf(o.orderId).moodleUserId).toBeNull();
  expect(events(o.orderId).some((e) => e.type === "ATTENTION" && /falta|insuficiente/i.test(e.note ?? ""))).toBe(true);
  // Aunque pase el plazo: hay dinero cobrado → no vence ni se libera el cupo.
  fixture("age-order", { orderId: o.orderId, minutes: 100 * 60 });
  await runCron(request, "expire");
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
  expect(reservationOf(o.orderId).status).toBe("HELD");

  const ref2 = newRef("0115");
  await reportManual(page, o.token, { reference: ref2, amountBs: bs(o.dueNowCents / 2) });
  expect(await approveInPanel(browser, o.orderId, ref2)).toMatch(/Pago aprobado/);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.dueNowCents, balanceCents: 0 });
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  expect(await enrolmentsOf(request, o.orderId)).toEqual([C.moodleCourseId]);

  const over = checkout(C, uniqueEmail("adv-over"));
  const ref3 = newRef("0116");
  await reportManual(page, over.token, { reference: ref3, amountBs: bs(over.dueNowCents * 3) });
  expect(await approveInPanel(browser, over.orderId, ref3)).toMatch(/Pago aprobado/);
  await waitForOrderStatus(over.orderId, "ENROLLED");
  expect(order(over.orderId)).toMatchObject({ amountPaidCents: over.dueNowCents * 3, balanceCents: -over.dueNowCents * 2 });
  const credit = events(over.orderId).find((e) => e.type === "ATTENTION" && /de más/.test(e.note ?? ""));
  expect(credit?.note).toContain(((over.dueNowCents * 2) / 100).toFixed(2));
  expect(JSON.parse(credit!.data!)).toMatchObject({ creditCents: over.dueNowCents * 2 });
});

// ───────────── 9. rechazo y comprobantes ─────────────

test("reenvío tras un rechazo desde la pestaña abierta → retoma el cupo; el comprobante no se sirve bajo otro pedido ni sin sesión", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("adv-rej"));
  const ref = newRef("0117");
  // Otra pestaña del pedido abierta ANTES de enviar el primer comprobante (con el pago corregido): se envía
  // cuando el admin ya rechazó el primero y el cupo se liberó.
  const ref2 = newRef("0118");
  const tabCtx = await browser.newContext();
  const tab = await tabCtx.newPage();
  await fillManual(tab, o.token, { reference: ref2, amountBs: bs(o.dueNowCents) });
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  const payId = paymentRows(o.orderId)[0].id;
  const other = checkout(C, uniqueEmail("adv-idor"));

  const A = await adminPage(browser);
  try {
    await A.page.goto(`/admin/orders/${o.orderId}`);
    expect(await clickForToast(A.page, await openReject(A.page, ref, "Monto incorrecto."))).toMatch(/Pago rechazado/);
    expect((await A.page.request.get(`/admin/orders/${other.orderId}/comprobante/${payId}`)).status()).toBe(404);
    const own = await A.page.request.get(`/admin/orders/${o.orderId}/comprobante/${payId}`);
    expect(own.status()).toBe(200);
    expect(own.headers()["x-content-type-options"]).toBe("nosniff");
  } finally {
    await A.ctx.close();
  }
  expect((await request.get(`/admin/orders/${o.orderId}/comprobante/${payId}`)).status()).toBe(401);
  expect(order(o.orderId).status).toBe("REJECTED");
  expect(reservationOf(o.orderId).status).toBe("RELEASED");
  const afterReject = cohort(C.cohortId);

  try {
    expect((await submitManual(tab)).get("pago")).toBe("registrado");
  } finally {
    await tabCtx.close();
  }
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  expect(cohort(C.cohortId)).toEqual({ ...afterReject, seatsHeld: afterReject.seatsHeld + 1 });
  expectCohortConsistent(C.cohortId);
});

// ───────────── 10. reembolsos ─────────────

async function buyWithPaypal(page: Page, request: APIRequestContext, C: CourseCohort, email: string) {
  const o = checkout(C, email, "PAYPAL");
  await page.goto(`/pedido/${o.token}`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const pp = new URL(page.url()).searchParams.get("token")!;
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`)).json();
  await request.get(a.redirect, { maxRedirects: 0 });
  await waitForOrderStatus(o.orderId, "ENROLLED");
  const pay = one<{ id: string; paypalCaptureId: string; amountCents: number }>(`SELECT id, paypalCaptureId, amountCents FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.orderId);
  return { ...o, pay };
}
async function paypalRefundsOf(request: APIRequestContext, captureId: string) {
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown };
  const list = (Array.isArray(st.refunds) ? st.refunds : Object.values((st.refunds ?? {}) as Record<string, unknown>)) as { id: string; amount: { value: string } }[];
  return list.filter((r) => JSON.stringify(r).includes(captureId));
}

test("reembolso: dos envíos a la vez (dos pestañas) → un solo reembolso en PayPal y el cupo se libera una vez", async ({ page, request }) => {
  const C = newCohort(3);
  const a = await buyWithPaypal(page, request, C, uniqueEmail("adv-rf2"));
  const [r1, r2] = await Promise.all([
    fixtureAsync<{ refundId: string }>("refund", { paymentId: a.pay.id, reason: "pestaña A", idempotencyKey: `tabA-${a.orderId}` }),
    fixtureAsync<{ refundId: string }>("refund", { paymentId: a.pay.id, reason: "pestaña B", idempotencyKey: `tabB-${a.orderId}` }),
  ]);
  // O retoma el mismo reembolso o se rechaza como doble envío; nunca dos.
  const ok = [r1, r2].filter((r) => r.ok);
  expect(ok.length).toBeGreaterThanOrEqual(1);
  expect(new Set(ok.map((r) => (r as { value: { refundId: string } }).value.refundId)).size).toBe(1);
  for (const r of [r1, r2]) if (!r.ok) expect(r.error).toMatch(/hace un momento|en curso/);
  await expect.poll(async () => (await paypalRefundsOf(request, a.pay.paypalCaptureId)).length).toBe(1);
  await page.waitForTimeout(1000); // el webhook PAYMENT.CAPTURE.REFUNDED no debe duplicar nada
  expect(q(`SELECT status, amountCents FROM Refund WHERE paymentId = ?`, a.pay.id)).toEqual([{ status: "COMPLETED", amountCents: a.pay.amountCents }]);
  expect(order(a.orderId)).toMatchObject({ status: "REFUNDED", amountPaidCents: 0 });
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  expect(countOf(templates(a.orderId), "refund_issued")).toBe(1);
  expect(countOf(eventTypes(a.orderId), "SEAT_RELEASED")).toBe(1);
});

test("reembolso con Moodle caído al desmatricular → pedido reembolsado y cupo libre; el job reintenta y desmatricula", async ({ page, request }) => {
  const C = newCohort(3);
  const b = await buyWithPaypal(page, request, C, uniqueEmail("adv-rfm"));
  expect(await enrolmentsOf(request, b.orderId)).toEqual([C.moodleCourseId]);
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_unenrol_users", type: "http", status: 503, count: 1 } });
  fixture("refund", { paymentId: b.pay.id, reason: "No podrá asistir", unenroll: true });
  expect(order(b.orderId).status).toBe("REFUNDED");
  expect(reservationOf(b.orderId).status).toBe("RELEASED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  expect(eventTypes(b.orderId)).toContain("UNENROLLMENT_FAILED");
  expect(events(b.orderId).some((e) => e.type === "ATTENTION" && /desmatricular/.test(e.note ?? ""))).toBe(true);
  expect(await enrolmentsOf(request, b.orderId)).toEqual([C.moodleCourseId]); // aún con acceso

  const res = await runCron(request, "enrollments");
  expect(res.results.enrollments.unenrollments.unenrolled).toBeGreaterThanOrEqual(1);
  expect(await enrolmentsOf(request, b.orderId)).toEqual([]);
  expect(enrollments(b.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "UNENROLLED" }]);
  expect(eventTypes(b.orderId)).toContain("UNENROLLMENT");
  // Ya resuelto: el siguiente pase no vuelve a llamar a Moodle por este pedido ni lo rematricula.
  // Por tiempo, no por índice: el mock guarda solo las últimas 200 llamadas (un slice por índice quedaría vacío
  // y estas comprobaciones pasarían sin mirar nada).
  const since = Date.now();
  const res2 = await runCron(request, "enrollments");
  const uid = customerOf(b.orderId).moodleUserId!;
  expect(enrolCallsFor((await moodleCalls(request)).filter((c) => c.at >= since), uid)).toEqual([]);
  expect((await moodleCalls(request)).filter((c) => c.at >= since).filter((c) => c.wsfunction === "enrol_manual_unenrol_users" && JSON.stringify(c.params).includes(String(uid)))).toEqual([]);
  expect(res2.results.enrollments.unenrollments.orders).toBe(0);
  expect(await enrolmentsOf(request, b.orderId)).toEqual([]);
  expect(order(b.orderId).status).toBe("REFUNDED");
  expect(countOf(templates(b.orderId), "refund_issued")).toBe(1);
});

test("reembolso parcial hecho en PayPal a la vez que el total desde el panel → lo reembolsado cuadra con PayPal", async ({ page, request }) => {
  const C = newCohort(3);
  const c = await buyWithPaypal(page, request, C, uniqueEmail("adv-rfpp"));
  const tok = await (await request.post(`${PAYPAL}/v1/oauth2/token`, { headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}` }, form: { grant_type: "client_credentials" } })).json();
  const [ext, panel] = await Promise.all([
    request.post(`${PAYPAL}/v2/payments/captures/${c.pay.paypalCaptureId}/refund`, {
      headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", "paypal-request-id": `ext-${c.orderId}` },
      data: { amount: { value: "50.00", currency_code: "USD" }, note_to_payer: "Parcial desde PayPal" },
    }),
    fixtureAsync("refund", { paymentId: c.pay.id, reason: "total desde el panel" }),
  ]);
  expect(ext.status()).toBe(201);
  // Quien llegue segundo: o el panel reembolsa el resto, o PayPal rechaza el total (ya no alcanza) y el panel lo dice.
  if (!panel.ok) expect(panel.error).toMatch(/PayPal no procesó|supera|monto/i);
  const ppTotal = async () => (await paypalRefundsOf(request, c.pay.paypalCaptureId)).reduce((s, r) => s + Math.round(Number(r.amount.value) * 100), 0);
  await expect.poll(async () => one<{ refundedCents: number }>(`SELECT refundedCents FROM Payment WHERE id = ?`, c.pay.id).refundedCents).toBe(await ppTotal());
  const refunded = await ppTotal();
  const o = order(c.orderId);
  expect(o.amountPaidCents).toBe(c.pay.amountCents - refunded);
  if (refunded === c.pay.amountCents) {
    expect(o.status).toBe("REFUNDED");
    expect(reservationOf(c.orderId).status).toBe("RELEASED");
  } else {
    expect(o.status).toBe("ENROLLED");
  }
  expectCohortConsistent(C.cohortId);
});

test("reembolso de un pedido pagado con pago móvil → reembolso registrado (manual), cupo libre, desmatrícula y correo", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const d = checkout(C, uniqueEmail("adv-rfpm"));
  const ref = newRef("0119");
  await reportManual(page, d.token, { reference: ref, amountBs: bs(d.dueNowCents) });
  expect(await approveInPanel(browser, d.orderId, ref)).toMatch(/Pago aprobado/);
  await waitForOrderStatus(d.orderId, "ENROLLED");
  const pm = paymentRows(d.orderId)[0];
  const ppRefundsBefore = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown[] | Record<string, unknown> }).refunds;
  fixture("refund", { paymentId: pm.id, reason: "Devolución por pago móvil" });
  expect(q(`SELECT manual, status, amountCents FROM Refund WHERE paymentId = ?`, pm.id)).toEqual([{ manual: 1, status: "COMPLETED", amountCents: d.dueNowCents }]);
  const ppRefundsAfter = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown[] | Record<string, unknown> }).refunds;
  expect(Object.keys(ppRefundsAfter ?? {}).length).toBe(Object.keys(ppRefundsBefore ?? {}).length); // PayPal no se toca
  expect(order(d.orderId)).toMatchObject({ status: "REFUNDED", amountPaidCents: 0 });
  expect(reservationOf(d.orderId).status).toBe("RELEASED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  expect(await enrolmentsOf(request, d.orderId)).toEqual([]);
  expect(countOf(templates(d.orderId), "refund_issued")).toBe(1);
});
