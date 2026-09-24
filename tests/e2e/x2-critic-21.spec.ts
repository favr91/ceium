// x2 critic 21 — por HTTP contra la app y los mocks:
//   1. Cambio de cohorte «a mano» (reembolso + nueva compra del MISMO curso): el reembolso PayPal con «Desmatricular»
//      llega a Moodle, que DESMATRICULA pero la respuesta se pierde (HTML con HTTP 200). La fila de matrícula sigue
//      «ENROLLED» (la app no supo que se hizo) y el job debe repetirla. Antes de que corra, el médico compra de nuevo
//      el curso con pago móvil y el admin aprueba → la app debe MATRICULARLO de verdad en Moodle (pagó y se le dice
//      «ya tienes acceso»), y el job de desmatrículas del pedido reembolsado no debe quitárselo después.
//   2. Webhooks fuera de orden en un pedido PayPal inscrito (PENDING y DENIED después de COMPLETED, reentrega exacta
//      y firma falsa) y cuatro corridas del job a la vez → nada cambia: pago, cupo, Moodle, correos.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-21.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, enrollments, events, fixture, moodleState, one, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c21 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();

async function payManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
  await page.goto(`/pedido/${token}`);
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
async function payPaypal(page: Page, token: string): Promise<string> {
  await page.goto(`/pedido/${token}`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const pp = new URL(page.url()).searchParams.get("token")!;
  await page.getByTestId("pp-approve").click();
  await page.waitForURL((u) => u.pathname.startsWith("/pedido/") && !u.pathname.includes("/paypal/"), { timeout: 60_000 });
  return pp;
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
async function moodleCoursesOf(request: APIRequestContext, userId: number | null) {
  return (await moodleState(request)).enrolments.filter((e) => e.userid === userId && e.status === 0).map((e) => e.courseid);
}
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  const held = one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
  const confirmed = one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held, confirmed });
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
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

test("reembolso con «Desmatricular» cuya respuesta de Moodle se pierde; el médico vuelve a comprar el curso con pago móvil y el admin aprueba → queda matriculado de verdad en Moodle", async ({ browser, page, request }) => {
  const C1 = newCohort(3);
  const C2 = newCohort(3);
  const email = uniqueEmail("x2c21swap");

  // Pedido A (cohorte 1) pagado con PayPal → inscrito.
  const a = checkout(C1, email, "PAYPAL");
  await payPaypal(page, a.token);
  await waitForOrderStatus(a.orderId, "ENROLLED", 45_000);
  const uid = customerOf(a.orderId).moodleUserId;
  expect(await moodleCoursesOf(request, uid)).toEqual([C1.moodleCourseId]);

  // Reembolso de A desde el panel con «Desmatricular»: Moodle desmatricula, pero responde HTML (respuesta perdida).
  const q1 = await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_unenrol_users", after: true, type: "garbage", count: 1 } });
  expect(q1.ok()).toBe(true);
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${a.orderId}`);
    const card = admin.getByTestId("payment").filter({ hasText: "PayPal" });
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await form.getByLabel("Motivo").fill("Cambio a la cohorte siguiente.");
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await waitForOrderStatus(a.orderId, "REFUNDED", 30_000);
    expect(reservationOf(a.orderId).status).toBe("RELEASED");
    // Moodle sí lo desmatriculó (la app no lo sabe: hay un reintento pendiente).
    await expect.poll(() => events(a.orderId, "UNENROLLMENT_FAILED").length, { timeout: 15_000 }).toBe(1);
    expect(await moodleCoursesOf(request, uid)).toEqual([]);
    expect(enrollments(a.orderId)).toEqual([{ moodleCourseId: C1.moodleCourseId, status: "ENROLLED" }]); // la app no lo sabe

    // Antes de que corra el job, el médico compra de nuevo el mismo curso (cohorte 2) con pago móvil.
    const b = checkout(C2, email, "PAGO_MOVIL");
    const ref = newRef("0134");
    const r = await payManual(page, b.token, { reference: ref, amountBs: bs(b.dueNowCents) });
    expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
    await admin.goto(`/admin/orders/${b.orderId}`);
    await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible({ timeout: 60_000 });
    await waitForOrderStatus(b.orderId, "ENROLLED", 45_000);
    expect(reservationOf(b.orderId).status).toBe("CONFIRMED");
    // Se le dice que ya tiene acceso…
    expect(emails(b.orderId).map((m) => m.template)).toEqual(expect.arrayContaining(["payment_approved", "platform_access"]));
    // …y el job de desmatrículas del pedido reembolsado corre después.
    await runCron(request, "enrollments");
    await runCron(request, "enrollments");

    // Pagó el curso: tiene que estar matriculado en Moodle (y la app debe saberlo).
    expect(enrollments(b.orderId)).toEqual([{ moodleCourseId: C2.moodleCourseId, status: "ENROLLED" }]);
    expect(await moodleCoursesOf(request, uid), "el médico pagó el pedido B, la app dice «ya tienes acceso» y Moodle no lo tiene matriculado").toEqual([C2.moodleCourseId]);
    expectCohortConsistent(C1.cohortId);
    expectCohortConsistent(C2.cohortId);
  } finally {
    await ctx.close();
  }
});

test("pedido PayPal inscrito: PENDING/DENIED después de COMPLETED, reentrega exacta, firma falsa y cuatro corridas del job a la vez → nada cambia", async ({ page, request }) => {
  const C = newCohort(2);
  const email = uniqueEmail("x2c21ooo");
  const o = checkout(C, email, "PAYPAL");
  const pp = await payPaypal(page, o.token);
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  const [pay] = q<{ id: string; paypalCaptureId: string }>(`SELECT id, paypalCaptureId FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.orderId);
  const snap = async () => ({
    order: one(`SELECT status, amountPaidCents, balanceCents FROM "Order" WHERE id = ?`, o.orderId),
    payments: q(`SELECT status, providerStatus, amountUsdCents, refundedCents FROM Payment WHERE orderId = ? ORDER BY createdAt`, o.orderId),
    seat: reservationOf(o.orderId).status,
    cohort: cohort(C.cohortId),
    emails: emails(o.orderId).map((m) => m.template).sort(),
    enr: enrollments(o.orderId),
    moodle: await moodleCoursesOf(request, customerOf(o.orderId).moodleUserId),
  });
  const before = await snap();
  expect(before.moodle).toEqual([C.moodleCourseId]);

  const sent: { status: number; event: { id: string }; headers: Record<string, string> }[] = [];
  for (const t of ["PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.COMPLETED"]) {
    const r = await request.post(`${PAYPAL}/__mock/send-webhook/${pay.paypalCaptureId}?event_type=${t}`);
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body.status, JSON.stringify(body)).toBe(200);
    sent.push(body);
  }
  // Reentrega exacta del DENIED (mismo event id) y uno con firma alterada.
  const replay = await request.post(`/api/webhooks/paypal`, { headers: sent[1].headers, data: JSON.stringify(sent[1].event) });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).duplicate).toBe(true);
  const forged = await request.post(`/api/webhooks/paypal`, { headers: { ...sent[1].headers, "paypal-transmission-sig": "Zm9yZ2Vk" }, data: JSON.stringify({ ...sent[1].event, id: `WH-forged-${Date.now()}` }) });
  expect(forged.status()).toBe(400);
  // Cuatro corridas del job completo a la vez.
  const runs = await Promise.all([0, 1, 2, 3].map(() => request.post(`/api/cron`, { headers: { authorization: `Bearer ${parseDotenv(fs.readFileSync(path.join(__dirname, "../../.env"))).CRON_SECRET}` } })));
  for (const r of runs) expect(r.status()).toBe(200);

  expect(await snap()).toEqual(before);
  expect(q(`SELECT id FROM Payment WHERE paypalOrderId = ?`, pp)).toHaveLength(1);
  expectCohortConsistent(C.cohortId);
});
