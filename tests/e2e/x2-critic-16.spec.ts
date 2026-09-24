// x2 critic 16 — sondas adversariales nuevas contra pago móvil → verificación → Moodle → cupo → correos y el
// reembolso, por HTTP contra el carril (app + mocks). Cada sonda mira el resultado REAL: BD, mock de PayPal,
// mock de Moodle y bandeja de correos.
//   1. Dos comprobantes DISTINTOS del mismo pedido, cada uno por el total, aprobados a la vez desde dos pestañas
//      del panel → un cupo, una matrícula, un acceso; el excedente queda a la vista (ATTENTION con saldo a favor).
//   2. Pedido pagado con pago móvil y un SEGUNDO comprobante aún en verificación: el admin reembolsa el primero
//      (opciones por defecto) → reembolsado, cupo libre, desmatriculado. Luego aprueba (o rechaza) el segundo desde
//      la pestaña abierta → no revive el pedido: sin cupo, sin Moodle, sin «ya tienes acceso».
//   3. Moodle caído al aprobar; reembolso total con «Desmatricular» DESMARCADO antes de que vuelva → el job de
//      matrículas no matricula a quien se le devolvió el dinero.
//   4. Moodle rechaza la desmatrícula con una excepción al reembolsar → pedido reembolsado y cupo libre al instante;
//      el job la reintenta y el médico pierde el acceso.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-16.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { MOODLE, cohort, customerOf, emails, enrollments, events, fixture, moodleState, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
let retryBefore: unknown = null;

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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c16 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string) => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAGO_MOVIL" });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();

/** Dos comprobantes del mismo pedido: dos pestañas abiertas ANTES de enviar el primero (la página oculta el formulario
 *  mientras un pago está en verificación), ambas rellenas y enviadas una tras otra. */
async function reportTwice(browser: Browser, token: string, refs: [string, string], amountBs: number) {
  const ctx = await browser.newContext({ locale: "es-VE" });
  try {
    const [p1, p2] = [await ctx.newPage(), await ctx.newPage()];
    await fillManual(p1, token, { reference: refs[0], amountBs });
    await fillManual(p2, token, { reference: refs[1], amountBs });
    await submitManual(p1);
    await submitManual(p2);
  } finally {
    await ctx.close();
  }
}
async function fillManual(page: Page, token: string, opts: { reference: string; amountBs: number }) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(opts.reference);
  await page.getByLabel(/Monto pagado/).fill(ves(opts.amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
}
async function submitManual(page: Page) {
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  const sp = new URL(page.url()).searchParams;
  expect(sp.get("pago"), sp.get("motivo") ?? "").toBe("registrado");
}
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
  const sp = new URL(page.url()).searchParams;
  expect(sp.get("pago"), sp.get("motivo") ?? "").toBe("registrado");
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
async function toastAfter(page: Page, click: () => Promise<void>) {
  await click();
  const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta|reembols/i }).last();
  await toast.waitFor({ timeout: 60_000 });
  return (await toast.textContent()) ?? "";
}
async function approve(page: Page, orderId: string, ref: string) {
  await page.goto(`/admin/orders/${orderId}`);
  return toastAfter(page, () => card(page, ref).getByRole("button", { name: "Aprobar pago" }).click());
}
/** Reembolso desde el panel con las opciones por defecto del diálogo (o desmarcando «Desmatricular»). */
async function refundInPanel(page: Page, orderId: string, ref: string, opts: { keepMoodle?: boolean } = {}) {
  await page.goto(`/admin/orders/${orderId}`);
  const c = card(page, ref);
  await c.getByTestId("refund").locator("summary").click();
  const form = c.getByRole("form", { name: "Reembolsar pago" });
  await form.getByLabel("Motivo").fill("Sonda x2c16");
  if (opts.keepMoodle) await form.getByRole("checkbox", { name: /Desmatricular de Moodle/ }).uncheck();
  return toastAfter(page, () => form.getByRole("button", { name: "Reembolsar" }).click());
}

const paymentRows = (orderId: string) =>
  q<{ id: string; status: string; reference: string | null; amountUsdCents: number; refundedCents: number }>(`SELECT id, status, reference, amountUsdCents, refundedCents FROM Payment WHERE orderId = ? ORDER BY createdAt`, orderId);
const templates = (orderId: string) => emails(orderId).map((e) => e.template);
const countOf = (xs: string[], x: string) => xs.filter((y) => y === x).length;
const liveHeld = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
const liveConfirmed = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: liveHeld(cohortId), confirmed: liveConfirmed(cohortId) });
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
}
async function moodleCoursesOf(request: APIRequestContext, orderId: string) {
  const uid = customerOf(orderId).moodleUserId;
  if (uid == null) return [];
  return (await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid);
}
async function enrolCallsSince(request: APIRequestContext, since: number, userId: number | null) {
  const calls = (await (await request.get(`${MOODLE}/__mock/calls`)).json()) as { at: number; wsfunction: string; params: Record<string, unknown> }[];
  return calls.filter((c) => c.at >= since && c.wsfunction === "enrol_manual_enrol_users" && (userId == null || JSON.stringify(c.params).includes(`"userid":"${userId}"`) || JSON.stringify(c.params).includes(`"userid":${userId}`)));
}

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  retryBefore = fixture<{ before: unknown }>("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } }).before;
});
test.afterAll(() => {
  for (const [key, value] of [["payments.manualMethods", settingsBefore], ["enrollment.retry", retryBefore]] as const) {
    if (value == null) continue;
    try {
      fixture("setting", { key, value });
    } catch {
      /* valor previo no válido: se queda el de esta corrida */
    }
  }
});

// ───────────── 1. dos comprobantes completos aprobados a la vez ─────────────

test("dos comprobantes distintos por el total, aprobados a la vez desde dos pestañas → un cupo, una matrícula, un acceso; saldo a favor a la vista", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("c16dbl"));
  const [r1, r2] = [newRef("0102"), newRef("0134")];
  await reportTwice(browser, o.token, [r1, r2], bs(o.dueNowCents));
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(cohort(C.cohortId)).toMatchObject({ seatsHeld: 1, seatsConfirmed: 0 });

  const A = await adminPage(browser);
  const B = await adminPage(browser);
  try {
    await Promise.all([A.page.goto(`/admin/orders/${o.orderId}`), B.page.goto(`/admin/orders/${o.orderId}`)]);
    const since = Date.now();
    const [tA, tB] = await Promise.all([
      toastAfter(A.page, () => card(A.page, r1).getByRole("button", { name: "Aprobar pago" }).click()),
      toastAfter(B.page, () => card(B.page, r2).getByRole("button", { name: "Aprobar pago" }).click()),
    ]);
    expect(tA + tB).not.toMatch(/No pudimos/);
    await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
    expect(paymentRows(o.orderId).map((p) => p.status)).toEqual(["COMPLETED", "COMPLETED"]);
    expect(order(o.orderId)).toMatchObject({ amountPaidCents: 2 * o.totalCents, balanceCents: -o.totalCents });
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expect(cohort(C.cohortId)).toMatchObject({ seatsHeld: 0, seatsConfirmed: 1 });
    expectCohortConsistent(C.cohortId);
    const uid = customerOf(o.orderId).moodleUserId;
    expect(await moodleCoursesOf(request, o.orderId)).toEqual([C.moodleCourseId]);
    expect((await enrolCallsSince(request, since, uid)).length).toBe(1);
    const t = templates(o.orderId);
    expect(countOf(t, "platform_access")).toBe(1);
    expect(countOf(t, "cohort_details")).toBe(1);
    expect(countOf(t, "payment_approved")).toBe(2);
    // El staff ve el pago de más para devolverlo.
    expect(events(o.orderId, "ATTENTION").some((e) => /de más/.test(e.note ?? ""))).toBe(true);
  } finally {
    await A.ctx.close();
    await B.ctx.close();
  }
});

// ───────────── 2. reembolso con otro comprobante aún en verificación ─────────────

for (const second of ["approve", "reject"] as const) {
  test(`reembolso del pago aprobado con un 2.º comprobante en verificación; luego el admin ${second === "approve" ? "APRUEBA" : "RECHAZA"} el 2.º → el pedido no revive`, async ({ browser, page, request }) => {
    const C = newCohort(3);
    const email = uniqueEmail(`c16rf${second.slice(0, 2)}`);
    const o = checkout(C, email);
    const [r1, r2] = [newRef("0102"), newRef("0134")];
    await reportTwice(browser, o.token, [r1, r2], bs(o.dueNowCents));
    const A = await adminPage(browser);
    try {
      const t1 = await approve(A.page, o.orderId, r1);
      expect(t1).toContain("Pago aprobado");
      await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
      const tRefund = await refundInPanel(A.page, o.orderId, r1);
      expect(tRefund).toMatch(/Reembolso completado/);
      await waitForOrderStatus(o.orderId, "REFUNDED");
      expect(reservationOf(o.orderId).status).toBe("RELEASED");
      expect(await moodleCoursesOf(request, o.orderId)).toEqual([]);
      expectCohortConsistent(C.cohortId);
      const mailsBefore = templates(o.orderId);

      // El segundo comprobante sigue en la cola; el admin lo resuelve desde la ficha.
      const since = Date.now();
      await A.page.goto(`/admin/orders/${o.orderId}`);
      let toast: string;
      if (second === "approve") {
        toast = await toastAfter(A.page, () => card(A.page, r2).getByRole("button", { name: "Aprobar pago" }).click());
      } else {
        await card(A.page, r2).getByRole("button", { name: "Rechazar pago" }).click();
        const form = card(A.page, r2).getByRole("form", { name: "Rechazar pago" });
        await form.getByLabel("Motivo del rechazo").fill("Pago duplicado: el pedido ya fue reembolsado.");
        toast = await toastAfter(A.page, () => form.getByRole("button", { name: "Rechazar pago" }).click());
      }
      console.log(JSON.stringify({ second, toast, status: order(o.orderId).status, newMails: templates(o.orderId).slice(mailsBefore.length) }));
      // Nada revive: el pedido sigue reembolsado, sin cupo y sin Moodle.
      expect(order(o.orderId).status).toBe("REFUNDED");
      expect(reservationOf(o.orderId).status).toBe("RELEASED");
      expectCohortConsistent(C.cohortId);
      expect(await moodleCoursesOf(request, o.orderId)).toEqual([]);
      expect(await enrolCallsSince(request, since, customerOf(o.orderId).moodleUserId)).toHaveLength(0);
      const newMails = templates(o.orderId).slice(mailsBefore.length);
      expect(newMails).not.toContain("platform_access");
      expect(newMails).not.toContain("cohort_details");
      if (second === "approve") {
        // Dinero recibido en un pedido cerrado: el staff debe verlo (ATTENTION) y el panel no debe decir «al día».
        expect(events(o.orderId, "ATTENTION").some((e) => /pedido cerrado/.test(e.note ?? ""))).toBe(true);
        expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.totalCents, balanceCents: 0 });
        // El panel no dice «al día»: avisa que el pedido está cerrado y que ese dinero hay que devolverlo.
        expect(toast).not.toMatch(/quedó al día|quedó pagado|se inició la matrícula/);
        expect(toast).toMatch(/pedido está reembolsado/);
        expect(toast).toMatch(/devolverle este pago/);
        // …y el admin puede devolverlo desde la misma ficha: el 2.º pago queda REFUNDED, el pedido sigue cerrado.
        const tRefund2 = await refundInPanel(A.page, o.orderId, r2);
        expect(tRefund2).toMatch(/Reembolso completado/);
        const p2 = paymentRows(o.orderId).find((p) => p.reference === r2)!;
        expect(p2).toMatchObject({ status: "REFUNDED", refundedCents: p2.amountUsdCents });
        expect(order(o.orderId).status).toBe("REFUNDED");
        expect(reservationOf(o.orderId).status).toBe("RELEASED");
        expectCohortConsistent(C.cohortId);
        expect(await moodleCoursesOf(request, o.orderId)).toEqual([]);
      } else {
        // El correo de rechazo no invita a «registrar el pago de nuevo» en un pedido que ya no admite pagos.
        const rej = emails(o.orderId).filter((m) => m.template === "payment_rejected").pop()!;
        expect(rej.text).not.toMatch(/registrar nuevamente el pago/);
        expect(rej.html).not.toContain("Registrar el pago de nuevo");
        expect(rej.text).toMatch(/ya está cerrado/);
      }
    } finally {
      await A.ctx.close();
    }
  });
}


// ───────────── 2b. comprobante duplicado rechazado en un pedido ya pagado / con otro en verificación ─────────────

test("comprobante duplicado: rechazarlo con el pedido ya pagado no invita al médico a pagar de nuevo; con otro en verificación tampoco", async ({ browser, request }) => {
  const C = newCohort(3);
  // (a) pedido ya pagado con el primer comprobante; el segundo (duplicado) se rechaza.
  const o = checkout(C, uniqueEmail("c16dup"));
  const [r1, r2] = [newRef("0102"), newRef("0134")];
  await reportTwice(browser, o.token, [r1, r2], bs(o.dueNowCents));
  // (b) otro pedido con dos comprobantes; se rechaza uno mientras el otro sigue en verificación.
  const o2 = checkout(C, uniqueEmail("c16pend"));
  const [s1, s2] = [newRef("0102"), newRef("0134")];
  await reportTwice(browser, o2.token, [s1, s2], bs(o2.dueNowCents));
  const A = await adminPage(browser);
  try {
    expect(await approve(A.page, o.orderId, r1)).toContain("Pago aprobado");
    await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
    await A.page.goto(`/admin/orders/${o.orderId}`);
    await card(A.page, r2).getByRole("button", { name: "Rechazar pago" }).click();
    let form = card(A.page, r2).getByRole("form", { name: "Rechazar pago" });
    await form.getByLabel("Motivo del rechazo").fill("Comprobante duplicado.");
    expect(await toastAfter(A.page, () => form.getByRole("button", { name: "Rechazar pago" }).click())).toContain("Pago rechazado");
    expect(order(o.orderId).status).toBe("ENROLLED");
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expect(await moodleCoursesOf(request, o.orderId)).toEqual([C.moodleCourseId]);
    const rej = emails(o.orderId).filter((m) => m.template === "payment_rejected");
    expect(rej).toHaveLength(1);
    expect(rej[0].text).not.toMatch(/registrar nuevamente el pago/);
    expect(rej[0].html).not.toContain("Registrar el pago de nuevo");
    expect(rej[0].text).toMatch(/ya está pagado/);

    await A.page.goto(`/admin/orders/${o2.orderId}`);
    await card(A.page, s2).getByRole("button", { name: "Rechazar pago" }).click();
    form = card(A.page, s2).getByRole("form", { name: "Rechazar pago" });
    await form.getByLabel("Motivo del rechazo").fill("Comprobante ilegible.");
    expect(await toastAfter(A.page, () => form.getByRole("button", { name: "Rechazar pago" }).click())).toContain("Pago rechazado");
    expect(order(o2.orderId).status).toBe("AWAITING_VERIFICATION");
    expect(reservationOf(o2.orderId).status).toBe("HELD");
    const rej2 = emails(o2.orderId).filter((m) => m.template === "payment_rejected");
    expect(rej2).toHaveLength(1);
    // La página del pedido no muestra el formulario mientras el otro pago está en verificación: el correo tampoco
    // debe mandarlo a «registrar el pago de nuevo».
    expect(rej2[0].text).toMatch(/Seguimos verificando el otro pago/);
    expect(rej2[0].html).not.toContain("Registrar el pago de nuevo");
    // …y aprobar el que queda → inscrito, un cupo.
    expect(await approve(A.page, o2.orderId, s1)).toContain("Pago aprobado");
    await waitForOrderStatus(o2.orderId, "ENROLLED", 45_000);
    expectCohortConsistent(C.cohortId);
  } finally {
    await A.ctx.close();
  }
});

// ───────────── 3. Moodle caído al aprobar; reembolso sin desmatricular antes de que vuelva ─────────────

test("Moodle caído al aprobar; reembolso total con «Desmatricular» desmarcado antes de que vuelva → el job no matricula al reembolsado", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("c16mdl"));
  const ref = newRef("0102");
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "http", status: 503, count: 10 } });
  const A = await adminPage(browser);
  try {
    const t = await approve(A.page, o.orderId, ref);
    expect(t).toContain("Pago aprobado");
    await waitForOrderStatus(o.orderId, "PAID");
    const tRefund = await refundInPanel(A.page, o.orderId, ref, { keepMoodle: true });
    expect(tRefund).toMatch(/Reembolso completado/);
    await waitForOrderStatus(o.orderId, "REFUNDED");
  } finally {
    await A.ctx.close();
  }
  // Moodle vuelve (vaciar fallos pendientes: el mock los consume por llamada).
  for (let i = 0; i < 12; i++) {
    const r = await request.post(`${MOODLE}/webservice/rest/server.php?wstoken=mock-moodle-token&moodlewsrestformat=json&wsfunction=enrol_manual_enrol_users`);
    if (r.status() === 200) break;
  }
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 6_000));
  await runCron(request, "enrollments");
  await runCron(request, "enrollments");
  expect(order(o.orderId).status).toBe("REFUNDED");
  expect(await moodleCoursesOf(request, o.orderId)).toEqual([]);
  expect(await enrolCallsSince(request, since, customerOf(o.orderId).moodleUserId)).toHaveLength(0);
  // La matrícula que nunca se completó no queda «pendiente» para siempre (x2 critic 20): se cierra con el motivo.
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "UNENROLLED" }]);
  expect(one<{ lastError: string }>(`SELECT lastError FROM Enrollment WHERE orderId = ?`, o.orderId).lastError).toMatch(/reembolsado antes de completar/);
  // La cuenta de Moodle se creó antes del fallo de matrícula (y su contraseña temporal ya se envió, «tus cursos se
  // activarán en breve»); tras el reembolso solo sale el correo del reembolso: ningún acceso ni cohorte.
  const mails = templates(o.orderId);
  expect(mails.slice(mails.indexOf("refund_issued"))).toEqual(["refund_issued"]);
  expect(mails).not.toContain("cohort_details");
  expectCohortConsistent(C.cohortId);
});

// ───────────── 4. Moodle rechaza la desmatrícula con excepción al reembolsar ─────────────

test("Moodle responde con excepción a la desmatrícula del reembolso → reembolsado y cupo libre ya; el job reintenta y el médico pierde el acceso", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("c16unx"));
  const ref = newRef("0102");
  await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  const A = await adminPage(browser);
  try {
    await approve(A.page, o.orderId, ref);
    await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
    expect(await moodleCoursesOf(request, o.orderId)).toEqual([C.moodleCourseId]);
    await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_unenrol_users", type: "exception", exception: "dml_write_exception", errorcode: "dmlwriteexception", message: "Error writing to database", count: 1 } });
    const tRefund = await refundInPanel(A.page, o.orderId, ref);
    expect(tRefund).toMatch(/Reembolso completado/);
  } finally {
    await A.ctx.close();
  }
  await waitForOrderStatus(o.orderId, "REFUNDED");
  expect(reservationOf(o.orderId).status).toBe("RELEASED");
  expectCohortConsistent(C.cohortId);
  expect(events(o.orderId, "UNENROLLMENT_FAILED").length).toBeGreaterThan(0);
  await runCron(request, "enrollments");
  await expect.poll(() => moodleCoursesOf(request, o.orderId), { timeout: 20_000 }).toEqual([]);
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "UNENROLLED" }]);
  expect(countOf(templates(o.orderId), "refund_issued")).toBe(1);
});
