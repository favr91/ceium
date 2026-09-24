// x2 critic 15 — sondas adversariales nuevas contra pago móvil → verificación → Moodle → cupo → correos y el
// reembolso PayPal, por HTTP contra el carril (app + mocks). Cada sonda mira el resultado REAL: BD, mock de
// PayPal (órdenes, capturas, reembolsos), mock de Moodle y bandeja de correos.
//   1. Pedido YA PAGADO con pago móvil (aprobado, inscrito) y una orden PayPal vieja del mismo pedido que el médico
//      aprueba DESPUÉS en la otra pestaña (retorno, webhook CHECKOUT.ORDER.APPROVED o conciliación): no se debe
//      capturar — cobrar y reembolsar le duplica el cargo al médico y la comisión de PayPal no se devuelve.
//   2. Las acciones del panel (aprobar / reembolsar) reenviadas por HTTP sin sesión o con la sesión cerrada no
//      cambian nada.
//   3. Reembolso PayPal con el token OAuth revocado: un solo reembolso en PayPal, cupo liberado, desmatrícula.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-15.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page, type Request as PwRequest } from "@playwright/test";
import { PAYPAL, cohort, customerOf, emails, fixture, moodleState, one, order, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { e2eEnv } from "../../playwright.config";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c15 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAGO_MOVIL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bs = (usdCents: number) => Math.round(usdCents * RATE);
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();

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
async function startPaypal(page: Page, token: string): Promise<string> {
  await page.goto(`/pedido/${token}`);
  const pay = page.getByRole("button", { name: /con PayPal/ });
  await expect(pay).toBeVisible();
  await pay.click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  return new URL(page.url()).searchParams.get("token")!;
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
async function approveInPanel(admin: Page, o: Placed, ref: string) {
  await admin.goto(`/admin/orders/${o.orderId}`);
  await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible({ timeout: 60_000 });
}
type PPState = {
  orders: { id: string; status: string }[];
  captures: Record<string, { id: string; orderId?: string; order_id?: string; status: string }> | { id: string; status: string }[];
  refunds: Record<string, unknown> | unknown[];
};
async function ppState(request: APIRequestContext): Promise<PPState> {
  return (await request.get(`${PAYPAL}/__mock/state`)).json();
}
const listOf = <T,>(x: Record<string, T> | T[] | undefined): T[] => (Array.isArray(x) ? x : Object.values(x ?? {}));
const paymentRows = (orderId: string) =>
  q<{ id: string; method: string; status: string; providerStatus: string | null; amountUsdCents: number; refundedCents: number; paypalOrderId: string | null; paypalCaptureId: string | null; reference: string | null }>(
    `SELECT id, method, status, providerStatus, amountUsdCents, refundedCents, paypalOrderId, paypalCaptureId, reference FROM Payment WHERE orderId = ? ORDER BY createdAt`,
    orderId,
  );
const liveHeld = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
const liveConfirmed = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: liveHeld(cohortId), confirmed: liveConfirmed(cohortId) });
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
}

/** Pedido pagado con pago móvil (aprobado en el panel) que además tiene una orden PayPal abierta en otra pestaña. */
async function paidByPagoMovilWithStalePaypal(browser: Browser, page: Page, tag: string) {
  const C = newCohort(3);
  const email = uniqueEmail(tag);
  const o = checkout(C, email);
  const ctxPP = await browser.newContext({ locale: "es-VE" });
  const pp = await startPaypal(await ctxPP.newPage(), o.token);
  await ctxPP.close();
  const ref = newRef("0102");
  const r = await reportManual(page, o.token, { reference: ref, amountBs: bs(o.dueNowCents) });
  expect(r.get("pago"), r.get("motivo") ?? "").toBe("registrado");
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await approveInPanel(admin, o, ref);
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(o.orderId, "ENROLLED");
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.totalCents, balanceCents: 0 });
  return { C, o, pp, email };
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
    /* valor previo no válido: se queda el de esta corrida */
  }
});

// ───────────── 1. pedido ya pagado con pago móvil + orden PayPal vieja aprobada después ─────────────

for (const via of ["retorno", "webhook", "conciliación"] as const) {
  test(`pedido pagado con pago móvil; el médico aprueba después la orden PayPal vieja (${via}) → NO se cobra (ni se cobra y reembolsa)`, async ({ browser, page, request }) => {
    const { C, o, pp } = await paidByPagoMovilWithStalePaypal(browser, page, `c15${via.slice(0, 3)}`);
    const mailsBefore = emails(o.orderId).length;
    const enrolBefore = (await moodleState(request)).enrolments.length;

    if (via === "retorno") {
      const a = await (await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`)).json();
      const r = await request.get(a.redirect, { maxRedirects: 0 });
      expect(r.status()).toBeGreaterThanOrEqual(300);
      // El médico vuelve a su pedido con «no lo cobramos» (no «PayPal no aprobó el pago»).
      expect(r.headers()["location"] ?? "").toContain("paypal=no-cobrado");
      // Recargar el retorno tampoco cobra.
      await request.get(a.redirect, { maxRedirects: 0 });
    } else {
      // Sin volver a la tienda: PayPal envía CHECKOUT.ORDER.APPROVED (webhook) o el job concilia la orden aprobada.
      await request.post(`${PAYPAL}/__mock/config`, { data: { webhookTarget: `${e2eEnv.APP_URL}/api/webhooks/paypal`, approvalWebhooks: via === "webhook", autoWebhooks: true, webhookDelayMs: 0 } });
      try {
        await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`);
        if (via === "conciliación") await runCron(request, "paypal");
        else await expect.poll(async () => (await ppState(request)).orders.find((x) => x.id === pp)?.status, { timeout: 15_000 }).toBeTruthy();
      } finally {
        await request.post(`${PAYPAL}/__mock/config`, { data: { webhookTarget: `${e2eEnv.APP_URL}/api/webhooks/paypal`, approvalWebhooks: true, autoWebhooks: true, webhookDelayMs: 0 } });
      }
      await runCron(request, "paypal");
    }
    // Dejar llegar webhooks automáticos (COMPLETED/REFUNDED) si hubo captura.
    await page.waitForTimeout(1500);

    const st = await ppState(request);
    const ppOrder = st.orders.find((x) => x.id === pp);
    const captured = listOf<unknown>(st.captures as never).filter((c) => JSON.stringify(c).includes(pp));
    const pays = paymentRows(o.orderId);
    const paypalPay = pays.find((p) => p.method === "PAYPAL")!;
    // El resultado que importa: al médico NO se le cobró otra vez.
    expect(ppOrder?.status, `orden PayPal ${pp}: ${JSON.stringify({ ppOrder, captured, paypalPay })}`).not.toBe("COMPLETED");
    expect(captured, "ninguna captura en PayPal para la orden vieja").toHaveLength(0);
    expect(paypalPay.paypalCaptureId).toBeNull();
    expect(paypalPay.status).not.toBe("COMPLETED");
    expect(paypalPay.status).not.toBe("REFUNDED");
    // El pedido sigue igual: inscrito, pagado una vez, un cupo, sin correos nuevos de cobro/reembolso.
    expect(order(o.orderId)).toMatchObject({ status: "ENROLLED", amountPaidCents: o.totalCents, balanceCents: 0 });
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expectCohortConsistent(C.cohortId);
    const newMails = emails(o.orderId).slice(mailsBefore).map((m) => m.template);
    expect(newMails.filter((t) => /refund|order_confirmation|payment_approved/.test(t)), newMails.join(",")).toEqual([]);
    expect((await moodleState(request)).enrolments.length).toBe(enrolBefore);
  });
}

// ───────────── 2. acciones del panel reenviadas sin sesión ─────────────

test("aprobar y reembolsar reenviados por HTTP sin sesión o tras cerrar sesión → nada cambia", async ({ browser, page, request }) => {
  const C = newCohort(3);
  // A: pedido con pago móvil en verificación (se aprueba en el panel para capturar la acción).
  const oA = checkout(C, uniqueEmail("c15capA"));
  const refA = newRef("0105");
  expect((await reportManual(page, oA.token, { reference: refA, amountBs: bs(oA.dueNowCents) })).get("pago")).toBe("registrado");
  // B: otro pedido en verificación: objetivo del reenvío.
  const oB = checkout(C, uniqueEmail("c15capB"));
  const refB = newRef("0108");
  expect((await reportManual(page, oB.token, { reference: refB, amountBs: bs(oB.dueNowCents) })).get("pago")).toBe("registrado");
  const payB = paymentRows(oB.orderId).find((p) => p.method === "PAGO_MOVIL")!;
  const payA = paymentRows(oA.orderId).find((p) => p.method === "PAGO_MOVIL")!;

  const { ctx, page: admin } = await adminLogin(browser);
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  const onReq = (r: PwRequest) => {
    const h = r.headers();
    if (r.method() === "POST" && h["next-action"] && (r.postData() ?? "").includes(payA.id)) captured = { url: r.url(), headers: h, body: r.postData() ?? "" };
  };
  admin.on("request", onReq);
  try {
    await approveInPanel(admin, oA, refA);
  } finally {
    admin.off("request", onReq);
  }
  expect(captured, "se capturó la llamada de la acción «Aprobar pago»").not.toBeNull();
  const cap = captured!;
  const forged = cap.body.split(oA.orderId).join(oB.orderId).split(payA.id).join(payB.id);
  expect(forged).toContain(payB.id);
  const headers = Object.fromEntries(Object.entries(cap.headers).filter(([k]) => !["cookie", "content-length", "host"].includes(k.toLowerCase())));

  // 1) Sin cookie de sesión.
  const anon = await request.fetch(cap.url, { method: "POST", headers, data: forged, maxRedirects: 0 });
  expect(anon.status()).toBeLessThan(500);
  expect(paymentRows(oB.orderId).find((p) => p.id === payB.id)?.status, `sin sesión: HTTP ${anon.status()} ${(await anon.text()).slice(0, 300)}`).toBe("AWAITING_VERIFICATION");
  // 2) Con la cookie de una sesión cerrada.
  const cookies = await ctx.cookies();
  await admin.goto("/admin");
  await admin.locator("button.adm-user-btn").click();
  await admin.getByRole("menuitem", { name: /Cerrar sesión/ }).click();
  await admin.waitForURL(/\/admin\/login/);
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const stale = await request.fetch(cap.url, { method: "POST", headers: { ...headers, cookie: cookieHeader }, data: forged, maxRedirects: 0 });
  expect(stale.status()).toBeLessThan(500);
  expect(paymentRows(oB.orderId).find((p) => p.id === payB.id)?.status, `sesión cerrada: HTTP ${stale.status()} ${(await stale.text()).slice(0, 300)}`).toBe("AWAITING_VERIFICATION");
  await ctx.close();

  expect(paymentRows(oB.orderId).find((p) => p.id === payB.id)?.status).toBe("AWAITING_VERIFICATION");
  expect(order(oB.orderId)).toMatchObject({ status: "AWAITING_VERIFICATION", amountPaidCents: 0 });
  expect(reservationOf(oB.orderId).status).toBe("HELD");
  expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND actorType = 'ADMIN'`, oB.orderId)).toHaveLength(0);
  expect(emails(oB.orderId).map((m) => m.template)).not.toContain("payment_approved");
  expect(customerOf(oB.orderId).moodleUserId).toBeNull();
  expectCohortConsistent(C.cohortId);
});

// ───────────── 3. reembolso PayPal con el token OAuth revocado ─────────────

test("reembolso PayPal desde el panel con el token OAuth revocado → un reembolso en PayPal, cupo libre, desmatrícula y correo", async ({ browser, request }) => {
  const C = newCohort(2);
  const o = checkout(C, uniqueEmail("c15tok"), "PAYPAL");
  const ctxP = await browser.newContext({ locale: "es-VE" });
  const pp = await startPaypal(await ctxP.newPage(), o.token);
  await ctxP.close();
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`)).json();
  await request.get(a.redirect, { maxRedirects: 0 });
  await waitForOrderStatus(o.orderId, "ENROLLED");
  const cust = customerOf(o.orderId);
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === cust.moodleUserId && e.courseid === C.moodleCourseId)).toHaveLength(1);
  const pay = paymentRows(o.orderId).find((p) => p.method === "PAYPAL" && p.status === "COMPLETED")!;
  const refundsBefore = listOf((await ppState(request)).refunds as never).length;

  expect((await request.post(`${PAYPAL}/__mock/revoke-tokens`)).ok()).toBe(true);
  const { ctx, page: admin } = await adminLogin(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    const card = admin.getByTestId("payment").filter({ hasText: "PayPal" });
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await form.getByLabel("Motivo").fill("Prueba con token revocado.");
    await expect(form.getByRole("checkbox", { name: /Desmatricular de Moodle/ })).toBeChecked();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Reembolso completado" })).toBeVisible({ timeout: 60_000 });
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(o.orderId, "REFUNDED");
  const refunds = listOf((await ppState(request)).refunds as never) as { status: string; links?: { href: string }[] }[];
  expect(refunds.length - refundsBefore).toBe(1);
  expect(paymentRows(o.orderId).find((p) => p.id === pay.id)).toMatchObject({ status: "REFUNDED", refundedCents: pay.amountUsdCents });
  expect(reservationOf(o.orderId).status).toBe("RELEASED");
  expectCohortConsistent(C.cohortId);
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === cust.moodleUserId && e.courseid === C.moodleCourseId && e.status === 0)).toHaveLength(0);
  expect(emails(o.orderId).filter((m) => m.template === "refund_issued")).toHaveLength(1);
  const ev = q<{ type: string; actorType: string; actorId: string | null }>(`SELECT type, actorType, actorId FROM OrderEvent WHERE orderId = ? AND type IN ('REFUND_REQUESTED','REFUND','SEAT_RELEASED','UNENROLLMENT')`, o.orderId);
  expect(ev.map((e) => e.type).sort()).toEqual(["REFUND", "REFUND_REQUESTED", "SEAT_RELEASED", "UNENROLLMENT"]);
  expect(ev.every((e) => e.actorType === "ADMIN" && e.actorId)).toBe(true);
});
