// Crítico x4 final (puerta de entrega) — ataques al plan «mes a mes» ya integrado, por el navegador contra el carril
// (E2E_LANE=final E2E_PORT=3106). La BD solo se lee; los mocks se usan como el mundo real (aprobar en PayPal).
//   V. El médico registra el Pago Móvil de una cuota y, mientras el admin lo verifica, paga la MISMA cuota con PayPal
//      desde el enlace del recordatorio: no se le cobra dos veces (como ya ocurre con el primer pago del pedido).
//   V2. Lo mismo con la pestaña de PayPal abierta ANTES de registrar el Pago Móvil (se aprueba después): no se captura.
//   T. Dos pestañas de la última cuota con PayPal, ambas aprobadas a la vez: un solo cobro (antes: dos capturas y un
//      reembolso automático del excedente — cobro doble al médico y comisión de PayPal perdida).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, customerOf, fixture, order, paypalConfig, paypalState, q, uniqueEmail, waitForOrderStatus, type Checkout, type DiplomaCohort } from "./support/purchase";
import { todayCaracas } from "./support/dates";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor");
});
test.setTimeout(300_000);

const DIPLOMA = "diplomado-universitario-avanzado-de-medicina-materno-fetal";
const RATE = 187.25;
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
let manualBefore: unknown = null;

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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.alloc(8 * 25, 0x40))), chunk("IEND", Buffer.alloc(0))]);
}
const PROOF = { name: "comprobante.png", mimeType: "image/png", buffer: proofPng() };
const bs = (usdCents: number) => (Math.round(usdCents * RATE) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let refSeq = 0;
const newRef = () => `7${(Date.now() % 1e6).toString().padStart(6, "0")}${(refSeq++).toString().padStart(2, "0")}`;

const insOf = (orderId: string) => q<{ id: string; sequence: number; status: string; paidCents: number; amountCents: number }>(`SELECT id, sequence, status, paidCents, amountCents FROM Installment WHERE orderId = ? ORDER BY sequence`, orderId);
const completedPaypal = (orderId: string) => q<{ id: string }>(`SELECT id FROM Payment WHERE orderId = ? AND method = 'PAYPAL' AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`, orderId).length;
async function capturesOf(request: APIRequestContext, paypalOrderIds: string[]): Promise<number> {
  const st = await paypalState(request);
  return st.orders.filter((o) => paypalOrderIds.includes(o.id)).flatMap((o) => o.purchase_units.flatMap((u) => u.payments?.captures ?? [])).length;
}
const paypalOrderIdsOf = (orderId: string) => q<{ paypalOrderId: string | null }>(`SELECT paypalOrderId FROM Payment WHERE orderId = ? AND method = 'PAYPAL'`, orderId).map((p) => p.paypalOrderId!).filter(Boolean);

async function adminApprove(browser: Browser, orderId: string, reference: string) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    const next = `/admin/orders/${orderId}`;
    await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Correo electrónico").fill("admin@ceium.net");
    await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL((u) => u.pathname === next, { timeout: 60_000 });
    await page.getByTestId("payment").filter({ hasText: reference }).getByRole("button", { name: "Aprobar pago" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Pago aprobado/ })).toBeVisible({ timeout: 60_000 });
  } finally {
    await ctx.close();
  }
}

/** Abre el enlace de PayPal de la cuota y, si ofrece el botón, paga. Devuelve si llegó a PayPal. */
async function tryPaypal(page: Page, url: string): Promise<boolean> {
  await page.goto(url);
  const btn = page.getByRole("button", { name: /con PayPal/ });
  if ((await btn.count()) === 0) return false;
  await btn.click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`) || u.searchParams.get("pago") === "error", { timeout: 60_000 });
  if (!page.url().startsWith(PAYPAL)) return false;
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
  return true;
}

async function payManual(page: Page, token: string, insId: string, usdCents: number, reference: string) {
  await page.goto(`/pedido/${token}?cuota=${insId}#pagar`);
  const pay = page.getByTestId("order-pay");
  await pay.getByLabel("Número de referencia").fill(reference);
  await pay.getByLabel(/Monto pagado/).fill(bs(usdCents));
  await pay.getByLabel("Banco de origen").fill("Banesco (0134)");
  await pay.getByLabel("Fecha del pago").fill(todayCaracas());
  await pay.getByLabel("Cédula del titular").fill("V-11222333");
  await pay.getByLabel(/Comprobante/).setInputFiles(PROOF);
  await pay.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/, { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("pago"), new URL(page.url()).searchParams.get("motivo") ?? "").toBe("registrado");
}

async function monthlyEnrolled(page: Page, tag: string): Promise<{ C: DiplomaCohort; co: Checkout }> {
  const C = fixture<DiplomaCohort>("diploma-cohort", { product: DIPLOMA, capacity: 3, name: `Cohorte ${tag} ${Date.now().toString(36)}` });
  const co = fixture<Checkout>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "MONTHLY", email: uniqueEmail(tag), paymentMethod: "PAYPAL" });
  expect(await tryPaypal(page, `/pedido/${co.token}`)).toBe(true);
  await waitForOrderStatus(co.orderId, "ENROLLED", 60_000);
  return { C, co };
}

test.beforeAll(async ({ request }) => {
  manualBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  fixture("setting", { key: "payments.paypal", value: { enabled: true } });
  expect((await request.post(`${MOODLE}/__mock/fail-clear`)).ok()).toBe(true);
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});
test.afterAll(async () => {
  if (Array.isArray(manualBefore)) {
    try {
      fixture("setting", { key: "payments.manualMethods", value: manualBefore });
    } catch {
      /* valor previo no válido para updateSetting */
    }
  }
});

test("V · Pago Móvil de la cuota 2 en verificación y la MISMA cuota con PayPal desde el recordatorio → un solo cobro", async ({ page, browser, request }) => {
  const { co } = await monthlyEnrolled(page, "x4fv");
  const ins2 = co.installments[1];
  const ref = newRef();
  await payManual(page, co.token, ins2.id, 18000, ref);
  const before = completedPaypal(co.orderId);
  const reached = await tryPaypal(page, `/pedido/${co.token}/cuota/${ins2.id}/paypal`);
  await page.waitForTimeout(1500);
  const snapshot = { reachedPaypal: reached, paypalCaptured: completedPaypal(co.orderId) - before, captures: await capturesOf(request, paypalOrderIdsOf(co.orderId)), url: page.url() };
  console.log(JSON.stringify(snapshot));
  // Lo que cuenta: PayPal no cobra la cuota 2 mientras su Pago Móvil espera verificación.
  expect(snapshot.paypalCaptured, "PayPal cobró la cuota que ya estaba pagada por Pago Móvil (en verificación)").toBe(0);
  expect(snapshot.captures, "capturas en PayPal: solo la de la cuota 1").toBe(1);
  expect(new URL(page.url()).searchParams.get("motivo") ?? "").toContain("lo estamos verificando");

  await adminApprove(browser, co.orderId, ref);
  await expect.poll(() => insOf(co.orderId)[1].status, { timeout: 30_000 }).toBe("PAID");
  expect(insOf(co.orderId)[2].status, "la cuota 3 no se paga sola").not.toBe("PAID");
  expect(order(co.orderId).balanceCents).toBe(7 * 18000);
});

test("V2 · PayPal de la cuota 3 abierto ANTES de registrar su Pago Móvil y aprobado después → no se captura", async ({ page, browser, request }) => {
  const { co } = await monthlyEnrolled(page, "x4fv2");
  const ins2 = co.installments[1];
  expect(await tryPaypal(page, `/pedido/${co.token}/cuota/${ins2.id}/paypal`)).toBe(true);
  await expect.poll(() => insOf(co.orderId)[1].status, { timeout: 30_000 }).toBe("PAID");
  const ins3 = co.installments[2];
  // Pestaña 1: llega a PayPal con la cuota 3 y se queda ahí.
  await page.goto(`/pedido/${co.token}/cuota/${ins3.id}/paypal`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  // Pestaña 2: registra el Pago Móvil de la cuota 3.
  const ctx2 = await browser.newContext({ locale: "es-VE" });
  const p2 = await ctx2.newPage();
  const ref = newRef();
  try {
    await p2.goto(`${e2eEnv.APP_URL}/`);
    await payManual(p2, co.token, ins3.id, 18000, ref);
  } finally {
    await ctx2.close();
  }
  const before = completedPaypal(co.orderId);
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  expect(completedPaypal(co.orderId) - before, "PayPal cobró la cuota 3 con su Pago Móvil en verificación").toBe(0);
  expect(await capturesOf(request, paypalOrderIdsOf(co.orderId)), "capturas: cuotas 1 y 2").toBe(2);
  await adminApprove(browser, co.orderId, ref);
  await expect.poll(() => insOf(co.orderId)[2].status, { timeout: 30_000 }).toBe("PAID");
  expect(insOf(co.orderId)[3].status).not.toBe("PAID");
  expect(order(co.orderId).balanceCents).toBe(6 * 18000);
});

test("T · dos pestañas de la ÚLTIMA cuota aprobadas en PayPal → un solo cobro, saldo 0", async ({ page, browser, request }) => {
  const { co } = await monthlyEnrolled(page, "x4ft");
  for (const ins of co.installments.slice(1, 8)) {
    expect(await tryPaypal(page, `/pedido/${co.token}/cuota/${ins.id}/paypal`)).toBe(true);
    await expect.poll(() => insOf(co.orderId).find((i) => i.id === ins.id)!.status, { timeout: 30_000 }).toBe("PAID");
  }
  const last = co.installments[8];
  const ctx2 = await browser.newContext({ locale: "es-VE" });
  const p2 = await ctx2.newPage();
  try {
    const url = `/pedido/${co.token}/cuota/${last.id}/paypal`;
    await page.goto(url);
    await p2.goto(`${e2eEnv.APP_URL}${url}`);
    await page.getByRole("button", { name: /con PayPal/ }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await p2.getByRole("button", { name: /con PayPal/ }).click();
    await p2.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await Promise.all([page.getByTestId("pp-approve").click(), p2.getByTestId("pp-approve").click()]);
    await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
    await p2.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
  } finally {
    await ctx2.close();
  }
  await page.waitForTimeout(1500);
  const refunds = q<{ amountCents: number }>(`SELECT r.amountCents FROM Refund r JOIN Payment p ON p.id = r.paymentId WHERE p.orderId = ?`, co.orderId);
  const snap = { captures: await capturesOf(request, paypalOrderIdsOf(co.orderId)), completed: completedPaypal(co.orderId), refunds, balance: order(co.orderId).balanceCents, status: order(co.orderId).status };
  console.log(JSON.stringify(snap));
  expect(snap.captures, "9 cuotas → 9 capturas en PayPal, ni una más").toBe(9);
  expect(snap.balance).toBe(0);
  expect(snap.status).toBe("ENROLLED");
  expect(customerOf(co.orderId).moodleUserId).toBeTruthy();
});

test("T2 · dos pestañas de la cuota 2 aprobadas una tras otra → la segunda no se cobra (no adelanta la cuota 3)", async ({ page, browser, request }) => {
  const { co } = await monthlyEnrolled(page, "x4ft2");
  const ins2 = co.installments[1];
  const ctx2 = await browser.newContext({ locale: "es-VE" });
  const p2 = await ctx2.newPage();
  try {
    const url = `/pedido/${co.token}/cuota/${ins2.id}/paypal`;
    await page.goto(url);
    await p2.goto(`${e2eEnv.APP_URL}${url}`);
    await page.getByRole("button", { name: /con PayPal/ }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await p2.getByRole("button", { name: /con PayPal/ }).click();
    await p2.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await p2.getByTestId("pp-approve").click();
    await p2.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
    await expect.poll(() => insOf(co.orderId)[1].status, { timeout: 30_000 }).toBe("PAID");
    await page.getByTestId("pp-approve").click();
    await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
  } finally {
    await ctx2.close();
  }
  await page.waitForTimeout(1500);
  expect(await capturesOf(request, paypalOrderIdsOf(co.orderId)), "capturas: cuota 1 y una sola de la cuota 2").toBe(2);
  expect(insOf(co.orderId)[2].status).not.toBe("PAID");
  expect(order(co.orderId).balanceCents).toBe(7 * 18000);
});

test("F · pago total con PayPal en dos pestañas aprobadas a la vez → un solo cobro, un cupo", async ({ page, browser, request }) => {
  const C = fixture<DiplomaCohort>("diploma-cohort", { product: DIPLOMA, capacity: 3, name: `Cohorte x4ff ${Date.now().toString(36)}` });
  const co = fixture<Checkout>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email: uniqueEmail("x4ff"), paymentMethod: "PAYPAL" });
  const ctx2 = await browser.newContext({ locale: "es-VE" });
  const p2 = await ctx2.newPage();
  try {
    await page.goto(`/pedido/${co.token}`);
    await p2.goto(`${e2eEnv.APP_URL}/pedido/${co.token}`);
    await page.getByRole("button", { name: /con PayPal/ }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await p2.getByRole("button", { name: /con PayPal/ }).click();
    await p2.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await Promise.all([page.getByTestId("pp-approve").click(), p2.getByTestId("pp-approve").click()]);
    await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
    await p2.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
  } finally {
    await ctx2.close();
  }
  await waitForOrderStatus(co.orderId, "ENROLLED", 60_000);
  await page.waitForTimeout(1500);
  const refunds = q(`SELECT r.amountCents FROM Refund r JOIN Payment p ON p.id = r.paymentId WHERE p.orderId = ?`, co.orderId);
  expect(await capturesOf(request, paypalOrderIdsOf(co.orderId)), "un solo cobro en PayPal").toBe(1);
  expect(refunds).toEqual([]);
  expect(order(co.orderId).balanceCents).toBe(0);
  const c = q<{ seatsConfirmed: number; seatsHeld: number }>(`SELECT seatsConfirmed, seatsHeld FROM Cohort WHERE id = ?`, C.cohortId)[0];
  expect(c).toEqual({ seatsConfirmed: 1, seatsHeld: 0 });
});
