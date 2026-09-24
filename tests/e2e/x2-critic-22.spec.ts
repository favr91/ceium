// x2 critic 22 — por HTTP contra la app y los mocks: carrera entre la desmatrícula de un reembolso y la recompra.
//   El médico pagó el curso con PayPal (pedido A, inscrito) y ya registró el pago móvil de una recompra del MISMO
//   curso en otra cohorte (pedido B). El admin reembolsa A con «Desmatricular» y Moodle tarda en desmatricular
//   (10 s, respuesta correcta). MIENTRAS tanto, otro admin aprueba el pago móvil de B → B toma la fila de matrícula
//   del pedido reembolsado y matricula en Moodle; después Moodle ejecuta la desmatrícula de A.
//   Antes: la fila de B quedaba UNENROLLED (unenrollOrder la pisaba sin mirar de quién era) y Moodle sin el curso,
//   aunque B estaba «Inscrito» y el médico había recibido «ya tienes acceso».
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-22.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, callsFor, cohort, order, customerOf, emails, enrollments, events, fixture, moodleCalls, moodleState, one, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c22 ${Date.now().toString(36)}` });
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

test("reembolso con «Desmatricular» y Moodle lento; mientras desmatricula, el admin aprueba el pago móvil de la recompra del mismo curso → el médico queda matriculado en Moodle y en la app", async ({ browser, page, request }) => {
  const C1 = newCohort(3);
  const C2 = newCohort(3);
  const email = uniqueEmail("x2c22race");

  // Pedido A (cohorte 1) con PayPal → inscrito.
  const a = checkout(C1, email, "PAYPAL");
  await payPaypal(page, a.token);
  await waitForOrderStatus(a.orderId, "ENROLLED", 45_000);
  const uid = customerOf(a.orderId).moodleUserId;
  expect(await moodleCoursesOf(request, uid)).toEqual([C1.moodleCourseId]);

  // Recompra del mismo curso (cohorte 2) con pago móvil: comprobante registrado, en verificación.
  const b = checkout(C2, email, "PAGO_MOVIL");
  const ref = newRef("0134");
  const r = await payManual(page, b.token, { reference: ref, amountBs: bs(b.dueNowCents) });
  expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
  await waitForOrderStatus(b.orderId, "AWAITING_VERIFICATION", 15_000);
  expect(reservationOf(b.orderId).status).toBe("HELD");

  const s1 = await adminLogin(browser);
  const s2 = await adminLogin(browser);
  try {
    // Moodle tardará 10 s en la próxima desmatrícula (y luego la ejecuta y responde bien).
    const q1 = await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_unenrol_users", type: "ok", delayMs: 10_000, count: 1 } });
    expect(q1.ok()).toBe(true);
    const unenrolCalls = async () => callsFor(await moodleCalls(request), uid, email).filter((c) => c.wsfunction === "enrol_manual_unenrol_users").length;
    const before = await unenrolCalls();

    // Admin 1: reembolso de A con «Desmatricular» (la acción queda esperando a Moodle).
    await s1.page.goto(`/admin/orders/${a.orderId}`);
    const card = s1.page.getByTestId("payment").filter({ hasText: "PayPal" });
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await form.getByLabel("Motivo").fill("Cambio a la cohorte siguiente.");
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await expect.poll(unenrolCalls, { timeout: 15_000, message: "la desmatrícula de A llegó a Moodle" }).toBe(before + 1);
    expect(order(a.orderId).status).toBe("REFUNDED");

    // Admin 2, mientras Moodle desmatricula: abre B, ve el comprobante y aprueba.
    await s2.page.goto(`/admin/orders/${b.orderId}`);
    const pm = s2.page.getByTestId("payment").filter({ hasText: ref });
    const img = pm.getByTestId("proof").getByRole("img", { name: /Comprobante/ });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    await pm.getByRole("button", { name: "Aprobar pago" }).click();
    await expect(s2.page.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible({ timeout: 30_000 });
    await waitForOrderStatus(b.orderId, "ENROLLED", 10_000);
    // La aprobación terminó ANTES de que Moodle ejecutara la desmatrícula de A (la carrera ocurrió de verdad).
    expect(events(a.orderId, "UNENROLLMENT")).toHaveLength(0);

    // Termina el reembolso de A.
    await expect.poll(() => events(a.orderId, "UNENROLLMENT").length, { timeout: 30_000 }).toBe(1);
    expect(reservationOf(a.orderId).status).toBe("RELEASED");
    expect(reservationOf(b.orderId).status).toBe("CONFIRMED");
    expect(emails(b.orderId).map((m) => m.template)).toEqual(expect.arrayContaining(["payment_approved", "platform_access"]));

    // B pagó y se le dijo «ya tienes acceso»: matriculado en la app y en Moodle, y queda constancia.
    expect(enrollments(b.orderId)).toEqual([{ moodleCourseId: C2.moodleCourseId, status: "ENROLLED" }]);
    expect(one<{ orderId: string }>(`SELECT orderId FROM Enrollment WHERE customerId = ? AND moodleCourseId = ?`, customerOf(b.orderId).id, C2.moodleCourseId).orderId).toBe(b.orderId);
    expect(await moodleCoursesOf(request, uid), "B inscrito y sin curso en Moodle").toEqual([C2.moodleCourseId]);
    expect(events(b.orderId, "ENROLLMENT").some((e) => /reafirmada/.test(e.note ?? ""))).toBe(true);

    // Los jobs no cambian nada.
    await runCron(request, "enrollments");
    await runCron(request, "enrollments");
    expect(enrollments(b.orderId)).toEqual([{ moodleCourseId: C2.moodleCourseId, status: "ENROLLED" }]);
    expect(await moodleCoursesOf(request, uid)).toEqual([C2.moodleCourseId]);
    expectCohortConsistent(C1.cohortId);
    expectCohortConsistent(C2.cohortId);
  } finally {
    await s1.ctx.close();
    await s2.ctx.close();
  }
});
