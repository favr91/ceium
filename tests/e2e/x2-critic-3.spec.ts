// x2 critic 3 — sondas adversariales nuevas contra el flujo pago móvil → verificación → Moodle → cupo → correos
// y el reembolso PayPal, por HTTP contra el carril (app + mocks). Cada sonda comprueba el resultado REAL en la
// BD, el mock de Moodle, el mock de PayPal y la bandeja de correos.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-3.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { PAYPAL, cohort, customerOf, emails, fixture, fixtureAsync, moodleState, one, order, q, reservationOf, paypalConfig, resendCaptureWebhook, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { e2eEnv } from "../../playwright.config";

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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c3 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();

async function fillManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(opts.reference);
  await page.getByLabel(/Monto pagado/).fill(ves(opts.amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
}
async function submitManual(page: Page) {
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  return new URL(page.url()).searchParams;
}
async function reportManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(opts.reference);
  await page.getByLabel(/Monto pagado/).fill(ves(opts.amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(new Date().toISOString().slice(0, 10));
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
async function approveAndReturn(request: APIRequestContext, paypalOrderId: string): Promise<string | null> {
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${paypalOrderId}?json=1`)).json();
  const r = await request.get(a.redirect, { maxRedirects: 0 });
  return new URL(r.headers()["location"] ?? "/", e2eEnv.APP_URL).searchParams.get("paypal");
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
const liveHeld = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
const liveConfirmed = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: liveHeld(cohortId), confirmed: liveConfirmed(cohortId) });
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
}
const paymentRows = (orderId: string) =>
  q<{ id: string; method: string; status: string; amountUsdCents: number; refundedCents: number; paypalCaptureId: string | null; reference: string | null }>(
    `SELECT id, method, status, amountUsdCents, refundedCents, paypalCaptureId, reference FROM Payment WHERE orderId = ? ORDER BY createdAt`,
    orderId,
  );

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});
test.afterAll(() => {
  if (settingsBefore == null) return;
  try {
    fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
  } catch {
    /* valor previo no válido: se queda el de esta corrida */
  }
});

// ───────────── 1. pago doble: PayPal y pago móvil sobre el mismo pedido ─────────────

test("PayPal aprobado en otra pestaña mientras el pago móvil del mismo pedido está en verificación → NO se captura (no se cobra dos veces); el admin aprueba el pago móvil", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("c3dbl");
  const o = checkout(C, email);
  // Pestaña 1: el médico abre PayPal (sin aprobar aún).
  const ctxPP = await browser.newContext({ locale: "es-VE" });
  let pp: string;
  const ref = newRef("0134");
  try {
    pp = await startPaypal(await ctxPP.newPage(), o.token);
    // Pestaña 2: registra el pago móvil con comprobante → en verificación.
    const r = await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
    expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
    expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
    // Vuelve a la pestaña 1 y aprueba PayPal: la app no captura.
    expect(await approveAndReturn(request, pp)).toBe("fallido");
  } finally {
    await ctxPP.close();
  }
  // PayPal no cobró: la orden sigue APPROVED (sin captura) en el mock.
  const ppState = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { orders: { id: string; status: string }[] };
  expect(ppState.orders.find((x) => x.id === pp)?.status).toBe("APPROVED");
  const pays = paymentRows(o.orderId);
  expect(pays.find((p) => p.method === "PAYPAL")).toMatchObject({ status: "CANCELLED", paypalCaptureId: null });
  expect(pays.find((p) => p.method === "PAGO_MOVIL")?.status).toBe("AWAITING_VERIFICATION");
  expect(order(o.orderId)).toMatchObject({ status: "AWAITING_VERIFICATION", amountPaidCents: 0 });
  expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND type = 'PAYMENT_NOT_CAPTURED'`, o.orderId)).toHaveLength(1);
  // El job de conciliación no la captura después.
  await runCron(request, "paypal");
  expect(paymentRows(o.orderId).filter((p) => p.status === "COMPLETED")).toHaveLength(0);
  expect(reservationOf(o.orderId).status).toBe("HELD");

  // El admin aprueba el pago móvil → inscrito, un solo pago imputado.
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto("/admin/orders?view=AWAITING_VERIFICATION");
    await admin.getByRole("link", { name: `#${o.number}`, exact: true }).click();
    await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.totalCents, balanceCents: 0 });
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  expectCohortConsistent(C.cohortId);
});

test("PayPal cobrado por su lado (captura + webhook) mientras el pago móvil está en verificación → aviso de pago doble y el comprobante sigue en la cola «Por verificar»; rechazarlo no toca el cupo", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("c3dbl2");
  const o = checkout(C, email);
  const ctxPP = await browser.newContext({ locale: "es-VE" });
  const ref = newRef("0105");
  await paypalConfig(request, { approvalWebhooks: false, autoWebhooks: true, webhookDelayMs: 50 });
  try {
    const pp = await startPaypal(await ctxPP.newPage(), o.token);
    const r = await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
    expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
    // PayPal captura por su lado (p.ej. el retorno ya estaba en curso) y avisa por webhook.
    await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`);
    const tok = (await (await request.post(`${PAYPAL}/v1/oauth2/token`, {
      headers: { authorization: `Basic ${Buffer.from(`${e2eEnv.PAYPAL_CLIENT_ID}:${e2eEnv.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      data: "grant_type=client_credentials",
    })).json()).access_token;
    const cap = await request.post(`${PAYPAL}/v2/checkout/orders/${pp}/capture`, { headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, data: "{}" });
    expect(cap.ok()).toBe(true);
  } finally {
    await ctxPP.close();
    await paypalConfig(request, { approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", autoWebhooks: true, webhookDelayMs: 50 });
  }
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  expect(paymentRows(o.orderId).find((p) => p.method === "PAGO_MOVIL")?.status).toBe("AWAITING_VERIFICATION");
  const attention = q<{ note: string }>(`SELECT note FROM OrderEvent WHERE orderId = ? AND type = 'ATTENTION'`, o.orderId).map((e) => e.note);
  expect(attention.some((n) => n.includes("otro pago por verificar") && n.includes(ref))).toBe(true);

  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto("/admin/orders?view=AWAITING_VERIFICATION");
    await admin.getByRole("link", { name: `#${o.number}`, exact: true }).click();
    const cardEl = admin.getByTestId("payment").filter({ hasText: ref });
    await cardEl.getByRole("button", { name: "Rechazar pago" }).click();
    await cardEl.getByRole("form", { name: "Rechazar pago" }).getByLabel("Motivo del rechazo").fill("El pedido ya se pagó con PayPal; no recibimos este pago móvil.");
    await cardEl.getByRole("button", { name: "Rechazar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago rechazado" })).toBeVisible();
  } finally {
    await ctx.close();
  }
  expect(order(o.orderId).status).toBe("ENROLLED");
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  const uid = customerOf(o.orderId).moodleUserId!;
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  expectCohortConsistent(C.cohortId);
});

// ───────────── 2. tormenta de retornos y webhooks sobre la misma captura ─────────────

test("retornos de PayPal y webhooks COMPLETED/APPROVED repetidos, todos a la vez → un pago, un cupo, una matrícula, un correo", async ({ browser, request }) => {
  const C = newCohort(2);
  const email = uniqueEmail("c3storm");
  const o = checkout(C, email, "PAYPAL");
  const ctx = await browser.newContext({ locale: "es-VE" });
  let pp: string;
  try {
    pp = await startPaypal(await ctx.newPage(), o.token);
  } finally {
    await ctx.close();
  }
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`)).json();
  const returns = Array.from({ length: 4 }, () => request.get(a.redirect, { maxRedirects: 0 }).then((r) => r.status()));
  const statuses = await Promise.all(returns);
  expect(statuses.every((s) => s === 303)).toBe(true);
  const [pay] = paymentRows(o.orderId).filter((p) => p.status === "COMPLETED");
  expect(pay?.paypalCaptureId).toBeTruthy();
  const storm = await Promise.all(Array.from({ length: 6 }, () => resendCaptureWebhook(request, pay.paypalCaptureId!)));
  expect(storm.every((s) => s.status === 200)).toBe(true);
  // Reentrega exacta concurrente del mismo evento.
  const ev = storm[0];
  await Promise.all(Array.from({ length: 4 }, () => request.post(`${e2eEnv.APP_URL}/api/webhooks/paypal`, { headers: ev.headers, data: JSON.stringify(ev.event) })));

  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  expect(paymentRows(o.orderId).filter((p) => p.status === "COMPLETED")).toHaveLength(1);
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.totalCents, balanceCents: 0 });
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 1 });
  const st = await moodleState(request);
  const uid = customerOf(o.orderId).moodleUserId!;
  expect(st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase())).toHaveLength(1);
  expect(st.enrolments.filter((e) => e.userid === uid).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  const mail = emails(o.orderId).map((m) => m.template);
  for (const t of ["order_confirmation", "platform_access", "cohort_details"]) expect(mail.filter((x) => x === t), t).toHaveLength(1);
  expect(q(`SELECT id FROM Refund r WHERE r.paymentId IN (SELECT id FROM Payment WHERE orderId = ?)`, o.orderId)).toHaveLength(0);
});

// ───────────── 3. vencimiento y comprobante a la vez ─────────────

test("el job de vencimientos y el comprobante llegan a la vez sobre reservas vencidas → nunca un pedido «en verificación» sin cupo ni contadores descuadrados", async ({ browser, request }) => {
  const C = newCohort(3);
  const placed = [0, 1, 2].map((i) => checkout(C, uniqueEmail(`c3exp${i}`)));
  const pages = await Promise.all(placed.map(async () => (await browser.newContext({ locale: "es-VE" })).newPage()));
  try {
    // Pestañas abiertas y formularios llenos ANTES del vencimiento; luego pasa el plazo (73 h).
    for (const [i, p] of placed.entries()) await fillManual(pages[i], p.token, { reference: newRef(`01${i}4`), amountBs: bs(p.dueNowCents) });
    for (const p of placed) fixture("age-order", { orderId: p.orderId, minutes: 73 * 60 });
    const results = await Promise.all([
      ...placed.map((_, i) => submitManual(pages[i]).then((r) => r.get("pago"))),
      runCron(request, "expire"),
      runCron(request, "expire"),
    ]);
    const outcomes = results.slice(0, 3);
    for (const [i, p] of placed.entries()) {
      const st = order(p.orderId).status;
      const seat = reservationOf(p.orderId).status;
      if (outcomes[i] === "registrado") {
        expect(st, `pedido ${i}`).toBe("AWAITING_VERIFICATION");
        expect(seat, `cupo ${i}`).toBe("HELD");
      } else {
        expect(paymentRows(p.orderId), `pedido ${i} sin pago`).toHaveLength(0);
      }
    }
    // Un comprador nuevo llega después: solo puede tomar lo que de verdad quedó libre.
    await runCron(request, "expire");
    expectCohortConsistent(C.cohortId);
    const awaiting = placed.filter((p) => order(p.orderId).status === "AWAITING_VERIFICATION").length;
    const late = await fixtureAsync("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email: uniqueEmail("c3late"), paymentMethod: "PAGO_MOVIL" });
    expect(late.ok).toBe(awaiting < 3);
    expectCohortConsistent(C.cohortId);
  } finally {
    for (const p of pages) await p.context().close();
  }
});

// ───────────── 4. reembolsos concurrentes con claves distintas + webhook ─────────────

test("cuatro reembolsos totales a la vez (claves distintas) y el webhook REFUNDED repetido → PayPal reembolsa una vez, cupo liberado una vez", async ({ browser, request }) => {
  const C = newCohort(2);
  const email = uniqueEmail("c3rfd");
  const o = checkout(C, email, "PAYPAL");
  const ctx = await browser.newContext({ locale: "es-VE" });
  try {
    const pp = await startPaypal(await ctx.newPage(), o.token);
    expect(await approveAndReturn(request, pp)).toBe("completado");
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  const [pay] = paymentRows(o.orderId).filter((p) => p.status === "COMPLETED");
  const before = (((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown[] }).refunds ?? []).length;
  const runs = await Promise.all(
    [0, 1, 2, 3].map((i) => fixtureAsync<{ refundId: string; status: string }>("refund", { paymentId: pay.id, reason: `c3 ${i}`, unenroll: true, releaseSeat: true, idempotencyKey: `c3-${pay.id}-${i}` })),
  );
  expect(runs.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
  await Promise.all(Array.from({ length: 3 }, () => request.post(`${PAYPAL}/__mock/send-webhook/${pay.paypalCaptureId}?event_type=PAYMENT.CAPTURE.REFUNDED`)));
  await waitForOrderStatus(o.orderId, "REFUNDED");
  const after = (((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: { _captureId?: string; amount: { value: string } }[] }).refunds ?? []).slice(before);
  const mine = after.filter((r) => JSON.stringify(r).includes(pay.paypalCaptureId!));
  expect(mine, "un solo reembolso en PayPal").toHaveLength(1);
  const rows = q<{ status: string; amountCents: number }>(`SELECT status, amountCents FROM Refund WHERE paymentId = ?`, pay.id);
  expect(rows.filter((r) => r.status === "COMPLETED")).toEqual([{ status: "COMPLETED", amountCents: pay.amountUsdCents }]);
  expect(one<{ refundedCents: number; status: string }>(`SELECT refundedCents, status FROM Payment WHERE id = ?`, pay.id)).toEqual({ refundedCents: pay.amountUsdCents, status: "REFUNDED" });
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: 0, balanceCents: 0 });
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 0 });
  expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND type = 'SEAT_RELEASED'`, o.orderId)).toHaveLength(1);
  expect(emails(o.orderId).filter((m) => m.template === "refund_issued")).toHaveLength(1);
  const uid = customerOf(o.orderId).moodleUserId!;
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === uid)).toEqual([]);
});

// ───────────── 5. Moodle sin respuesta (timeout) al aprobar ─────────────

test("Moodle no responde (timeout) al matricular tras aprobar → pagado y cupo ocupado; el job matricula una sola vez", async ({ browser, page, request }) => {
  const C = newCohort(2);
  const email = uniqueEmail("c3tmo");
  const o = checkout(C, email);
  const ref = newRef("0172");
  const r = await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
  fixture("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } });
  await request.post(`${e2eEnv.MOODLE_URL}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "timeout", after: true, delayMs: 20_000 } });
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    const t0 = Date.now();
    await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").or(admin.getByRole("alert")).filter({ hasText: /pago/i }).last()).toBeVisible({ timeout: 60_000 });
    test.info().annotations.push({ type: "approve-ms", description: String(Date.now() - t0) });
  } finally {
    await ctx.close();
  }
  expect(["PAID", "ENROLLED"]).toContain(order(o.orderId).status);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  await expect
    .poll(
      async () => {
        await runCron(request, "enrollments");
        return order(o.orderId).status;
      },
      { timeout: 90_000, intervals: [6_000] },
    )
    .toBe("ENROLLED");
  const uid = customerOf(o.orderId).moodleUserId!;
  const st = await moodleState(request);
  expect(st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase())).toHaveLength(1);
  expect(st.enrolments.filter((e) => e.userid === uid).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  const mail = emails(o.orderId).map((m) => m.template);
  expect(mail.filter((x) => x === "payment_approved")).toHaveLength(1);
  expect(mail.filter((x) => x === "cohort_details")).toHaveLength(1);
  expectCohortConsistent(C.cohortId);
});
