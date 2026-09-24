// x2 critic 9 — sondas adversariales nuevas contra pago móvil → verificación → Moodle → cupo → correos, por HTTP
// contra el carril (app + mocks). Cada sonda comprueba el resultado REAL: BD, mock de Moodle y bandeja de correos.
//   1. La tasa BCV se actualiza entre el checkout y el comprobante: el médico paga EXACTAMENTE los bolívares que le
//      indicó el correo «Recibimos tu pedido» (con la tasa de ese momento) y el admin aprueba → inscrito, no
//      «pago insuficiente» con un correo «pago aprobado» sin acceso.
//   2. Pago partido (límite del pago móvil): mitad aprobada → el correo no promete el acceso y dice cuánto falta; el
//      resto rechazado, reenviado y aprobado → una matrícula, un cupo y los correos correctos.
//   3. Compradores concurrentes por el ÚLTIMO cupo con pago móvil desde el checkout real → una sola reserva.
//   4. El mismo médico (correo con otras mayúsculas) tiene el curso por DOS pedidos (semipresencial con pago móvil y
//      online con PayPal): reembolsar uno con «Desmatricular» no le quita el aula que sigue pagando por el otro.
//   5. Moodle caído al aprobar y reembolso (pago móvil, desmatricular) antes de que vuelva → el job no matricula a
//      quien ya se le devolvió el dinero ni le envía el acceso.
//   6. Tras reembolsar un pedido PayPal desde el panel, PayPal reentrega PAYMENT.CAPTURE.COMPLETED (el original y uno
//      nuevo) → nada revive: ni pago, ni cupo, ni Moodle, ni correos.
//   7. pago 0,5 % corto: el panel muestra el faltante y no dice «quedó pagado» (el pedido sigue PENDING_PAYMENT).
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-9.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, events, fixture, moodleState, enrolCallsFor, moodleCalls, one, order, q, replayWebhook, reservationOf, resendCaptureWebhook, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c9 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string) => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAGO_MOVIL" });
const setRate = (vesPerUsd: number) => fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd, source: "BCV" } });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();
const templates = (orderId: string) => emails(orderId).map((e) => e.template);

async function reportManual(page: Page, token: string, reference: string, amountBsText: string) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(reference);
  await page.getByLabel(/Monto pagado/).fill(amountBsText);
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
const paymentRows = (orderId: string) =>
  q<{ id: string; status: string; amountCents: number; amountUsdCents: number; reference: string; exchangeRate: string | null }>(
    `SELECT id, status, amountCents, amountUsdCents, reference, exchangeRate FROM Payment WHERE orderId = ? ORDER BY createdAt`,
    orderId,
  );

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  setRate(RATE);
});
test.afterAll(() => {
  setRate(RATE);
  if (settingsBefore == null) return;
  try {
    fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
  } catch {
    /* valor previo no válido */
  }
});

// ───────────── 1. la tasa cambia entre el checkout y el comprobante ─────────────

test("la tasa BCV sube después del checkout: el médico paga los Bs. que le indicó el correo → aprobado = inscrito (no «pago insuficiente»)", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c9rate");
  const o = checkout(C, email);
  // El correo «Recibimos tu pedido» le dice cuánto pagar en bolívares, con la tasa de ese momento.
  await expect.poll(() => templates(o.orderId)).toContain("order_confirmation");
  const quotedBs = Math.round(o.dueNowCents * RATE);
  const received = emails(o.orderId).find((e) => e.template === "order_confirmation")!;
  expect(received.text + received.html).toContain(ves(quotedBs));

  // Hace el pago móvil por ese monto. Antes de que registre el comprobante, el staff actualiza la tasa del día.
  setRate(Math.round(RATE * 1.004 * 100) / 100);
  try {
    const ref = newRef("0134");
    expect((await reportManual(page, o.token, ref, ves(quotedBs))).get("pago")).toBe("registrado");
    expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");

    const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
    try {
      const card = admin.getByTestId("payment").filter({ hasText: ref });
      await card.getByRole("button", { name: "Aprobar pago" }).click();
      await expect(admin.getByRole("status").or(admin.getByRole("alert")).filter({ hasText: /pago/i }).last()).toBeVisible();
    } finally {
      await ctx.close();
    }
    await waitForOrderStatus(o.orderId, ["ENROLLED", "PENDING_PAYMENT"], 30_000);
    const st = order(o.orderId);
    const pay = paymentRows(o.orderId)[0];
    // El médico pagó exactamente lo que se le pidió: el pedido debe quedar pagado e inscrito.
    expect({ status: st.status, amountPaidCents: st.amountPaidCents, paymentUsd: pay.amountUsdCents }, JSON.stringify(events(o.orderId).filter((e) => e.type === "ATTENTION"))).toEqual({
      status: "ENROLLED",
      amountPaidCents: o.dueNowCents,
      paymentUsd: o.dueNowCents,
    });
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    const cust = customerOf(o.orderId);
    expect((await moodleState(request)).enrolments.filter((e) => e.userid === cust.moodleUserId).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
    expect(templates(o.orderId)).toEqual(expect.arrayContaining(["payment_approved", "platform_access"]));
  } finally {
    setRate(RATE);
  }
});

// ───────────── 2. pago partido en dos pagos móviles ─────────────

test("pago partido (límite del pago móvil): mitad aprobada → correo sin promesa de acceso y cupo protegido; resto rechazado, reenviado y aprobado → una matrícula", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c9split");
  const o = checkout(C, email);
  const totalBs = Math.round(o.dueNowCents * RATE);
  const half = Math.floor(totalBs / 2);
  const refA = newRef("0102");
  expect((await reportManual(page, o.token, refA, ves(half))).get("pago")).toBe("registrado");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  // Mientras está en verificación, la página del pedido no ofrece registrar otro pago.
  await page.goto(`/pedido/${o.token}`);
  await expect(page.getByLabel("Número de referencia")).toHaveCount(0);

  const approve = async (ref: string) => {
    const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
    try {
      await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
      await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
    } finally {
      await ctx.close();
    }
  };
  await approve(refA);
  expect(order(o.orderId)).toMatchObject({ status: "PENDING_PAYMENT", amountPaidCents: Math.round(half / RATE) });
  expect(reservationOf(o.orderId).status).toBe("HELD");
  expect(customerOf(o.orderId).moodleUserId).toBeNull();
  // El correo de aprobación de un pago que NO completa el primer pago no promete el acceso: dice cuánto falta.
  const ok1 = emails(o.orderId).filter((e) => e.template === "payment_approved");
  expect(ok1).toHaveLength(1);
  expect(ok1[0].html).not.toContain("en unos minutos recibirás tu acceso");
  const missing = o.dueNowCents - Math.round(half / RATE);
  expect(ok1[0].text).toContain(`Aún faltan $${(missing / 100).toFixed(2)}`);

  // Resto: primero con una referencia que el banco no muestra → rechazado; el pedido sigue con su cupo.
  const refB = newRef("0105");
  expect((await reportManual(page, o.token, refB, ves(totalBs - half))).get("pago")).toBe("registrado");
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    const cardB = admin.getByTestId("payment").filter({ hasText: refB });
    await cardB.getByRole("button", { name: "Rechazar pago" }).click();
    await cardB.getByRole("form", { name: "Rechazar pago" }).getByLabel("Motivo del rechazo").fill("La referencia no aparece en el banco.");
    await cardB.getByRole("button", { name: "Rechazar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago rechazado" })).toBeVisible();
  } finally {
    await ctx.close();
  }
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 1, seatsConfirmed: 0 });
  const rej = emails(o.orderId).find((e) => e.template === "payment_rejected")!;
  expect(rej.text + rej.html).not.toMatch(/cupo (fue|quedó) liberado|liberamos (tu|el) cupo|pedido (fue |quedó )?cancelado/i);

  // Reenvía con la referencia correcta → aprobado → inscrito una vez.
  const refB2 = newRef("0108");
  expect((await reportManual(page, o.token, refB2, ves(totalBs - half))).get("pago")).toBe("registrado");
  await approve(refB2);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.dueNowCents, balanceCents: 0 });
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  const cust = customerOf(o.orderId);
  expect(enrolCallsFor(await moodleCalls(request), cust.moodleUserId!)).toEqual([C.moodleCourseId]);
  const t = templates(o.orderId);
  expect(t.filter((x) => x === "platform_access")).toHaveLength(1);
  expect(t.filter((x) => x === "cohort_details")).toHaveLength(1);
  expect(t.filter((x) => x === "payment_approved")).toHaveLength(2);
  const ok2 = emails(o.orderId).filter((e) => e.template === "payment_approved")[1];
  expect(ok2.text).not.toContain("Aún faltan");
});

// ───────────── 3. compradores concurrentes por el último cupo ─────────────

test("cuatro médicos a la vez por el ÚLTIMO cupo con pago móvil desde el checkout → una reserva, nunca sobreventa", async ({ browser }) => {
  const C = newCohort(1);
  const ctxs = await Promise.all([0, 1, 2, 3].map(() => browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } })));
  const mails = ctxs.map((_, i) => uniqueEmail(`x2c9race${i}`));
  try {
    const pages = await Promise.all(ctxs.map((c) => c.newPage()));
    await Promise.all(
      pages.map(async (p, i) => {
        await p.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=${C.sedeSlug}&cohort=${C.cohortId}&plan=FULL`);
        await p.goto("/checkout");
        await p.getByLabel("Correo electrónico").fill(mails[i]);
        await p.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
        await p.getByLabel("Nombre", { exact: true }).fill("Médico");
        await p.getByLabel("Apellidos").fill(`Carrera ${i}`);
        await p.getByLabel("Cédula de identidad").fill(`V-1456789${i}`);
        await p.getByLabel("Ciudad (opcional)").fill("Barquisimeto");
        await p.getByLabel("Especialidad").selectOption("Medicina general");
        await p.getByText("Pago Móvil", { exact: true }).click();
      }),
    );
    await Promise.all(pages.map((p) => p.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click()));
    await Promise.all(pages.map((p) => p.waitForLoadState("networkidle").catch(() => {})));
    await expect.poll(() => q(`SELECT o.id FROM "Order" o JOIN OrderItem i ON i.orderId = o.id WHERE i.cohortId = ?`, C.cohortId).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 1500));
    const orders = q<{ id: string; status: string }>(`SELECT o.id, o.status FROM "Order" o JOIN OrderItem i ON i.orderId = o.id WHERE i.cohortId = ?`, C.cohortId);
    const held = q<{ status: string }>(`SELECT status FROM SeatReservation WHERE cohortId = ? AND status IN ('HELD','CONFIRMED')`, C.cohortId);
    expect(held).toHaveLength(1);
    expect(orders.filter((x) => x.status === "PENDING_PAYMENT")).toHaveLength(1);
    expect(cohort(C.cohortId)).toEqual({ capacity: 1, seatsHeld: 1, seatsConfirmed: 0 });
  } finally {
    await Promise.all(ctxs.map((c) => c.close()));
  }
});

// ───────────── utilidades PayPal (checkout real de la tienda) ─────────────

async function buyWithPaypal(page: Page, email: string, cart: string) {
  await page.goto(`/cart/add?${cart}`);
  await page.goto("/checkout");
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill("Ana Lucía");
  await page.getByLabel("Apellidos").fill("Mendoza Torres");
  await page.getByLabel("Cédula de identidad").fill("V-14567890");
  await page.getByLabel("Ciudad (opcional)").fill("Barquisimeto");
  await page.getByLabel("Especialidad").selectOption("Medicina general");
  await page.getByRole("button", { name: "Pagar con PayPal" }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL((u) => u.pathname.startsWith("/pedido/") && !u.pathname.includes("/paypal/"), { timeout: 60_000 });
  const token = new URL(page.url()).pathname.split("/")[2];
  const o = one<{ id: string }>(`SELECT id FROM "Order" WHERE token = ?`, token);
  await waitForOrderStatus(o.id, "ENROLLED", 45_000);
  const pay = one<{ id: string; paypalCaptureId: string; amountUsdCents: number }>(`SELECT id, paypalCaptureId, amountUsdCents FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.id);
  return { orderId: o.id, pay };
}
async function approveInPanel(browser: Browser, orderId: string, ref: string) {
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${orderId}`);
  try {
    await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
  } finally {
    await ctx.close();
  }
}
/** Consume los fallos inyectados que queden en el mock de Moodle (no deben filtrarse a la siguiente prueba). */
async function drainMoodleFailures(request: Parameters<typeof moodleState>[0]) {
  for (let i = 0; i < 20; i++) {
    const r = await request.post(`${MOODLE}/webservice/rest/server.php`, { form: { wstoken: "mock-moodle-token", moodlewsrestformat: "json", wsfunction: "core_course_get_courses_by_field", field: "id", value: "101" } });
    if (r.ok() && !((await r.text()).includes("exception"))) return;
  }
}
const enrolledIn = async (request: Parameters<typeof moodleState>[0], uid: number | null) => (uid == null ? [] : (await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid));

// ───────────── 4. dos pedidos dan el mismo curso ─────────────

test("el médico tiene el curso por dos pedidos: reembolsar el de PayPal con «Desmatricular» no le quita el aula que paga por el otro", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c9dup");
  const a = checkout(C, email);
  const ref = newRef("0134");
  expect((await reportManual(page, a.token, ref, ves(Math.round(a.dueNowCents * RATE)))).get("pago")).toBe("registrado");
  await approveInPanel(browser, a.orderId, ref);
  await waitForOrderStatus(a.orderId, "ENROLLED");
  const uid = customerOf(a.orderId).moodleUserId!;
  expect(await enrolledIn(request, uid)).toEqual([C.moodleCourseId]);

  // Segundo pedido del mismo curso, ONLINE con PayPal, con el correo en mayúsculas → mismo cliente, misma cuenta.
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  let b: Awaited<ReturnType<typeof buyWithPaypal>>;
  try {
    b = await buyWithPaypal(await ctx.newPage(), email.toUpperCase(), `product=${COURSE}&modality=ONLINE&plan=FULL`);
  } finally {
    await ctx.close();
  }
  expect(customerOf(b.orderId).id).toBe(customerOf(a.orderId).id);
  expect(customerOf(b.orderId).moodleUserId).toBe(uid);
  expect((await moodleState(request)).users.filter((u) => u.email.toLowerCase() === email.toLowerCase())).toHaveLength(1);
  expect(await enrolledIn(request, uid)).toEqual([C.moodleCourseId]);

  fixture("refund", { paymentId: b.pay.id, reason: "Compró el curso dos veces", unenroll: true, releaseSeat: true });
  await waitForOrderStatus(b.orderId, "REFUNDED");
  // El pedido A (pago móvil) sigue pagado: el médico conserva el aula y su cupo.
  expect(order(a.orderId).status).toBe("ENROLLED");
  expect(reservationOf(a.orderId).status).toBe("CONFIRMED");
  expect(await enrolledIn(request, uid)).toEqual([C.moodleCourseId]);
  expect(one<{ status: string }>(`SELECT status FROM Enrollment WHERE customerId = ? AND moodleCourseId = ?`, customerOf(a.orderId).id, C.moodleCourseId).status).toBe("ENROLLED");
  const un = events(b.orderId).find((e) => e.type === "UNENROLLMENT");
  expect(JSON.parse(un!.data!)).toMatchObject({ courseIds: [], kept: [C.moodleCourseId] });

  // Y reembolsar también A → ahora sí se desmatricula.
  const pa = one<{ id: string }>(`SELECT id FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, a.orderId);
  fixture("refund", { paymentId: pa.id, reason: "Desiste", unenroll: true, releaseSeat: true });
  await waitForOrderStatus(a.orderId, "REFUNDED");
  expect(await enrolledIn(request, uid)).toEqual([]);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
});

// ───────────── 5. Moodle caído + reembolso antes de que vuelva ─────────────

test("Moodle caído al aprobar y reembolso antes de que vuelva → el job no matricula ni envía el acceso a quien se le devolvió el dinero", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c9mdown");
  const o = checkout(C, email);
  const ref = newRef("0102");
  expect((await reportManual(page, o.token, ref, ves(Math.round(o.dueNowCents * RATE)))).get("pago")).toBe("registrado");
  // Moodle no responde a nada durante un rato.
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { type: "http", status: 503, count: 6 } });
  const since = Date.now();
  await approveInPanel(browser, o.orderId, ref);
  expect(order(o.orderId).status).toBe("PAID");
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");

  const pm = one<{ id: string }>(`SELECT id FROM Payment WHERE orderId = ?`, o.orderId);
  try {
    fixture("refund", { paymentId: pm.id, reason: "Ya no puede asistir", unenroll: true, releaseSeat: true });
  } catch (e) {
    // La desmatrícula puede fallar con Moodle caído; el reembolso igual debe quedar aplicado.
    console.log("refund con Moodle caído:", String(e).slice(0, 300));
  }
  expect(order(o.orderId).status).toBe("REFUNDED");
  expect(reservationOf(o.orderId).status).toBe("RELEASED");

  // Moodle vuelve; el job de matrículas corre varias veces, ya vencido el backoff (reintentos cada 5 s, 10 s…).
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(8_000);
    await runCron(request, "enrollments");
  }
  const uid = customerOf(o.orderId).moodleUserId;
  expect(await enrolledIn(request, uid)).toEqual([]);
  if (uid != null) expect(enrolCallsFor((await moodleCalls(request)).filter((c) => c.at >= since), uid).length === 0 || (await enrolledIn(request, uid)).length === 0).toBe(true);
  expect(templates(o.orderId)).not.toContain("platform_access");
  expect(templates(o.orderId)).not.toContain("cohort_details");
  expect(templates(o.orderId).filter((t) => t === "refund_issued")).toHaveLength(1);
  expect(q<{ status: string }>(`SELECT e.status FROM Enrollment e WHERE e.customerId = ?`, customerOf(o.orderId).id).every((e) => e.status !== "ENROLLED")).toBe(true);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
});
test.afterEach(async ({ request }) => {
  await drainMoodleFailures(request);
});

// ───────────── 6. PAYMENT.CAPTURE.COMPLETED reentregado tras el reembolso ─────────────

test("tras reembolsar desde el panel, PayPal reentrega PAYMENT.CAPTURE.COMPLETED (original y nuevo) → nada revive", async ({ page, request }) => {
  const C = newCohort(3);
  const b = await buyWithPaypal(page, uniqueEmail("x2c9replay"), `product=${COURSE}&modality=SEMIPRESENCIAL&sede=${C.sedeSlug}&cohort=${C.cohortId}&plan=FULL`);
  // Un PAYMENT.CAPTURE.COMPLETED firmado de ANTES del reembolso (PayPal lo reintenta tal cual si no vio un 2xx).
  const original = await resendCaptureWebhook(request, b.pay.paypalCaptureId);
  expect(original.status).toBe(200);
  fixture("refund", { paymentId: b.pay.id, reason: "Desiste", unenroll: true, releaseSeat: true });
  await waitForOrderStatus(b.orderId, "REFUNDED");
  const uid = customerOf(b.orderId).moodleUserId!;
  await expect.poll(() => templates(b.orderId).filter((t) => t === "refund_issued").length).toBe(1);
  const mailsBefore = templates(b.orderId).length;
  const eventsBefore = events(b.orderId).length;
  const since = Date.now();

  const r = await replayWebhook(request, { event: original.event, headers: original.headers });
  expect(r.status).toBeLessThan(500);
  const fresh = await resendCaptureWebhook(request, b.pay.paypalCaptureId);
  expect(fresh.status).toBeLessThan(500);
  await runCron(request, "paypal,enrollments");

  expect(order(b.orderId)).toMatchObject({ status: "REFUNDED", amountPaidCents: 0, balanceCents: 0 });
  expect(one<{ status: string; refundedCents: number }>(`SELECT status, refundedCents FROM Payment WHERE id = ?`, b.pay.id)).toEqual({ status: "REFUNDED", refundedCents: b.pay.amountUsdCents });
  expect(reservationOf(b.orderId).status).toBe("RELEASED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  expect(await enrolledIn(request, uid)).toEqual([]);
  expect(enrolCallsFor((await moodleCalls(request)).filter((c) => c.at >= since), uid)).toEqual([]);
  expect(templates(b.orderId).length).toBe(mailsBefore);
  const newEvents = events(b.orderId).slice(eventsBefore).map((e) => e.type);
  expect(newEvents.filter((t) => ["PAYMENT_RECEIVED", "STATUS_CHANGE", "ENROLLMENT", "SEAT_REACQUIRED"].includes(t))).toEqual([]);
});

// ───────────── 7. el panel dice «cubre» a un pago corto ─────────────

// Antes: PaymentCard.tsx daba por cubierto un faltante de hasta max($1, 1 %) y verifyPayment respondía «El pedido quedó
// pagado y se inició la matrícula» aunque el servidor (que exige el primer pago completo) deja el pedido
// PENDING_PAYMENT sin matrícula. Ahora el panel muestra el faltante y el toast sale del estado real del pedido.
test("pago móvil 0,5 % corto (misma tasa): el panel no debe decir «El monto cubre» ni «el pedido quedó pagado» si no se matricula", async ({ browser, page }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("x2c9tol"));
  const ref = newRef("0171");
  expect((await reportManual(page, o.token, ref, ves(Math.round(o.dueNowCents * 0.995 * RATE)))).get("pago")).toBe("registrado");
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    const card = admin.getByTestId("payment").filter({ hasText: ref });
    const checks = card.getByRole("list", { name: "Comprobaciones" });
    await expect(checks).toBeVisible();
    const covers = await checks.getByText("El monto cubre").count();
    await expect(checks).toContainText(/Faltan \$\d+\.\d{2}: se esperaba/);
    await card.getByRole("button", { name: "Aprobar pago" }).click();
    const toast = admin.getByRole("status").or(admin.getByRole("alert")).filter({ hasText: /pago/i }).last();
    await expect(toast).toBeVisible();
    const toastText = (await toast.textContent()) ?? "";
    await waitForOrderStatus(o.orderId, ["PENDING_PAYMENT", "ENROLLED"]);
    const status = order(o.orderId).status;
    console.log(JSON.stringify({ covers, toastText, status }));
    // El servidor exige el primer pago completo: el pedido queda sin pagar, y el panel lo dice ANTES y DESPUÉS de aprobar.
    expect(status).toBe("PENDING_PAYMENT");
    expect(covers, "el panel dijo «El monto cubre» y el pedido quedó sin pagar").toBe(0);
    expect(toastText).not.toMatch(/quedó pagado|se inició la matrícula/);
    expect(toastText).toMatch(/no cubre el primer pago: faltan \$\d+\.\d{2}/);
    expect(reservationOf(o.orderId).status).toBe("HELD");
  } finally {
    await ctx.close();
  }
});
