// x2 critic 8 — sondas adversariales nuevas contra pago móvil → verificación → Moodle → cupo → correos y el
// reembolso PayPal, por HTTP contra el carril (app + mocks). Cada sonda comprueba el resultado REAL: BD, estado
// del mock de Moodle / PayPal y bandeja de correos.
//   1. Reembolso PARCIAL de cortesía desde el panel (sin retiro) en un pedido pagado completo → lo devuelto no se
//      puede convertir en deuda: nada de «Cuota vencida — paga 10 USD» al médico (ajuste de saldo auditado).
//   2. Moodle rechaza la matrícula con un error definitivo al aprobar → FAILED + aviso; rematricular → una vez.
//   3. El reembolso ya se hizo en el panel de PayPal (webhook demorado) y el admin reembolsa desde el panel →
//      CAPTURE_FULLY_REFUNDED visible, nada cambia; al llegar el webhook: reembolsado, cupo libre, sin Moodle.
//   4. Reembolso PARCIAL hecho desde PayPal (webhook) en un pedido pagado completo → sin cobro de lo devuelto.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-8.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, events, fixture, moodleState, one, order, paypalConfig, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { todayCaracas } from "./support/dates";

test.describe.configure({ mode: "default" });
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c8 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();
const templates = (orderId: string) => emails(orderId).map((e) => e.template);

async function reportManual(page: Page, token: string, reference: string, amountBs: number) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(reference);
  await page.getByLabel(/Monto pagado/).fill(ves(amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  return new URL(page.url()).searchParams;
}
async function adminLogin(browser: Browser, next: string) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next);
  return { ctx, page };
}
async function toastText(page: Page) {
  const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta|reembols|moodle|matr/i }).last();
  await toast.waitFor({ timeout: 30_000 });
  return (await toast.textContent()) ?? "";
}
const paymentRows = (orderId: string) =>
  q<{ id: string; status: string; amountUsdCents: number; refundedCents: number; reference: string; paypalCaptureId: string | null; method: string }>(
    `SELECT id, status, amountUsdCents, refundedCents, reference, paypalCaptureId, method FROM Payment WHERE orderId = ? ORDER BY createdAt`,
    orderId,
  );
const enrollmentRows = (orderId: string) =>
  q<{ moodleCourseId: number; status: string }>(`SELECT e.moodleCourseId, e.status FROM Enrollment e JOIN "Order" o ON o.customerId = e.customerId WHERE o.id = ?`, orderId);
async function enrolledIn(request: Parameters<typeof moodleState>[0], uid: number | null) {
  if (uid == null) return [];
  return (await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid);
}

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});
test.afterAll(() => {
  if (settingsBefore == null) return;
  try {
    fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
  } catch {
    /* valor previo no válido */
  }
});

// ───────────── 1. reembolso parcial de cortesía ─────────────

test("reembolso PARCIAL de cortesía (opciones por defecto: no desmatricula, no libera) → al médico no se le cobra lo devuelto", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("x2c8court"));
  const ref = newRef("0134");
  expect((await reportManual(page, o.token, ref, bs(o.dueNowCents))).get("pago")).toBe("registrado");
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    await admin.getByTestId("payment").getByRole("button", { name: "Aprobar pago" }).click();
    await waitForOrderStatus(o.orderId, "ENROLLED");
    await admin.reload();
    const card = admin.getByTestId("payment").first();
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await form.getByRole("textbox", { name: /Monto a reembolsar/ }).fill("10.00");
    await form.getByLabel("Motivo").fill("Cortesía: descuento de colegio médico aplicado después del pago.");
    // Parcial: el panel deja desmarcadas «Desmatricular» y «Liberar el cupo» (el médico sigue inscrito).
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).not.toBeChecked();
    await expect(form.getByRole("checkbox", { name: /Liberar el cupo/ })).not.toBeChecked();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await expect(admin.getByRole("status").filter({ hasText: /Reembolso/ })).toBeVisible();
  } finally {
    await ctx.close();
  }
  // El job de cuotas corre (recordatorios / vencidas) varias veces.
  await runCron(request, "installments");
  await runCron(request, "installments");
  const ord = one<{ status: string; balanceCents: number; amountPaidCents: number; totalCents: number }>(`SELECT status, balanceCents, amountPaidCents, totalCents FROM "Order" WHERE id = ?`, o.orderId);
  const ins = q<{ sequence: number; status: string; paidCents: number; amountCents: number }>(`SELECT sequence, status, paidCents, amountCents FROM Installment WHERE orderId = ?`, o.orderId);
  const snap = JSON.stringify({ ord, ins, emails: templates(o.orderId) });
  expect(ord.status, snap).toBe("ENROLLED");
  // Un reembolso de cortesía NO convierte lo devuelto en deuda: nada de «cuota vencida» ni cobro de 10 USD.
  expect(templates(o.orderId), snap).not.toContain("installment_reminder");
  expect(ord.balanceCents, snap).toBeLessThanOrEqual(0);
  // Auditado como descuento: ajuste de saldo negativo + evento, la cuota sigue pagada (por el neto) y nada vencido.
  expect(ins.map((i) => i.status), snap).toEqual(["PAID"]);
  expect(q<{ amountCents: number }>(`SELECT amountCents FROM BalanceAdjustment WHERE orderId = ?`, o.orderId).map((a) => a.amountCents), snap).toEqual([-1000]);
  expect(events(o.orderId, "BALANCE_ADJUSTED").length, snap).toBe(1);
  expect(events(o.orderId, "REFUND").length, snap).toBe(1);
  expect(events(o.orderId, "INSTALLMENT_OVERDUE"), snap).toHaveLength(0);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
});

// ───────────── 3. Moodle rechaza la matrícula (error definitivo) ─────────────

test("Moodle rechaza la matrícula con un error definitivo al aprobar → pagado, cupo ocupado, sin «ya tienes acceso»; rematricular desde el panel → matriculado una vez", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("x2c8hard"));
  const ref = newRef("0108");
  expect((await reportManual(page, o.token, ref, bs(o.dueNowCents))).get("pago")).toBe("registrado");
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", count: 1, type: "exception", exception: "moodle_exception", errorcode: "wsusercannotassign", message: "No tiene permisos para asignar este rol" } });
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    await admin.getByTestId("payment").getByRole("button", { name: "Aprobar pago" }).click();
    await expect.poll(() => paymentRows(o.orderId)[0].status).toBe("COMPLETED");
    // La fila nace PENDING y pasa a FAILED cuando Moodle responde: esperar al estado final, no al intermedio.
    await expect.poll(() => enrollmentRows(o.orderId).map((e) => e.status).join(","), { timeout: 20_000 }).toBe("FAILED");
    // Pagado y con el cupo ocupado; Moodle falló de forma definitiva: FAILED + aviso en el panel, sin reintentos a ciegas.
    expect(order(o.orderId).status).toBe("PAID");
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expect(enrollmentRows(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "FAILED" }]);
    expect(events(o.orderId, "ATTENTION").some((e) => /Moodle rechazó la matrícula/.test(e.note ?? ""))).toBe(true);
    // Sin matrícula, ningún correo dice «ya tienes acceso a tus cursos».
    expect(emails(o.orderId).filter((m) => /Ya tienes acceso/.test(m.subject))).toHaveLength(0);
    // Rematricular desde el panel.
    await admin.reload();
    await admin.getByRole("button", { name: /Rematricular/ }).first().click();
    const confirm = admin.getByRole("dialog").getByRole("button", { name: /Rematricular/ });
    if (await confirm.count()) await confirm.first().click();
    await waitForOrderStatus(o.orderId, "ENROLLED", 30_000);
  } finally {
    await ctx.close();
  }
  const uid = customerOf(o.orderId).moodleUserId;
  expect(await enrolledIn(request, uid)).toEqual([C.moodleCourseId]);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  // Credenciales una vez (cuenta nueva) y «ya tienes acceso» una vez (tras la rematrícula).
  expect(emails(o.orderId).filter((m) => m.template === "platform_access").map((m) => m.dedupeKey?.split(":")[0]).sort()).toEqual(["platform_access", "platform_credentials"]);
});

// ───────────── 4. reembolso hecho en PayPal antes que el del panel ─────────────

test("el reembolso ya se hizo en PayPal (webhook aún no llega) y el admin reembolsa desde el panel → error claro; al llegar el webhook todo queda coherente", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c8ppfirst");
  const o = checkout(C, email, "PAYPAL");
  await page.goto(`/pedido/${o.token}`);
  await page.getByRole("button", { name: /PayPal/ }).first().click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  const pp = paymentRows(o.orderId).find((p) => p.status === "COMPLETED")!;
  // Webhooks apagados: el reembolso hecho en el panel de PayPal no avisa todavía.
  await paypalConfig(request, { autoWebhooks: false });
  try {
    const tok = await (await request.post(`${PAYPAL}/v1/oauth2/token`, { headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, data: "grant_type=client_credentials" })).json();
    const direct = await request.post(`${PAYPAL}/v2/payments/captures/${pp.paypalCaptureId}/refund`, { headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, data: {} });
    expect(direct.status(), await direct.text()).toBeLessThan(300);

    const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
    try {
      const card = admin.getByTestId("payment").filter({ hasText: "PayPal" });
      await card.getByTestId("refund").locator("summary").click();
      const form = card.getByRole("form", { name: "Reembolsar pago" });
      await form.getByLabel("Motivo").fill("No podrá asistir");
      await form.getByRole("button", { name: "Reembolsar" }).click();
      // PayPal responde CAPTURE_FULLY_REFUNDED: el panel lo dice y no cambia nada por su cuenta.
      expect(await toastText(admin)).toContain("CAPTURE_FULLY_REFUNDED");
    } finally {
      await ctx.close();
    }
    expect(order(o.orderId).status).toBe("ENROLLED");
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expect(q<{ status: string }>(`SELECT status FROM Refund WHERE paymentId = ?`, pp.id).map((r) => r.status)).toEqual(["FAILED"]);
    // Llega el webhook del reembolso hecho en PayPal.
    const wh = await (await request.post(`${PAYPAL}/__mock/send-webhook/${pp.paypalCaptureId}?event_type=PAYMENT.CAPTURE.REFUNDED`)).json();
    expect(wh.status).toBe(200);
  } finally {
    await paypalConfig(request, { autoWebhooks: true });
  }
  await runCron(request, "enrollments");
  const uid = customerOf(o.orderId).moodleUserId;
  const snap = JSON.stringify({ o: order(o.orderId), seat: reservationOf(o.orderId), refunds: q(`SELECT status, amountCents, providerRefundId FROM Refund WHERE paymentId = ?`, pp.id), pay: paymentRows(o.orderId), emails: templates(o.orderId) });
  expect(order(o.orderId).status, snap).toBe("REFUNDED");
  expect(reservationOf(o.orderId).status, snap).toBe("RELEASED");
  expect(cohort(C.cohortId), snap).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  expect(await enrolledIn(request, uid), snap).toEqual([]);
  expect(q(`SELECT id FROM Refund WHERE paymentId = ? AND status = 'COMPLETED'`, pp.id), snap).toHaveLength(1);
  expect(templates(o.orderId).filter((t) => t === "refund_issued"), snap).toHaveLength(1);
});

// ───────────── 6. reembolso parcial hecho en PayPal (webhook) ─────────────

test("reembolso PARCIAL hecho desde PayPal (llega el webhook) en un pedido pagado completo → al médico no se le cobra lo devuelto", async ({ page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("x2c8ppart"), "PAYPAL");
  await page.goto(`/pedido/${o.token}`);
  await page.getByRole("button", { name: /PayPal/ }).first().click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  const pp = paymentRows(o.orderId).find((p) => p.status === "COMPLETED")!;
  const tok = await (await request.post(`${PAYPAL}/v1/oauth2/token`, { headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, data: "grant_type=client_credentials" })).json();
  const direct = await request.post(`${PAYPAL}/v2/payments/captures/${pp.paypalCaptureId}/refund`, { headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, data: { amount: { value: "20.00", currency_code: "USD" }, note_to_payer: "Cortesía" } });
  expect(direct.status(), await direct.text()).toBeLessThan(300);
  await expect.poll(() => q(`SELECT id FROM Refund WHERE paymentId = ? AND status = 'COMPLETED'`, pp.id).length, { timeout: 20_000 }).toBe(1);
  await runCron(request, "installments");
  const ord = one<{ status: string; balanceCents: number }>(`SELECT status, balanceCents FROM "Order" WHERE id = ?`, o.orderId);
  const snap = JSON.stringify({ ord, emails: templates(o.orderId) });
  expect(ord.status, snap).toBe("ENROLLED");
  expect(templates(o.orderId), snap).not.toContain("installment_reminder");
});
