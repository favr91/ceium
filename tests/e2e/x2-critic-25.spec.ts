// x2 critic 25 — sondas nuevas por HTTP/UI contra el carril (app + mocks), mirando el resultado REAL (BD, mock de
// Moodle, mock de PayPal, bandeja de correos):
//   1. Moodle tarda en crear la cuenta al aprobar el pago móvil; impaciente, otro admin pulsa «Rematricular» dos
//      veces desde otra pestaña y el job corre a la vez → una cuenta de Moodle, una matrícula, un correo con
//      contraseña temporal, pedido inscrito y cupo ocupado; nada FAILED ni ATTENTION.
//      ROTO antes: la llamada que llegaba segunda (su updateMany no cambiaba ninguna fila) igual enviaba un segundo
//      «Ya estás inscrito… usa la contraseña que ya tienes» (course_access) del mismo curso. CORREGIDO en
//      enrollment.ts: solo se avisa de los cursos que esa llamada matriculó (o si creó la cuenta).
//   2. Doble clic real en «Aprobar pago» y, en un pedido PayPal, doble clic en «Reembolsar» con Moodle lento al
//      desmatricular y el job corriendo → un pago imputado, un reembolso en PayPal, una desmatrícula, el cupo
//      liberado una vez y un correo de cada.
//   3. Comprobante PDF de 9,9 MB (se anuncian 10 MB) por /pedido/<token> → se registra y el panel lo sirve byte a byte.
//   4. El médico envía el comprobante mientras el admin cancela el pedido → nunca «cancelado» con un pago en
//      verificación (ni un pago en verificación en un pedido cancelado) y el cupo cuadra.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-25.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, events, fixture, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { todayCaracas } from "./support/dates";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(240_000);

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
/** PDF válido rellenado con un comentario hasta `bytes` (una foto escaneada «pesada»). */
function bigPdf(bytes: number): Buffer {
  const head = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n");
  const tail = Buffer.from("\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const pad = Buffer.alloc(bytes - head.length - tail.length, 0x25); // '%' (comentario)
  for (let i = 1000; i < pad.length; i += 1000) pad[i] = 0x0a;
  return Buffer.concat([head, pad, tail]);
}
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c25 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod: string) => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newRef = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

async function fillManual(page: Page, token: string, reference: string, amountBs: number, proof: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(reference);
  await page.getByLabel(/Monto pagado/).fill(ves(amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles(proof);
}
async function payManual(page: Page, token: string, reference: string, amountBs: number, proof = { name: "comprobante.png", mimeType: "image/png", buffer: proofPng() }) {
  await fillManual(page, token, reference, amountBs, proof);
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/, { timeout: 60_000 });
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
async function moodleUsersByEmail(email: string) {
  const st = (await (await fetch(`${MOODLE}/__mock/state`)).json()) as { users: { id: number; email: string; password: string | null; deleted: number }[]; enrolments: { userid: number; courseid: number; status: number }[] };
  const users = st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase() && !u.deleted);
  return { users, enrolments: st.enrolments.filter((e) => users.some((u) => u.id === e.userid)) };
}
const failNext = (body: Record<string, unknown>) => fetch(`${MOODLE}/__mock/fail-next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Reservas vivas vs contadores de la cohorte. */
function seatInvariant(cohortId: string) {
  const c = cohort(cohortId);
  const r = one<{ held: number; conf: number }>(`SELECT SUM(status='HELD') AS held, SUM(status='CONFIRMED') AS conf FROM SeatReservation WHERE cohortId = ?`, cohortId);
  expect({ held: c.seatsHeld, conf: c.seatsConfirmed }).toEqual({ held: r.held ?? 0, conf: r.conf ?? 0 });
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

test("Moodle lento al crear la cuenta; «Rematricular» ×2 desde otra pestaña y el job a la vez → una cuenta, una matrícula, una contraseña", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c25slow");
  const o = checkout(C, email, "PAGO_MOVIL");
  const ref = newRef("0134");
  expect((await payManual(page, o.token, ref, Math.round(o.dueNowCents * RATE))).get("pago")).toBe("registrado");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");

  const a = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  const b = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    await failNext({ wsfunction: "core_user_create_users", type: "ok", delayMs: 7000 });
    const approve = a.page.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    // En cuanto el pago queda imputado (pedido PAID, matrícula en curso), el otro admin rematricula dos veces.
    await waitForOrderStatus(o.orderId, ["PAID", "ENROLLED"], 20_000);
    await b.page.reload();
    const storm = (async () => {
      for (let k = 0; k < 2; k++) {
        await b.page.getByRole("button", { name: "Rematricular", exact: true }).first().click();
        await b.page.getByRole("dialog").getByRole("button", { name: "Rematricular" }).click();
        await b.page.waitForTimeout(300);
      }
    })();
    const crons = Promise.all([0, 1, 2].map(() => runCron(request, "enrollments")));
    await Promise.allSettled([approve, storm, crons]);
    await expect(a.page.getByRole("status").filter({ hasText: /Pago aprobado/ })).toBeVisible({ timeout: 30_000 });
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
  await waitForOrderStatus(o.orderId, "ENROLLED", 60_000);
  await runCron(request, "enrollments");

  const m = await moodleUsersByEmail(email);
  const snapshot = {
    moodleUsers: m.users.length,
    enrolments: m.enrolments.map((e) => e.courseid),
    rows: q(`SELECT e.status, e.moodleUserId FROM Enrollment e JOIN "Order" o ON o.customerId = e.customerId WHERE o.id = ?`, o.orderId),
    linked: customerOf(o.orderId).moodleUserId,
    seat: reservationOf(o.orderId).status,
    withPassword: emails(o.orderId).filter((e) => e.template === "platform_access" && e.secretRef).length,
    access: emails(o.orderId).filter((e) => e.template === "platform_access").map((e) => e.dedupeKey),
    approved: emails(o.orderId).filter((e) => e.template === "payment_approved").length,
    attention: events(o.orderId, "ATTENTION").map((e) => e.note),
    failed: events(o.orderId, "ENROLLMENT_FAILED").map((e) => e.note),
  };
  console.log(JSON.stringify(snapshot, null, 1));
  expect(snapshot.moodleUsers).toBe(1);
  expect(snapshot.linked).toBe(m.users[0].id);
  expect(snapshot.enrolments).toEqual([C.moodleCourseId]);
  expect(snapshot.rows).toEqual([{ status: "ENROLLED", moodleUserId: m.users[0].id }]);
  expect(snapshot.seat).toBe("CONFIRMED");
  expect(snapshot.withPassword).toBe(1);
  // Un solo «Ya estás inscrito» (con la contraseña): la llamada que llega segunda no avisa otra vez del mismo curso.
  expect(snapshot.access).toEqual([`platform_access:${o.orderId}`]);
  expect(snapshot.approved).toBe(1);
  expect(snapshot.attention).toEqual([]);
  seatInvariant(C.cohortId);
});

test("doble clic real en «Aprobar pago» y en «Reembolsar» (PayPal, Moodle lento al desmatricular, job a la vez) → todo una sola vez", async ({ browser, page, request }) => {
  const C = newCohort(3);
  // Pago móvil: doble clic en «Aprobar pago».
  const e1 = uniqueEmail("x2c25dbl");
  const o1 = checkout(C, e1, "PAGO_MOVIL");
  const ref = newRef("0102");
  expect((await payManual(page, o1.token, ref, Math.round(o1.dueNowCents * RATE))).get("pago")).toBe("registrado");
  const a = await adminLogin(browser, `/admin/orders/${o1.orderId}`);
  try {
    await a.page.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).dblclick();
    await waitForOrderStatus(o1.orderId, "ENROLLED", 45_000);
  } finally {
    await a.ctx.close();
  }
  expect(order(o1.orderId)).toMatchObject({ amountPaidCents: o1.dueNowCents, balanceCents: 0 });
  expect(events(o1.orderId, "PAYMENT_RECEIVED")).toHaveLength(1);
  expect(emails(o1.orderId).filter((e) => e.template === "payment_approved")).toHaveLength(1);

  // PayPal: compra y doble clic en «Reembolsar» con Moodle lento y el job corriendo.
  const e2 = uniqueEmail("x2c25dblpp");
  const o2 = checkout(C, e2, "PAYPAL");
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  try {
    await payPaypal(await ctx.newPage(), o2.token);
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(o2.orderId, "ENROLLED", 45_000);
  const before = cohort(C.cohortId);
  const pay = one<{ id: string; paypalCaptureId: string; amountCents: number }>(`SELECT id, paypalCaptureId, amountCents FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o2.orderId);
  const ppBefore = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds: unknown }).refunds;
  const countRefunds = (x: unknown) => (Array.isArray(x) ? x : Object.values((x ?? {}) as object)).filter((r) => JSON.stringify(r).includes(pay.paypalCaptureId)).length;
  expect(countRefunds(ppBefore)).toBe(0);

  const r = await adminLogin(browser, `/admin/orders/${o2.orderId}`);
  try {
    await failNext({ wsfunction: "enrol_manual_unenrol_users", type: "ok", delayMs: 5000 });
    const card = r.page.getByTestId("payment").filter({ hasText: "PayPal" });
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await form.getByLabel("Motivo").fill("No podrá asistir");
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    const click = form.getByRole("button", { name: "Reembolsar" }).dblclick();
    const crons = Promise.all([0, 1, 2].map(() => runCron(request, "paypal,expire,enrollments,emails")));
    await Promise.allSettled([click, crons]);
    await waitForOrderStatus(o2.orderId, "REFUNDED", 45_000);
  } finally {
    await r.ctx.close();
  }
  await expect.poll(async () => (await moodleUsersByEmail(e2)).enrolments.length, { timeout: 30_000 }).toBe(0);
  await runCron(request, "paypal,expire,enrollments,emails");
  const after = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds: unknown }).refunds;
  const snapshot = {
    paypalRefunds: countRefunds(after),
    refundRows: q(`SELECT status, amountCents FROM Refund WHERE paymentId = ?`, pay.id),
    order: order(o2.orderId).status,
    seat: reservationOf(o2.orderId).status,
    cohortDelta: cohort(C.cohortId).seatsConfirmed - before.seatsConfirmed,
    refundMails: emails(o2.orderId).filter((e) => e.template === "refund_issued").length,
    seatReleasedEvents: events(o2.orderId, "SEAT_RELEASED").length,
    enrollment: q(`SELECT e.status FROM Enrollment e JOIN "Order" o ON o.customerId = e.customerId WHERE o.id = ?`, o2.orderId),
    attention: events(o2.orderId, "ATTENTION").map((e) => e.note),
  };
  console.log(JSON.stringify(snapshot, null, 1));
  expect(snapshot.paypalRefunds).toBe(1);
  expect(snapshot.refundRows).toEqual([{ status: "COMPLETED", amountCents: pay.amountCents }]);
  expect(snapshot.order).toBe("REFUNDED");
  expect(snapshot.seat).toBe("RELEASED");
  expect(snapshot.cohortDelta).toBe(-1);
  expect(snapshot.refundMails).toBe(1);
  expect(snapshot.seatReleasedEvents).toBe(1);
  expect(snapshot.enrollment).toEqual([{ status: "UNENROLLED" }]);
  seatInvariant(C.cohortId);
});

test("comprobante PDF de 9,9 MB por /pedido/<token> → registrado y el panel lo sirve byte a byte", async ({ browser, page }) => {
  const C = newCohort(3);
  const o = checkout(C, uniqueEmail("x2c25big"), "PAGO_MOVIL");
  const pdf = bigPdf(Math.floor(9.9 * 1024 * 1024));
  const ref = newRef("0105");
  const res = await payManual(page, o.token, ref, Math.round(o.dueNowCents * RATE), { name: "estado-de-cuenta.pdf", mimeType: "application/pdf", buffer: pdf });
  expect(res.get("pago"), res.get("motivo") ?? "").toBe("registrado");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  const p = one<{ id: string }>(`SELECT id FROM Payment WHERE orderId = ? AND status = 'AWAITING_VERIFICATION'`, o.orderId);
  const a = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    const r = await a.page.request.get(`/admin/orders/${o.orderId}/comprobante/${p.id}`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");
    expect(Buffer.compare(await r.body(), pdf)).toBe(0);
  } finally {
    await a.ctx.close();
  }
});

test("el médico envía el comprobante mientras el admin cancela el pedido → nunca cancelado con un pago en verificación", async ({ browser, page }) => {
  const C = newCohort(3);
  for (let round = 0; round < 3; round++) {
    const o = checkout(C, uniqueEmail(`x2c25cxl${round}`), "PAGO_MOVIL");
    const ref = newRef(`01${round}9`);
    await fillManual(page, o.token, ref, Math.round(o.dueNowCents * RATE), { name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
    const a = await adminLogin(browser, `/admin/orders/${o.orderId}`);
    try {
      await a.page.getByRole("button", { name: "Más acciones" }).click();
      const cancelItem = a.page.getByRole("menuitem", { name: /Cancelar pedido/ });
      if ((await cancelItem.count()) === 0) test.skip(true, "el panel no ofrece cancelar pedidos desde el menú");
      await cancelItem.click();
      const dlg = a.page.getByRole("dialog");
      const reason = dlg.getByRole("textbox");
      if (await reason.count()) await reason.first().fill("Duplicado");
      const confirm = dlg.getByRole("button", { name: /Cancelar pedido/ });
      await Promise.allSettled([page.getByRole("button", { name: "Enviar datos del pago" }).click(), confirm.click()]);
      await page.waitForURL(/[?&]pago=(registrado|error)/, { timeout: 60_000 }).catch(() => {});
      await a.page.waitForTimeout(1500);
    } finally {
      await a.ctx.close();
    }
    const st = order(o.orderId).status;
    const awaiting = q(`SELECT id FROM Payment WHERE orderId = ? AND status = 'AWAITING_VERIFICATION'`, o.orderId).length;
    const res = reservationOf(o.orderId).status;
    console.log(JSON.stringify({ round, st, awaiting, res }));
    if (st === "CANCELLED") {
      expect(awaiting).toBe(0);
      expect(res).toBe("RELEASED");
      expect(emails(o.orderId).filter((e) => e.template === "payment_under_verification")).toHaveLength(0);
    } else {
      expect(st).toBe("AWAITING_VERIFICATION");
      expect(awaiting).toBe(1);
      expect(res).toBe("HELD");
    }
    seatInvariant(C.cohortId);
  }
});
