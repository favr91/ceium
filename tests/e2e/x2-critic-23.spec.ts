// x2 critic 23 — por HTTP contra la app y los mocks: el MISMO médico compra dos veces la MISMA cohorte.
//   1. Registra su pago móvil (pedido A, «en verificación», cupo HELD) y, mientras espera la verificación (hasta
//      72 h), vuelve a la tienda y compra la misma cohorte con PayPal para entrar ya (pedido B): PayPal cobra, B
//      queda inscrito con cupo. Luego el admin abre A y aprueba el comprobante.
//      Hoy: A también queda inscrito — el médico pagó 2 × 180 USD por un curso, ocupa DOS cupos de la cohorte
//      (de 3), recibe dos veces «pago aprobado / acceso / datos de la cohorte» y ni la ficha ni el historial
//      avisan de nada (ningún ATTENTION). El staff solo lo descubre si el médico reclama.
//   2. Igual con PayPal las dos veces (sin nadie en medio): la segunda orden se captura sin mirar que el mismo
//      cliente ya tiene cupo pagado en esa cohorte → cobro doble automático, dos cupos, sin aviso.
// critic 23: al confirmarse el primer pago de un pedido, si el mismo cliente tiene otro pedido vivo con cupo en la
// misma cohorte (o el mismo producto online ya pagado), ambos pedidos quedan con un ATTENTION que nombra al otro
// (payments.ts: flagDuplicatePurchase).
// critic 24: la segunda orden PayPal ya NO se captura si el cliente ya pagó ese programa en otro pedido o tiene su
// pago en verificación / retenido por PayPal (secureSeatBeforeCapture → alreadyPaidElsewhere): un cobro, un cupo.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-23.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { PAYPAL, cohort, customerOf, emails, events, fixture, one, order, q, reservationOf, uniqueEmail, waitForOrderStatus } from "./support/purchase";
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c23 ${Date.now().toString(36)}` });
/** Checkout como la tienda (createCheckout): cada llamada es una compra nueva (otra sesión / carrito vaciado). */
const checkout = (C: CourseCohort, email: string, paymentMethod: string) => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newRef = (prefix: string) => `${prefix}${Date.now().toString().slice(-8)}`;

async function payManual(page: Page, token: string, reference: string, amountBs: number) {
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
/** Cupos CONFIRMED que el mismo cliente ocupa en la cohorte (por todos sus pedidos). */
const seatsOfCustomer = (customerId: string, cohortId: string) =>
  one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation r JOIN "Order" o ON o.id = r.orderId WHERE o.customerId = ? AND r.cohortId = ? AND r.status = 'CONFIRMED'`, customerId, cohortId).n;
/** ¿Algún ATTENTION del pedido nombra al otro pedido (#número)? */
const flagsOther = (orderId: string, otherNumber: number) => events(orderId, "ATTENTION").some((e) => (e.note ?? "").includes(`#${otherNumber}`));

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

test("pago móvil en verificación y recompra de la MISMA cohorte con PayPal → PayPal NO se cobra; el admin aprueba el comprobante → un cupo, un cobro", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c23pm");
  const a = checkout(C, email, "PAGO_MOVIL");
  const ref = newRef("0134");
  expect((await payManual(page, a.token, ref, Math.round(a.dueNowCents * RATE))).get("pago")).toBe("registrado");
  expect(order(a.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(a.orderId).status).toBe("HELD");

  // Mientras espera la verificación, compra otra vez la misma cohorte con PayPal (otra sesión: el carrito se vació).
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const b = checkout(C, email, "PAYPAL");
  let ppB = "";
  try {
    const bp = await ctx.newPage();
    ppB = await payPaypal(bp, b.token);
    // Aprobó en PayPal, pero no se le cobra: vuelve a su pedido con el aviso «no lo cobramos».
    expect(new URL(bp.url()).searchParams.get("paypal")).toBe("no-cobrado");
    await expect(bp.getByTestId("order-banner")).toContainText("no lo cobramos");
  } finally {
    await ctx.close();
  }
  expect(customerOf(b.orderId).id).toBe(customerOf(a.orderId).id);
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { orders: { id: string; status: string }[] };
  expect(st.orders.find((o) => o.id === ppB)?.status).not.toBe("COMPLETED");
  expect(order(b.orderId)).toMatchObject({ status: "PENDING_PAYMENT", amountPaidCents: 0 });
  expect(one<{ status: string; providerStatus: string }>(`SELECT status, providerStatus FROM Payment WHERE paypalOrderId = ?`, ppB)).toEqual({ status: "CANCELLED", providerStatus: "NOT_CAPTURED" });
  expect(events(b.orderId, "PAYMENT_NOT_CAPTURED").map((e) => e.note).join("\n")).toContain(`#${a.number}`);
  // A (aún en verificación) queda avisado ANTES de aprobar.
  expect(flagsOther(a.orderId, b.number)).toBe(true);

  const { ctx: actx, page: admin } = await adminLogin(browser, `/admin/orders/${a.orderId}`);
  try {
    await admin.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
  } finally {
    await actx.close();
  }
  await waitForOrderStatus(a.orderId, "ENROLLED", 45_000);

  const custId = customerOf(a.orderId).id;
  const completed = q<{ n: number }>(`SELECT COUNT(*) AS n FROM Payment p JOIN "Order" o ON o.id = p.orderId WHERE o.customerId = ? AND p.status = 'COMPLETED'`, custId)[0].n;
  const snapshot = { a: order(a.orderId).status, b: order(b.orderId).status, seatsOfCustomer: seatsOfCustomer(custId, C.cohortId), cohort: cohort(C.cohortId), completed };
  console.log(JSON.stringify(snapshot));
  expect(snapshot.seatsOfCustomer).toBe(1);
  expect(snapshot.completed).toBe(1);
  expect(emails(a.orderId).filter((m) => m.template === "payment_approved")).toHaveLength(1);
  expect(emails(b.orderId).filter((m) => ["order_confirmation", "payment_approved"].includes(m.template))).toEqual([]);
});

test("el mismo médico paga dos veces con PayPal la MISMA cohorte → la segunda no se captura; un cupo; otro cliente sí se cobra", async ({ browser, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("x2c23pp");
  const placed: Placed[] = [];
  const ppIds: string[] = [];
  for (let k = 0; k < 2; k++) {
    const o = checkout(C, email, "PAYPAL");
    placed.push(o);
    const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
    try {
      ppIds.push(await payPaypal(await ctx.newPage(), o.token));
    } finally {
      await ctx.close();
    }
    if (k === 0) await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  }
  const [a, b] = placed;
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { orders: { id: string; status: string }[] };
  expect(st.orders.find((o) => o.id === ppIds[0])?.status).toBe("COMPLETED");
  expect(st.orders.find((o) => o.id === ppIds[1])?.status).not.toBe("COMPLETED");
  const custId = customerOf(a.orderId).id;
  expect(seatsOfCustomer(custId, C.cohortId)).toBe(1);
  expect(order(b.orderId).amountPaidCents).toBe(0);
  expect(events(b.orderId, "PAYMENT_NOT_CAPTURED").map((e) => e.note).join("\n")).toContain("compra duplicada");
  expect(flagsOther(a.orderId, b.number)).toBe(true);
  // Un cliente distinto en la misma cohorte se cobra normal y NO se marca.
  const other = checkout(C, uniqueEmail("x2c23other"), "PAYPAL");
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  try {
    await payPaypal(await ctx.newPage(), other.token);
  } finally {
    await ctx.close();
  }
  await waitForOrderStatus(other.orderId, "ENROLLED", 45_000);
  expect(events(other.orderId, "ATTENTION")).toEqual([]);
});
