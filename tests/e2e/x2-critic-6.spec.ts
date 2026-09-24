// x2 critic 6 — sondas adversariales nuevas contra pago móvil → verificación → Moodle → cupo → correos y el
// reembolso, por HTTP contra el carril (app + mocks). Cada sonda comprueba el resultado REAL: BD, estado del mock
// de Moodle y bandeja de correos.
//   1. Reembolso A MITAD de la matrícula: el admin aprueba el pago móvil, Moodle tarda y la respuesta se pierde
//      (ejecuta la matrícula y responde 5xx) mientras otro admin reembolsa con «Desmatricular» → el médico
//      reembolsado NO puede quedar matriculado en Moodle.
//   2. Reembolso PARCIAL desde el panel marcando «Desmatricular» y «Liberar cupo» (retiro con retención) → estado
//      coherente: sin cupo y sin Moodle, el pedido no sigue «Inscrito» ni el job le cobra el saldo.
//   3. Misma referencia bancaria con ceros a la izquierda en otro pedido → el panel no puede decir «La
//      referencia no se ha usado en otro pedido».
//   4. Comprobante HEIC (iPhone) → no se acepta (ni renombrado a .jpg); lo que se acepta el admin lo ve.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-6.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOODLE, cohort, customerOf, emails, events, fixture, fixtureAsync, moodleState, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c6 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);

async function reportManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
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
const paymentRow = (orderId: string) =>
  one<{ id: string; status: string; amountUsdCents: number; refundedCents: number; reference: string }>(`SELECT id, status, amountUsdCents, refundedCents, reference FROM Payment WHERE orderId = ? ORDER BY createdAt LIMIT 1`, orderId);
const enrollmentRows = (orderId: string) =>
  q<{ moodleCourseId: number; status: string }>(`SELECT e.moodleCourseId, e.status FROM Enrollment e JOIN "Order" o ON o.customerId = e.customerId WHERE o.id = ?`, orderId);

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

// ───────────── 1. reembolso a mitad de la matrícula ─────────────

test("reembolso con «Desmatricular» mientras Moodle matricula (y pierde la respuesta) → el médico reembolsado no queda matriculado", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c6mid");
  const o = checkout(C, email);
  expect((await reportManual(page, o.token, { reference: `0134${Date.now().toString().slice(-8)}`, amountBs: bs(o.dueNowCents) })).get("pago")).toBe("registrado");
  const pay = paymentRow(o.orderId);
  expect(pay.status).toBe("AWAITING_VERIFICATION");

  // Moodle: cada enrol_manual_enrol_users tarda 2,5 s, SÍ matricula y responde 503 (respuesta perdida). Las 3
  // llamadas en línea de la aprobación (1 + 2 reintentos) fallan así.
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", count: 3, type: "http", status: 503, after: true, delayMs: 2500 } });

  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    // Aprobar (no se espera: la acción queda esperando a Moodle).
    const approving = admin.getByTestId("payment").getByRole("button", { name: "Aprobar pago" }).click();
    // Mientras Moodle procesa la matrícula, otro admin reembolsa el pago con «Desmatricular».
    await expect.poll(() => paymentRow(o.orderId).status, { timeout: 15_000 }).toBe("COMPLETED");
    await expect.poll(() => customerOf(o.orderId).moodleUserId, { timeout: 15_000 }).not.toBeNull();
    const refund = await fixtureAsync("refund", { paymentId: pay.id, unenroll: true, releaseSeat: true, reason: "El médico desistió", idempotencyKey: `x2c6-${Date.now()}` });
    expect(refund.ok, refund.ok ? "" : refund.error).toBe(true);
    await approving;
    // Que termine todo lo que estaba en curso (la acción del admin y sus reintentos en línea).
    await expect.poll(() => events(o.orderId, "ENROLLMENT_FAILED").length + events(o.orderId, "ENROLLMENT").length, { timeout: 30_000 }).toBeGreaterThan(0);
    await admin.waitForTimeout(3_000);
  } finally {
    await ctx.close();
  }
  // El job de matrículas / desmatrículas corre después: tampoco debe dejarlo matriculado.
  await runCron(request, "enrollments");

  expect(order(o.orderId).status).toBe("REFUNDED");
  expect(reservationOf(o.orderId).status).toBe("RELEASED");
  const uid = customerOf(o.orderId).moodleUserId!;
  const live = (await moodleState(request)).enrolments.filter((e) => e.userid === uid && e.courseid === C.moodleCourseId);
  // Resultado real: el médico reembolsado NO debe tener acceso al aula.
  expect(live, `Moodle: ${JSON.stringify(live)} · BD: ${JSON.stringify(enrollmentRows(o.orderId))} · eventos: ${events(o.orderId).map((e) => e.type).join(",")}`).toEqual([]);
});

// ───────────── 2. reembolso parcial con las opciones por defecto ─────────────

test("reembolso PARCIAL marcando «Desmatricular» y «Liberar cupo» → sin cupo ni Moodle, el pedido no queda «Inscrito» cobrándole el saldo", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c6part");
  const o = checkout(C, email);
  expect((await reportManual(page, o.token, { reference: `0102${Date.now().toString().slice(-8)}`, amountBs: bs(o.dueNowCents) })).get("pago")).toBe("registrado");
  const pay = paymentRow(o.orderId);
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    await admin.getByTestId("payment").getByRole("button", { name: "Aprobar pago" }).click();
    await waitForOrderStatus(o.orderId, "ENROLLED");
    // Reembolso parcial (se retiene el 10 %) desde el formulario del panel.
    await admin.reload();
    const card = admin.getByTestId("payment").first();
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    const partial = Math.round(pay.amountUsdCents * 0.9);
    await form.getByRole("textbox", { name: /Monto a reembolsar/ }).fill((partial / 100).toFixed(2));
    await form.getByLabel("Motivo").fill("Retiro: se retiene el 10 % de gastos administrativos.");
    // El admin deja marcadas «Desmatricular» y «Liberar el cupo» (el médico se retira).
    await form.getByRole("checkbox", { name: /Desmatricular de Moodle/ }).check();
    await form.getByRole("checkbox", { name: /Liberar el cupo/ }).check();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await expect(admin.getByRole("status").filter({ hasText: /Reembolso/ })).toBeVisible();
  } finally {
    await ctx.close();
  }
  await runCron(request, "expire,enrollments,installments");

  const ord = order(o.orderId);
  const seat = reservationOf(o.orderId).status;
  const uid = customerOf(o.orderId).moodleUserId!;
  const inMoodle = (await moodleState(request)).enrolments.some((e) => e.userid === uid && e.courseid === C.moodleCourseId);
  const snapshot = JSON.stringify({ status: ord.status, balanceCents: ord.balanceCents, amountPaidCents: ord.amountPaidCents, seat, inMoodle, enrollments: enrollmentRows(o.orderId), emails: emails(o.orderId).map((m) => m.template) });
  // Sin cupo y sin Moodle, el pedido no puede seguir «Inscrito» ni con saldo por cobrar.
  if (seat === "RELEASED" && !inMoodle) {
    expect(ord.status, snapshot).not.toBe("ENROLLED");
    expect(ord.balanceCents, snapshot).toBeLessThanOrEqual(0);
  }
  expect(emails(o.orderId).map((m) => m.template), snapshot).not.toContain("installment_reminder");
  expect(cohort(C.cohortId).seatsConfirmed + cohort(C.cohortId).seatsHeld).toBe(seat === "RELEASED" ? 0 : 1);
});

// ───────────── 3. referencia con ceros a la izquierda ─────────────

test("la misma referencia con ceros a la izquierda en otro pedido → el panel la marca como ya usada (no «no se ha usado»)", async ({ browser, page }) => {
  const C = newCohort(3);
  const ref = `${Date.now().toString().slice(-8)}`;
  const a = checkout(C, uniqueEmail("x2c6ra"));
  expect((await reportManual(page, a.token, { reference: ref, amountBs: bs(a.dueNowCents) })).get("pago")).toBe("registrado");
  const ctxB = await browser.newContext({ locale: "es-VE" });
  const b = checkout(C, uniqueEmail("x2c6rb"));
  const res = await reportManual(await ctxB.newPage(), b.token, { reference: `0000${ref}`, amountBs: bs(b.dueNowCents) });
  await ctxB.close();
  if (res.get("pago") !== "registrado") return; // rechazada como duplicada: correcto
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${b.orderId}`);
    const card = admin.getByTestId("payment").first();
    await expect(card).toContainText(`0000${ref}`);
    await expect(card, "el panel da por buena una referencia que ya se usó en otro pedido").not.toContainText("La referencia no se ha usado en otro pedido.");
  } finally {
    await ctx.close();
  }
});

// ───────────── 4. comprobante HEIC (foto de iPhone) ─────────────

// Chrome/Firefox no decodifican HEIC y el sharp del proyecto no trae HEVC: un comprobante HEIC sería una imagen
// rota en el panel. Corrección: el formulario ya no ofrece HEIC en `accept` (Safari de iOS convierte la foto a
// JPEG al enviarla) y el servidor rechaza HEIC por extensión Y por contenido (una HEIC renombrada a .jpg).
// Lo que sí se guarda tiene que verse en el panel del admin.
test("comprobante HEIC (foto de iPhone): no se guarda nada que el admin no pueda ver", async ({ browser, page }) => {
  const heic = fs.readFileSync(path.join(__dirname, "fixtures", "x2", "comprobante.heic"));
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("x2c6heic"));
  const fill = async () => {
    await page.goto(`/pedido/${o.token}`);
    await page.getByLabel("Número de referencia").fill(`0134${Date.now().toString().slice(-8)}`);
    await page.getByLabel(/Monto pagado/).fill(ves(bs(o.dueNowCents)));
    await page.getByLabel("Banco de origen").fill("Banesco (0134)");
    await page.getByLabel("Fecha del pago").fill(todayCaracas());
    await page.getByLabel("Cédula del titular").fill("V-14567890");
  };
  await fill();
  // iOS solo convierte a JPEG si el formulario no pide HEIC: `accept` no puede listarlo (ni `image/*`).
  const accept = (await page.getByLabel(/Comprobante/).getAttribute("accept")) ?? "";
  expect(accept).not.toMatch(/hei[cf]|image\/\*/i);
  expect(accept).toMatch(/image\/jpeg/);

  // Foto HEIC original y una HEIC renombrada a .jpg: ninguna se registra, y el médico sabe qué enviar.
  for (const name of ["IMG_0421.HEIC", "IMG_0421.jpg"]) {
    if (name !== "IMG_0421.HEIC") await fill();
    await page.getByLabel(/Comprobante/).setInputFiles({ name, mimeType: name.endsWith(".jpg") ? "image/jpeg" : "image/heic", buffer: heic });
    await page.getByRole("button", { name: "Enviar datos del pago" }).click();
    await page.waitForURL(/[?&]pago=(registrado|error)/);
    expect(new URL(page.url()).searchParams.get("pago"), name).toBe("error");
    await expect(page.getByText(/HEIC del iPhone no se pueden revisar/).first()).toBeVisible();
    expect(q(`SELECT id FROM Payment WHERE orderId = ?`, o.orderId), name).toHaveLength(0);
    expect(order(o.orderId).status).not.toBe("AWAITING_VERIFICATION");
  }

  // La captura en JPEG/PNG (lo que envía iOS al convertir) sí pasa, y el admin la VE.
  const params = await reportManual(page, o.token, { reference: `0134${Date.now().toString().slice(-8)}`, amountBs: bs(o.dueNowCents) });
  expect(params.get("pago")).toBe("registrado");
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    const img = admin.getByTestId("payment").first().getByTestId("proof").getByRole("img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : -1))).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
