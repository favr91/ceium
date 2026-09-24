// Crítico x3 (ronda 3) — ataques nuevos por HTTP contra el carril (E2E_LANE=e2e-cert E2E_PORT=3105):
//   L. Carrera en el vencimiento, 3 rondas: cohorte de 1 cupo; la reserva PayPal de A vence mientras A vuelve de
//      PayPal (retorno recargado 3 veces) + 3 barridos + 12 compradores nuevos (PayPal y Pago Móvil) a la vez.
//      Nunca: más de 1 cupo, contadores ≠ filas, ni dinero cobrado sin cupo (captura sin reembolso ni reserva).
//   M. Reembolsos a mitad de la estampida: 3 cupos pagados; PayPal reembolsa 2 (webhooks REFUNDED reenviados con
//      otros event id, en paralelo) mientras 30 compradores compiten → a lo sumo 2 ganan, nada se libera dos veces.
//   Q. Monto equivocado: plan «mitad», el saldo se paga con Pago Móvil por MENOS de lo adeudado y el admin lo
//      aprueba → sigue con saldo; 9/9 en Moodle → ni certificado ni correo. Paga el resto → UN certificado.
//   R. /certificados/<código>: minúsculas y espacios verifican el mismo; códigos basura no rompen (404, no 500).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, enrollments, fixture, one, order, paypalConfig, q, runCron, uniqueEmail, waitForOrderStatus, type DiplomaCohort } from "./support/purchase";
import { addToCart, checkoutFormFields, submitCheckout, type CheckoutMethod, type CheckoutOutcome } from "./support/storefront";
import { todayCaracas } from "./support/dates";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor");
});
test.setTimeout(400_000);

const DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";
const SOLD_OUT = /sin cupo/i;
const RATE = 187.25;
const ADMIN_EMAIL = "admin@ceium.net";
const ADMIN_PASSWORD = (() => {
  try {
    return parseDotenv(fs.readFileSync(path.join(__dirname, "../../.env"))).ADMIN_PASSWORD || "ceium-admin-2026";
  } catch {
    return "ceium-admin-2026";
  }
})();
const PAGO_MOVIL = {
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
let settingsBefore: unknown = null;

/** Invariante de cupo en TODAS las cohortes: contadores = filas y nunca por encima de la capacidad. */
function assertSeatInvariant(tag: string) {
  const bad = q(
    `SELECT c.name, c.capacity, c.seatsHeld, c.seatsConfirmed,
       (SELECT count(*) FROM SeatReservation r WHERE r.cohortId = c.id AND r.status = 'HELD') AS held,
       (SELECT count(*) FROM SeatReservation r WHERE r.cohortId = c.id AND r.status = 'CONFIRMED') AS conf
     FROM Cohort c`,
  ).filter((c: any) => c.seatsHeld !== c.held || c.seatsConfirmed !== c.conf || c.seatsHeld + c.seatsConfirmed > c.capacity); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(bad, `${tag}: cohortes con contadores ≠ filas o sobre el cupo`).toEqual([]);
}

/**
 * «Nunca dinero sin cupo»: en la cohorte, todo pedido con dinero neto cobrado (pagos COMPLETED/parcialmente
 * reembolsados, netos de reembolsos) tiene su cupo CONFIRMED; y lo que PayPal tiene capturado neto coincide.
 */
function assertNoMoneyWithoutSeat(tag: string, cohortId: string) {
  const rows = q<{ orderId: string; status: string; net: number; seat: string | null }>(
    `SELECT o.id AS orderId, o.status,
       COALESCE((SELECT sum(p.amountUsdCents - p.refundedCents) FROM Payment p WHERE p.orderId = o.id AND p.status IN ('COMPLETED','PARTIALLY_REFUNDED')), 0) AS net,
       (SELECT r.status FROM SeatReservation r WHERE r.orderId = o.id AND r.cohortId = ?) AS seat
     FROM "Order" o WHERE o.id IN (SELECT orderId FROM SeatReservation WHERE cohortId = ?)`,
    cohortId,
    cohortId,
  );
  const bad = rows.filter((r) => r.net > 0 && r.seat !== "CONFIRMED");
  expect(bad, `${tag}: pedidos con dinero cobrado y sin cupo ocupado`).toEqual([]);
  const paidNoSeat = rows.filter((r) => ["PAID", "PARTIALLY_PAID", "ENROLLED"].includes(r.status) && r.seat !== "CONFIRMED");
  expect(paidNoSeat, `${tag}: pedidos pagados sin cupo`).toEqual([]);
}

async function paypalToken(request: APIRequestContext) {
  const r = await request.post(`${PAYPAL}/v1/oauth2/token`, {
    headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}` },
    form: { grant_type: "client_credentials" },
  });
  return (await r.json()).access_token as string;
}

async function buyer(playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } }, C: DiplomaCohort, tag: string, method: CheckoutMethod) {
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  const add = await addToCart(ctx, { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: C.cohortId, plan: "FULL" });
  return { ctx, add, email: uniqueEmail(tag), method };
}

async function stampede(playwright: Parameters<typeof buyer>[0], C: DiplomaCohort, tag: string, n: number) {
  const bs = await Promise.all(Array.from({ length: n }, (_, i) => buyer(playwright, C, `${tag}${i}`, i % 2 ? "PAGO_MOVIL" : "PAYPAL")));
  const ready = await Promise.all(bs.map(async (b) => ({ ...b, fields: b.add.error ? null : await checkoutFormFields(b.ctx) })));
  return {
    fire: () =>
      Promise.all(
        ready.map(async (b): Promise<{ email: string; method: CheckoutMethod; out: CheckoutOutcome | { ok: false; status: 0; error: string } }> => {
          if (!b.fields) return { email: b.email, method: b.method, out: { ok: false, status: 0, error: `carrito: ${b.add.error}` } };
          const out = await submitCheckout(b.ctx, b.fields, { email: b.email, firstName: "Estampida", lastName: tag, method: b.method });
          return { email: b.email, method: b.method, out };
        }),
      ),
    dispose: () => Promise.all(bs.map((b) => b.ctx.dispose())),
  };
}

const ordersOfEmail = (email: string) => q<{ id: string; status: string; token: string }>(`SELECT o.id, o.status, o.token FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email.toLowerCase());

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});
test.beforeEach(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
});
test.afterAll(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
  if (Array.isArray(settingsBefore)) {
    try {
      fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
    } catch {
      /* valor previo no válido para updateSetting */
    }
  }
});

test("L. vencimiento en plena carrera (3 rondas): retorno de PayPal ×3 + barridos + 12 compradores sobre 1 cupo", async ({ request, playwright }) => {
  for (let round = 0; round < 3; round++) {
    const C = fixture<DiplomaCohort>("diploma-cohort", { capacity: 1, sede: "barquisimeto", name: `Cohorte x3c3L${round} ${Date.now().toString(36)}` });
    const A = await buyer(playwright, C, `x3c3LA${round}`, "PAYPAL");
    expect(A.add.error).toBeNull();
    const outA = await submitCheckout(A.ctx, await checkoutFormFields(A.ctx), { email: A.email, firstName: "Ana", lastName: `Vence ${round}`, method: "PAYPAL" });
    expect(outA.ok, JSON.stringify(outA)).toBe(true);
    if (!outA.ok) throw new Error("checkout A");
    const a = ordersOfEmail(A.email)[0];
    // A aprueba en PayPal pero su retorno llega justo cuando su reserva ya venció (31 min en PayPal).
    const appr = await (await request.post(`${PAYPAL}/__mock/approve/${outA.paypalOrderId}?json=1`)).json();
    fixture("age-order", { orderId: a.id, minutes: 31 });
    const S = await stampede(playwright, C, `x3c3L${round}s`, 12);
    const [returns, , outs] = await Promise.all([
      Promise.all([0, 1, 2].map(() => A.ctx.get(appr.redirect, { maxRedirects: 0 }).then((r) => r.headers()["location"] ?? `HTTP ${r.status()}`))),
      Promise.all([0, 1, 2].map(() => runCron(request, "expire"))),
      S.fire(),
    ]);
    const winners = outs.filter((o) => o.out.ok);
    console.log(`[x3-critic-3 L${round}] retornos A:`, returns.map((u) => new URL(u, e2eEnv.APP_URL).searchParams.get("paypal")).join(","), "ganadores nuevos:", winners.length, "A:", order(a.id).status);
    for (const o of outs.filter((x) => !x.out.ok)) expect(o.out.ok === false && o.out.error, `rechazo claro (${o.email})`).toMatch(SOLD_OUT);
    // Deja que lleguen los webhooks (mock: 50 ms) y reconcilia.
    await new Promise((r) => setTimeout(r, 1500));
    await runCron(request, "expire,paypal");
    assertSeatInvariant(`L${round}`);
    assertNoMoneyWithoutSeat(`L${round}`, C.cohortId);
    const c = cohort(C.cohortId);
    expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(1);
    const aPaid = ["PAID", "ENROLLED"].includes(order(a.id).status);
    // Si A quedó cobrado, nadie más tiene el cupo; si no, a lo sumo un comprador nuevo lo tiene.
    expect(winners.length + (aPaid ? 1 : 0), "compradores con el único cupo").toBeLessThanOrEqual(1);
    // PayPal: capturas netas de A = 0 si A no quedó pagado.
    const st = await (await request.get(`${PAYPAL}/__mock/state`)).json();
    const ppA = st.orders.find((o: { id: string }) => o.id === outA.paypalOrderId);
    const caps = (ppA?.purchase_units?.[0]?.payments?.captures ?? []) as { id: string; status: string }[];
    if (!aPaid) expect(caps.filter((x) => x.status === "COMPLETED"), "A cobrado en PayPal sin cupo ni reembolso").toEqual([]);
    else expect(caps.filter((x) => x.status === "COMPLETED")).toHaveLength(1);
    await A.ctx.dispose();
    await S.dispose();
  }
});

test("M. PayPal reembolsa 2 de 3 cupos pagados (webhooks duplicados en paralelo) mientras 30 compradores compiten", async ({ request, playwright }) => {
  const C = fixture<DiplomaCohort>("diploma-cohort", { capacity: 3, sede: "barquisimeto", name: `Cohorte x3c3M ${Date.now().toString(36)}` });
  // Los 30 arman su carrito y abren el checkout mientras aún hay cupo; confirman cuando ya está lleno.
  const S = await stampede(playwright, C, "x3c3Ms", 30);
  const paid: { orderId: string; captureId: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const B = await buyer(playwright, C, `x3c3Mp${i}`, "PAYPAL");
    const out = await submitCheckout(B.ctx, await checkoutFormFields(B.ctx), { email: B.email, firstName: "Pagado", lastName: `${i}`, method: "PAYPAL" });
    if (!out.ok) throw new Error(JSON.stringify(out));
    const appr = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1`)).json();
    await B.ctx.get(appr.redirect, { maxRedirects: 0 });
    const o = ordersOfEmail(B.email)[0];
    await waitForOrderStatus(o.id, ["PAID", "ENROLLED"], 60_000);
    const cap = one<{ paypalCaptureId: string }>(`SELECT paypalCaptureId FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.id).paypalCaptureId;
    paid.push({ orderId: o.id, captureId: cap });
    await B.ctx.dispose();
  }
  expect(cohort(C.cohortId)).toMatchObject({ seatsConfirmed: 3, seatsHeld: 0 });
  const token = await paypalToken(request);
  const refundAndReplay = async (cap: string) => {
    const r = await request.post(`${PAYPAL}/v2/payments/captures/${cap}/refund`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, data: {} });
    expect(r.status(), await r.text()).toBeLessThan(300);
    // PayPal reenvía el mismo reembolso con event id nuevos, a la vez.
    await Promise.all([0, 1, 2].map(() => request.post(`${PAYPAL}/__mock/send-webhook/${cap}?event_type=PAYMENT.CAPTURE.REFUNDED`)));
  };
  const [outs] = await Promise.all([S.fire(), refundAndReplay(paid[0].captureId), refundAndReplay(paid[1].captureId), runCron(request, "expire"), runCron(request, "expire")]);
  await waitForOrderStatus(paid[0].orderId, "REFUNDED", 30_000);
  await waitForOrderStatus(paid[1].orderId, "REFUNDED", 30_000);
  await new Promise((r) => setTimeout(r, 1500));
  const winners = outs.filter((o) => o.out.ok);
  console.log("[x3-critic-3 M] ganadores durante los reembolsos:", winners.length, "cohorte:", JSON.stringify(cohort(C.cohortId)));
  for (const o of outs.filter((x) => !x.out.ok)) expect(o.out.ok === false && o.out.error, `rechazo claro (${o.email})`).toMatch(SOLD_OUT);
  expect(winners.length).toBeLessThanOrEqual(2);
  assertSeatInvariant("M");
  assertNoMoneyWithoutSeat("M", C.cohortId);
  // Cada reembolso liberó su cupo exactamente una vez.
  for (const p of paid.slice(0, 2)) {
    expect(q(`SELECT id FROM Refund WHERE paymentId IN (SELECT id FROM Payment WHERE orderId = ?)`, p.orderId), "un solo reembolso registrado").toHaveLength(1);
    expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND type = 'SEAT_RELEASED'`, p.orderId), "cupo liberado una vez").toHaveLength(1);
  }
  // El tercero sigue con su cupo; si la estampida terminó antes de los reembolsos, los cupos liberados se venden ahora.
  expect(one<{ status: string }>(`SELECT status FROM SeatReservation WHERE orderId = ?`, paid[2].orderId).status).toBe("CONFIRMED");
  const free = 3 - cohort(C.cohortId).seatsConfirmed - cohort(C.cohortId).seatsHeld;
  expect(free).toBe(2 - winners.length);
  if (free > 0) {
    const L = await stampede(playwright, C, "x3c3Ml", 6);
    const late = await L.fire();
    expect(late.filter((o) => o.out.ok)).toHaveLength(free);
    await L.dispose();
  }
  assertSeatInvariant("M final");
  expect(cohort(C.cohortId).seatsHeld + cohort(C.cohortId).seatsConfirmed).toBe(3);
  await S.dispose();
});

// ───────────── Q: saldo pagado con monto equivocado ─────────────

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
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function reportManual(page: Page, url: string, reference: string, amountBsCents: number) {
  await page.goto(url);
  await page.getByText("Pago Móvil", { exact: true }).first().click();
  await page.getByLabel("Número de referencia").fill(reference);
  await page.getByLabel(/Monto pagado/).fill(ves(amountBsCents));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  const u = new URL(page.url());
  expect(u.searchParams.get("pago"), u.searchParams.get("motivo") ?? "").toBe("registrado");
}

async function approveInPanel(browser: Browser, orderId: string, ref: string) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`/admin/login?next=${encodeURIComponent("/admin/orders")}`);
    await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
    await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL((u) => u.pathname === "/admin/orders");
    await page.goto(`/admin/orders/${orderId}`);
    await page.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta/i }).last();
    await toast.waitFor({ timeout: 30_000 });
    return (await toast.textContent()) ?? "";
  } finally {
    await ctx.close();
  }
}

test("Q. saldo pagado con Pago Móvil por MENOS de lo adeudado y aprobado: 9/9 en Moodle y NUNCA certificado; al completar el pago, uno", async ({ request, playwright, page, browser }) => {
  await runCron(request, "certificates"); // despeja pendientes de otros tests del carril
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  expect((await addToCart(ctx, { product: DIPLOMA, modality: "ONLINE", plan: "HALF" })).error).toBeNull();
  const email = uniqueEmail("x3c3Q");
  const out = await submitCheckout(ctx, await checkoutFormFields(ctx), { email, firstName: "Quintín", lastName: "Monto Corto", method: "PAYPAL" });
  if (!out.ok) throw new Error(JSON.stringify(out));
  const appr = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1`)).json();
  await ctx.get(appr.redirect, { maxRedirects: 0 });
  await ctx.dispose();
  const o = ordersOfEmail(email)[0];
  await waitForOrderStatus(o.id, "ENROLLED", 60_000);
  await expect.poll(() => enrollments(o.id).filter((e) => e.status === "ENROLLED").length, { timeout: 30_000 }).toBe(9);
  const owed = order(o.id).balanceCents;
  expect(owed).toBeGreaterThan(0);
  const cust = customerOf(o.id);
  const courses = q<{ moodleCourseId: number }>(
    `SELECT p.moodleCourseId FROM OrderItemCourse oc JOIN OrderItem oi ON oi.id = oc.orderItemId JOIN Product p ON p.id = oc.courseId WHERE oi.orderId = ? ORDER BY oc.position`,
    o.id,
  ).map((c) => c.moodleCourseId);
  for (const courseid of courses) expect((await request.post(`${MOODLE}/__mock/complete`, { data: { userid: cust.moodleUserId, courseid } })).ok()).toBe(true);

  // Paga el saldo con Pago Móvil pero transfiere solo el 60 % en bolívares; el admin aprueba lo que llegó.
  const inst = q<{ id: string; status: string }>(`SELECT id, status FROM Installment WHERE orderId = ? ORDER BY sequence`, o.id).find((i) => i.status !== "PAID")!;
  const ref = `7${Date.now().toString().slice(-9)}`;
  await reportManual(page, `/pedido/${o.token}?cuota=${inst.id}`, ref, Math.round(owed * 0.6 * RATE));
  const toast = await approveInPanel(browser, o.id, ref);
  console.log("[x3-critic-3 Q] aprobación:", toast.trim());
  await expect.poll(() => order(o.id).balanceCents, { timeout: 30_000 }).toBeGreaterThan(0);
  const left = order(o.id).balanceCents;
  console.log("[x3-critic-3 Q] adeudado", owed, "→ queda", left, "estado", order(o.id).status);
  expect(left).toBeGreaterThanOrEqual(Math.floor(owed * 0.4) - 1);

  await Promise.all([runCron(request, "certificates"), runCron(request, "certificates"), runCron(request, "certificates,installments")]);
  expect(q(`SELECT id FROM Certificate WHERE customerId = ?`, cust.id), "saldo pendiente: sin certificado").toEqual([]);
  expect(q(`SELECT id FROM EmailOutbox WHERE template = 'certificate_issued' AND "to" = ?`, email.toLowerCase())).toEqual([]);

  // Paga el resto por PayPal desde su pedido → saldo 0 → el job emite UNO.
  const inst2 = q<{ id: string; status: string }>(`SELECT id, status FROM Installment WHERE orderId = ? ORDER BY sequence`, o.id).find((i) => i.status !== "PAID" && i.status !== "WAIVED")!;
  await page.goto(`/pedido/${o.token}/cuota/${inst2.id}/paypal`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const pp = new URL(page.url()).searchParams.get("token")!;
  const a2 = await (await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`)).json();
  const ret = await request.get(a2.redirect, { maxRedirects: 0 });
  expect(new URL(ret.headers()["location"], e2eEnv.APP_URL).searchParams.get("paypal")).toBe("completado");
  await expect.poll(() => order(o.id).balanceCents, { timeout: 30_000 }).toBe(0);
  await Promise.all([runCron(request, "certificates"), runCron(request, "certificates")]);
  await runCron(request, "certificates");
  const certs = q<{ code: string; status: string }>(`SELECT code, status FROM Certificate WHERE customerId = ?`, cust.id);
  expect(certs).toHaveLength(1);
  await expect.poll(() => q<{ status: string }>(`SELECT status FROM EmailOutbox WHERE template = 'certificate_issued' AND "to" = ?`, email.toLowerCase()).map((m) => m.status)).toEqual(["SENT"]);

  // R. Verificación pública: minúsculas/espacios → el mismo; basura → 404 sin romper.
  const code = certs[0].code;
  for (const v of [code, code.toLowerCase(), ` ${code} `]) {
    const r = await request.get(`${e2eEnv.APP_URL}/certificados/${encodeURIComponent(v)}`);
    expect(r.status(), v).toBe(200);
    expect(await r.text(), v).toContain("Certificado válido");
  }
  for (const v of ["CEIUM-XXXXX-XXXXX", "..%2F..%2Fetc%2Fpasswd", "x".repeat(500), "' OR 1=1 --", "%00"]) {
    const r = await request.get(`${e2eEnv.APP_URL}/certificados/${v}`);
    console.log("[x3-critic-3 R]", v.slice(0, 30), "→", r.status());
    expect(r.status(), v).toBeLessThan(500);
    expect(await r.text()).not.toContain("Certificado válido");
  }
});
