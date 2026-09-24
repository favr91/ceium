// Pieza x2 — crítica adversarial independiente (QA). Ataques por HTTP contra el carril y los mocks que las
// specs x2-manual-payment / x2-manual-adversarial no cubren. Cada caso comprueba el resultado REAL: BD, estado
// del mock de Moodle, estado del mock de PayPal y bandeja de correos.
//   1. Moodle ejecuta la matrícula pero la respuesta se pierde (5xx tras ejecutar) al aprobar el pago móvil →
//      el pedido queda PAID con la matrícula «pendiente»; un reembolso total con «Desmatricular» debe quitarle
//      el acceso en Moodle igualmente (y el job no debe volver a matricularlo).
//   2. Webhooks fuera de orden y repetidos tras un reembolso PayPal (COMPLETED con otro event id, DENIED,
//      REFUNDED repetido, firma alterada) → nada cambia: ni pago, ni pedido, ni cupo, ni Moodle, ni correos.
//   3. Doble clic en «Reservar mi cupo» del checkout con pago móvil → un solo pedido y un solo cupo.
//   4. Dos médicos compran el ÚLTIMO cupo a la vez desde el checkout real → uno lo obtiene, el otro ve «sin
//      cupos»; el contador nunca supera la capacidad.
//   5. /pedido/<token> con un comprobante de 3 MB (foto de teléfono; se anuncian 10 MB) → debe registrarse.
//   6. /pedido/<token> con el monto escrito «33.705» (punto de miles, sin decimales) → Bs. 33.705,00.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, enrollments, events, fixture, moodleCalls, moodleState, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";

// Casos independientes (cada uno crea su cohorte): sin modo serial, un fallo no oculta los siguientes.
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2crit ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();
const templates = (orderId: string) => emails(orderId).map((e) => e.template);
const countOf = (xs: string[], x: string) => xs.filter((y) => y === x).length;

async function reportManual(page: Page, token: string, reference: string, amountBs: number) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(reference);
  await page.getByLabel(/Monto pagado/).fill(ves(amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  expect(new URL(page.url()).searchParams.get("pago"), new URL(page.url()).searchParams.get("motivo") ?? "").toBe("registrado");
}
async function approveInPanel(browser: Browser, orderId: string, ref: string) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`/admin/login?next=${encodeURIComponent(`/admin/orders/${orderId}`)}`);
    await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
    await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL((u) => u.pathname === `/admin/orders/${orderId}`);
    await page.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta/i }).last();
    await toast.waitFor({ timeout: 30_000 });
    return (await toast.textContent()) ?? "";
  } finally {
    await ctx.close();
  }
}
async function enrolledCourses(request: Parameters<typeof moodleState>[0], moodleUserId: number) {
  return (await moodleState(request)).enrolments.filter((e) => e.userid === moodleUserId).map((e) => e.courseid);
}
async function fillDoctor(page: Page, email: string) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill("María");
  await page.getByLabel("Apellidos").fill("Pérez Díaz");
  await page.getByLabel("Cédula de identidad").fill("V-15678901");
  await page.getByLabel("Ciudad (opcional)").fill("Barquisimeto");
  await page.getByLabel("Especialidad").selectOption("Medicina general");
}
const ordersOf = (email: string) => q<{ id: string; status: string }>(`SELECT o.id, o.status FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`, email);

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});
test.afterAll(() => {
  if (settingsBefore == null) return;
  try {
    fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
  } catch {
    /* valor previo no válido para updateSetting */
  }
});

// ───────────── 1. respuesta de Moodle perdida + reembolso ─────────────

test("Moodle matricula pero la respuesta se pierde al aprobar; reembolso total con «Desmatricular» → el médico pierde el acceso en Moodle", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("crit-lost"));
  const ref = newRef("0134");
  await reportManual(page, o.token, ref, bs(o.dueNowCents));

  // enrol_manual_enrol_users SE EJECUTA en Moodle y responde 503 (respuesta perdida), en cada intento inmediato.
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "http", status: 503, after: true, count: 3 } });
  expect(await approveInPanel(browser, o.orderId, ref)).toMatch(/Pago aprobado/);
  expect(order(o.orderId).status).toBe("PAID");
  const uid = customerOf(o.orderId).moodleUserId!;
  expect(uid).toBeGreaterThan(0);
  // Premisa: Moodle SÍ tiene la matrícula, aunque la app la vea pendiente.
  expect(await enrolledCourses(request, uid)).toEqual([C.moodleCourseId]);
  expect(enrollments(o.orderId).map((e) => e.status)).not.toContain("ENROLLED");

  const pay = one<{ id: string }>(`SELECT id FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.orderId);
  const r = fixture<{ fullyRefunded: boolean }>("refund", { paymentId: pay.id, reason: "No podrá asistir", unenroll: true, releaseSeat: true });
  expect(r.fullyRefunded).toBe(true);
  expect(order(o.orderId).status).toBe("REFUNDED");
  expect(reservationOf(o.orderId).status).toBe("RELEASED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });

  // El médico reembolsado NO debe conservar el curso en Moodle, ni ahora ni después del job.
  expect(await enrolledCourses(request, uid)).toEqual([]);
  await runCron(request, "enrollments");
  expect(await enrolledCourses(request, uid)).toEqual([]);
  expect(enrollments(o.orderId).map((e) => e.status)).not.toContain("ENROLLED");
  // (El correo de credenciales sí sale: la cuenta Moodle se creó en ese intento y su contraseña temporal no se guarda.)
  expect(countOf(templates(o.orderId), "refund_issued")).toBe(1);
});

// ───────────── 2. webhooks fuera de orden / repetidos ─────────────

test("tras un reembolso PayPal, webhooks COMPLETED/DENIED/REFUNDED repetidos o fuera de orden (y con firma alterada) no cambian nada", async ({ page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("crit-wh");
  const o = checkout(C, email, "PAYPAL");
  await page.goto(`/pedido/${o.token}`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const ppOrder = new URL(page.url()).searchParams.get("token")!;
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${ppOrder}?json=1`)).json();
  await request.get(a.redirect, { maxRedirects: 0 });
  await waitForOrderStatus(o.orderId, "ENROLLED");
  const pay = one<{ id: string; paypalCaptureId: string; amountCents: number }>(`SELECT id, paypalCaptureId, amountCents FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.orderId);
  const uid = customerOf(o.orderId).moodleUserId!;

  fixture("refund", { paymentId: pay.id, reason: "Reembolso", unenroll: true, releaseSeat: true });
  await waitForOrderStatus(o.orderId, "REFUNDED");
  await expect.poll(() => q(`SELECT id FROM Refund WHERE paymentId = ?`, pay.id).length).toBe(1);
  const snapshot = () => ({
    order: one(`SELECT status, amountPaidCents, balanceCents FROM "Order" WHERE id = ?`, o.orderId),
    payment: one(`SELECT status, refundedCents, amountUsdCents FROM Payment WHERE id = ?`, pay.id),
    refunds: q(`SELECT status, amountCents FROM Refund WHERE paymentId = ?`, pay.id),
    seat: reservationOf(o.orderId).status,
    cohort: cohort(C.cohortId),
    enrollments: enrollments(o.orderId),
    mails: templates(o.orderId),
  });
  await page.waitForTimeout(800); // deja llegar el webhook REFUNDED automático del mock
  const before = snapshot();
  expect(before.order).toMatchObject({ status: "REFUNDED", amountPaidCents: 0 });
  expect(before.seat).toBe("RELEASED");
  const since = Date.now(); // el mock guarda solo las últimas 200 llamadas: se compara por tiempo, no por cantidad

  const send = async (qs: string) => (await (await request.post(`${PAYPAL}/__mock/send-webhook/${pay.paypalCaptureId}${qs}`)).json()) as { status: number };
  // Firma alterada: rechazado y sin efecto.
  expect((await send("?event_type=PAYMENT.CAPTURE.COMPLETED&tamper=signature")).status).toBeGreaterThanOrEqual(400);
  expect((await send("?event_type=PAYMENT.CAPTURE.COMPLETED&tamper=body")).status).toBeGreaterThanOrEqual(400);
  // Fuera de orden / repetidos, firmados y con event id nuevo.
  for (const t of ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"]) {
    expect((await send(`?event_type=${t}`)).status, t).toBeLessThan(300);
  }
  await page.waitForTimeout(500);
  expect(snapshot()).toEqual(before);
  expect(await enrolledCourses(request, uid)).toEqual([]);
  expect((await moodleCalls(request)).filter((c) => c.at >= since && c.wsfunction === "enrol_manual_enrol_users")).toEqual([]);
  expect(countOf(events(o.orderId).map((e) => e.type), "PAYMENT_CAPTURED")).toBe(1);
});

// ───────────── 3. doble clic en el checkout ─────────────

test("doble clic en «Reservar mi cupo y ver datos de pago» → un solo pedido y un solo cupo", async ({ page }) => {
  const C = newCohort(3);
  const email = uniqueEmail("crit-dbl");
  await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=${C.sedeSlug}&cohort=${C.cohortId}&plan=FULL`);
  await page.goto("/checkout");
  await fillDoctor(page, email);
  await page.getByText("Pago Móvil", { exact: true }).click();
  await page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).dblclick();
  await page.waitForURL(/\/checkout\?pedido=creado$/);
  await page.waitForTimeout(1500);
  expect(ordersOf(email)).toHaveLength(1);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 1, seatsConfirmed: 0 });
});

// ───────────── 4. compradores concurrentes por el último cupo ─────────────

test("dos médicos confirman a la vez el último cupo desde el checkout real → uno lo obtiene, el otro ve que no hay cupo", async ({ browser }) => {
  const C = newCohort(1);
  const emailsAB = [uniqueEmail("crit-a"), uniqueEmail("crit-b")];
  const ctxs = await Promise.all([browser.newContext({ locale: "es-VE" }), browser.newContext({ locale: "es-VE" })]);
  try {
    const pages = await Promise.all(ctxs.map((c) => c.newPage()));
    for (const [i, p] of pages.entries()) {
      await p.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=${C.sedeSlug}&cohort=${C.cohortId}&plan=FULL`);
      await p.goto("/checkout");
      await fillDoctor(p, emailsAB[i]);
      await p.getByText("Pago Móvil", { exact: true }).click();
    }
    await Promise.all(pages.map((p) => p.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click()));
    await Promise.all(pages.map((p) => p.waitForLoadState("networkidle")));
    await pages[0].waitForTimeout(1500);
    const placed = emailsAB.map((e) => ordersOf(e).filter((o) => o.status === "PENDING_PAYMENT").length);
    expect(placed.reduce((a, b) => a + b, 0)).toBe(1);
    const loser = pages[placed.indexOf(0)];
    await expect(loser.getByRole("alert").filter({ hasText: /no (tiene|quedan) cupos/i }).first()).toBeVisible();
  } finally {
    await Promise.all(ctxs.map((c) => c.close()));
  }
  expect(cohort(C.cohortId)).toEqual({ capacity: 1, seatsHeld: 1, seatsConfirmed: 0 });
});

// ───────────── 5–6. comprobante real de teléfono y monto con formato venezolano en /pedido ─────────────

test("/pedido acepta un comprobante de 3 MB (foto de teléfono; el límite anunciado es 10 MB)", async ({ page }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("crit-big"));
  const ref = newRef("0120");
  await page.goto(`/pedido/${o.token}`);
  await page.getByLabel("Número de referencia").fill(ref);
  await page.getByLabel(/Monto pagado/).fill(ves(bs(o.dueNowCents)));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  const big = Buffer.concat([proofPng(), Buffer.from(Array.from({ length: 3 * 1024 * 1024 }, (_, i) => (i * 2654435761) & 0xff))]);
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "IMG_20260924_101500.png", mimeType: "image/png", buffer: big });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/, { timeout: 20_000 });
  expect(new URL(page.url()).searchParams.get("pago"), new URL(page.url()).searchParams.get("motivo") ?? "").toBe("registrado");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  const p = one<{ proofFile: string }>(`SELECT proofFile FROM Payment WHERE orderId = ?`, o.orderId);
  expect(fs.statSync(path.resolve(__dirname, "../..", p.proofFile)).size).toBe(big.length);
});

test("/pedido: monto escrito con punto de miles y sin decimales («65.537») se registra como Bs. 65.537,00, no como Bs. 65,54", async ({ page }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("crit-amt"));
  const ref = newRef("0121");
  const wholeBs = Math.round(bs(o.dueNowCents) / 100); // bolívares enteros
  const typed = wholeBs.toLocaleString("es-VE", { maximumFractionDigits: 0 }); // p. ej. «65.537»
  expect(typed).toMatch(/^\d{1,3}(\.\d{3})+$/);
  await page.goto(`/pedido/${o.token}`);
  await page.getByLabel("Número de referencia").fill(ref);
  await page.getByLabel(/Monto pagado/).fill(typed);
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  expect(new URL(page.url()).searchParams.get("pago")).toBe("registrado");
  expect(one<{ amountCents: number }>(`SELECT amountCents FROM Payment WHERE orderId = ?`, o.orderId).amountCents).toBe(wholeBs * 100);
});
