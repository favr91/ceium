// Crítico x4 (puerta final) — ataques al plan «mes a mes» ya integrado, por HTTP/navegador contra el carril
// (E2E_LANE=final E2E_PORT=3106):
//   P. PayPal desactivado en Configuración: un enlace de cuota de un recordatorio viejo (/cuota/<id>/paypal) ya no
//      abre un cobro en PayPal (ni botón, ni orden en PayPal, ni fila Payment).
//   M. Moodle cae justo al pagar la cuota 2 (enrol falla en todos los intentos inmediatos): la cuota queda pagada,
//      el curso 2 pendiente; al volver Moodle el job matricula SOLO el curso 2, con un solo aviso «ya tienes acceso».
//   W. Webhooks duplicados / repetidos de la captura de la cuota 2 (mismo event id y otro event id): nada se imputa
//      dos veces.
//   U. Monto equivocado en la cuota 3 (Pago Móvil por la mitad) aprobado por el admin: no habilita el curso 3; el
//      recordatorio pide lo que falta; al pagar el resto se matricula el curso 3 una sola vez.
//   R. Reembolso a mitad de camino (cuota 3, sin desmatricular): la cuota vuelve a quedar pendiente y el panel lo
//      avisa; luego un retiro (reembolso con desmatrícula) cierra el pedido, quita TODOS los cursos en Moodle, libera
//      el cupo y el job de cuotas ya no le cobra.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, fixture, one, order, paypalConfig, paypalState, q, replayWebhook, resendCaptureWebhook, runCron, uniqueEmail, waitForOrderStatus, type Checkout, type DiplomaCohort } from "./support/purchase";
import { todayCaracas } from "./support/dates";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor");
});
test.setTimeout(300_000);

const DIPLOMA = "diplomado-universitario-avanzado-de-medicina-materno-fetal";
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0x40)]))))), chunk("IEND", Buffer.alloc(0))]);
}
const PROOF = { name: "comprobante.png", mimeType: "image/png", buffer: proofPng() };
const bs = (usdCents: number) => (Math.round(usdCents * RATE) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let refSeq = 0;
const newRef = () => `9${(Date.now() % 1e6).toString().padStart(6, "0")}${(refSeq++).toString().padStart(2, "0")}`;

async function moodleCourses(request: APIRequestContext, userId: number): Promise<number[]> {
  const st = (await (await request.get(`${MOODLE}/__mock/state`)).json()) as { enrolments: { userid: number; courseid: number; status: number }[] };
  return st.enrolments.filter((e) => e.userid === userId && e.status === 0).map((e) => e.courseid).sort((a, b) => a - b);
}
const insOf = (orderId: string) => q<{ id: string; sequence: number; status: string; paidCents: number; amountCents: number }>(`SELECT id, sequence, status, paidCents, amountCents FROM Installment WHERE orderId = ? ORDER BY sequence`, orderId);
const mailsOf = (orderId: string) => q<{ template: string; subject: string; text: string }>(`SELECT template, subject, text FROM EmailOutbox WHERE orderId = ? ORDER BY createdAt`, orderId);

async function adminPage(browser: Browser, next: string): Promise<{ close: () => Promise<void>; page: Page }> {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/admin/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === next, { timeout: 60_000 });
  return { page, close: () => ctx.close() };
}

async function adminApprove(browser: Browser, orderId: string, reference: string) {
  const { page, close } = await adminPage(browser, `/admin/orders/${orderId}`);
  try {
    const card = page.getByTestId("payment").filter({ hasText: reference });
    await card.getByRole("button", { name: "Aprobar pago" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Pago aprobado/ })).toBeVisible({ timeout: 60_000 });
  } finally {
    await close();
  }
}

async function payPaypal(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
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

const S = { C: null as DiplomaCohort | null, co: null as Checkout | null, uid: 0 };

test.beforeAll(async ({ request }) => {
  manualBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  fixture("setting", { key: "payments.paypal", value: { enabled: true } });
  fixture("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } });
  expect((await request.post(`${MOODLE}/__mock/fail-clear`)).ok()).toBe(true);
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});
test.afterAll(async ({ request }) => {
  fixture("setting", { key: "payments.paypal", value: { enabled: true } });
  fixture("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 60 } });
  await request.post(`${MOODLE}/__mock/fail-clear`);
  if (Array.isArray(manualBefore)) {
    try {
      fixture("setting", { key: "payments.manualMethods", value: manualBefore });
    } catch {
      /* valor previo no válido para updateSetting */
    }
  }
});

test("0 · mes a mes con PayPal: primera cuota → solo el curso 1", async ({ page, request }) => {
  S.C = fixture<DiplomaCohort>("diploma-cohort", { product: DIPLOMA, capacity: 2, name: `Cohorte x4c ${Date.now().toString(36)}` });
  S.co = fixture<Checkout>("checkout", { productId: S.C.productId, cohortId: S.C.cohortId, planKind: "MONTHLY", email: uniqueEmail("x4c"), paymentMethod: "PAYPAL" });
  expect(S.co.installments).toHaveLength(9);
  await payPaypal(page, `/pedido/${S.co.token}`);
  await waitForOrderStatus(S.co.orderId, "ENROLLED", 60_000);
  S.uid = customerOf(S.co.orderId).moodleUserId!;
  expect(await moodleCourses(request, S.uid)).toEqual([S.C.courses[0].moodleCourseId]);
});

test("P · PayPal desactivado: el enlace de cuota de un recordatorio viejo no abre un cobro en PayPal", async ({ page, request }) => {
  const co = S.co!;
  const ins2 = co.installments[1];
  fixture("setting", { key: "payments.paypal", value: { enabled: false } });
  try {
    const paymentsBefore = q(`SELECT id FROM Payment WHERE orderId = ?`, co.orderId).length;
    const ppBefore = (await paypalState(request)).orders.length;
    await page.goto(`/pedido/${co.token}/cuota/${ins2.id}/paypal`);
    const btn = page.getByRole("button", { name: /con PayPal/ });
    if (await btn.count()) {
      await btn.click();
      await page.waitForURL((u) => !u.pathname.endsWith("/paypal") || u.href.startsWith(PAYPAL), { timeout: 30_000 }).catch(() => {});
    }
    expect(page.url().startsWith(PAYPAL), "no debe llevar a PayPal con PayPal desactivado").toBe(false);
    expect((await paypalState(request)).orders.length, "no debe crear órdenes en PayPal").toBe(ppBefore);
    expect(q(`SELECT id FROM Payment WHERE orderId = ?`, co.orderId).length, "no debe crear un intento de pago PayPal").toBe(paymentsBefore);
  } finally {
    fixture("setting", { key: "payments.paypal", value: { enabled: true } });
  }
});

test("M · Moodle cae al pagar la cuota 2: cuota pagada, curso 2 pendiente; al volver Moodle, SOLO el curso 2, un aviso", async ({ page, request }) => {
  const co = S.co!;
  const C = S.C!;
  const ins2 = co.installments[1];
  expect((await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", count: 3, type: "http", status: 503 } })).ok()).toBe(true);
  try {
    await payPaypal(page, `/pedido/${co.token}/cuota/${ins2.id}/paypal`);
    await expect.poll(() => insOf(co.orderId)[1].status, { timeout: 30_000 }).toBe("PAID");
    const row = () => one<{ status: string; lastError: string | null }>(`SELECT e.status, e.lastError FROM Enrollment e WHERE e.customerId = ? AND e.moodleCourseId = ?`, customerOf(co.orderId).id, C.courses[1].moodleCourseId);
    // Los reintentos inmediatos (3 llamadas) fallan todos: la fila queda pendiente con el error, para el job.
    await expect.poll(() => row()?.lastError ?? null, { timeout: 30_000 }).toBeTruthy();
    expect(row().status).toBe("PENDING");
    expect(await moodleCourses(request, S.uid)).toEqual([C.courses[0].moodleCourseId]);
  } finally {
    await request.post(`${MOODLE}/__mock/fail-clear`);
  }
  await expect
    .poll(async () => {
      await runCron(request, "enrollments");
      return moodleCourses(request, S.uid);
    }, { timeout: 60_000, intervals: [2_000, 3_000, 5_000] })
    .toEqual([C.courses[0].moodleCourseId, C.courses[1].moodleCourseId].sort((a, b) => a - b));
  await runCron(request, "enrollments");
  const access = mailsOf(co.orderId).filter((m) => m.template === "platform_access");
  expect(access.filter((m) => m.text.includes(C.courses[1].title)), "un solo aviso del curso 2").toHaveLength(1);
  expect(order(co.orderId).status).toBe("ENROLLED");
});

test("W · webhooks repetidos de la captura de la cuota 2 no se imputan dos veces", async ({ request }) => {
  const co = S.co!;
  const before = order(co.orderId);
  const pay = one<{ paypalCaptureId: string }>(`SELECT paypalCaptureId FROM Payment WHERE orderId = ? AND installmentId = ? AND status = 'COMPLETED'`, co.orderId, co.installments[1].id);
  const sent = await resendCaptureWebhook(request, pay.paypalCaptureId);
  expect(sent.status).toBe(200);
  await Promise.all([resendCaptureWebhook(request, pay.paypalCaptureId), replayWebhook(request, sent), replayWebhook(request, sent)]);
  const after = order(co.orderId);
  expect({ paid: after.amountPaidCents, bal: after.balanceCents }).toEqual({ paid: before.amountPaidCents, bal: before.balanceCents });
  expect(insOf(co.orderId).filter((i) => i.status === "PAID").map((i) => i.sequence)).toEqual([1, 2]);
});

test("U · cuota 3 con Pago Móvil por la mitad: aprobado no habilita el curso 3; pagar el resto sí (una vez)", async ({ page, request, browser }) => {
  const co = S.co!;
  const C = S.C!;
  const ins3 = co.installments[2];
  const half = ins3.amountCents / 2;
  const ref1 = newRef();
  await payManual(page, co.token, ins3.id, half, ref1);
  await adminApprove(browser, co.orderId, ref1);
  await expect.poll(() => insOf(co.orderId)[2].paidCents, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(insOf(co.orderId)[2].status).not.toBe("PAID");
  expect(await moodleCourses(request, S.uid)).toHaveLength(2);
  // Recordatorio desde el panel: pide solo lo que falta de la cuota 3.
  const { page: admin, close } = await adminPage(browser, `/admin/orders/${co.orderId}`);
  try {
    await admin.getByTestId("installments").getByRole("button", { name: "Enviar recordatorio de la cuota 3" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Recordatorio de la cuota 3 enviado" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await close();
  }
  const rem = mailsOf(co.orderId).filter((m) => m.template === "installment_reminder").pop()!;
  const remaining = ins3.amountCents - insOf(co.orderId)[2].paidCents;
  expect(rem.text).toContain(`$${(remaining / 100).toFixed(2)}`);
  const ref2 = newRef();
  await payManual(page, co.token, ins3.id, remaining, ref2);
  await adminApprove(browser, co.orderId, ref2);
  await expect.poll(() => insOf(co.orderId)[2].status, { timeout: 30_000 }).toBe("PAID");
  await expect.poll(() => moodleCourses(request, S.uid), { timeout: 30_000 }).toEqual(C.courses.slice(0, 3).map((c) => c.moodleCourseId).sort((a, b) => a - b));
  expect(order(co.orderId).balanceCents).toBe(6 * ins3.amountCents);
});

test("R · reembolso a mitad de camino y luego retiro: cuota reabierta + aviso; retiro quita todos los cursos y libera el cupo", async ({ request }) => {
  const co = S.co!;
  const C = S.C!;
  const pays = q<{ id: string; method: string; amountUsdCents: number; installmentId: string | null }>(`SELECT id, method, amountUsdCents, installmentId FROM Payment WHERE orderId = ? AND status = 'COMPLETED' ORDER BY createdAt`, co.orderId);
  const pp2 = pays.find((p) => p.method === "PAYPAL" && p.installmentId === co.installments[1].id)!;
  fixture("refund", { paymentId: pp2.id, reason: "Cobro en disputa", unenroll: false, releaseSeat: false, idempotencyKey: `x4c-r1-${Date.now()}` });
  expect(order(co.orderId).balanceCents).toBe(7 * co.installments[0].amountCents);
  expect(insOf(co.orderId).filter((i) => i.status === "PAID").map((i) => i.sequence)).toEqual([1, 2]);
  expect(q(`SELECT note FROM OrderEvent WHERE orderId = ? AND type = 'ATTENTION' AND note LIKE '%cuota 3 quedó sin pagar%'`, co.orderId).length).toBe(1);
  expect(await moodleCourses(request, S.uid)).toHaveLength(3);
  const seatsBefore = cohort(C.cohortId);

  // Retiro: reembolso del primer pago con desmatrícula y liberación del cupo.
  const pp1 = pays[0];
  fixture("refund", { paymentId: pp1.id, reason: "Retiro del programa", unenroll: true, releaseSeat: true, idempotencyKey: `x4c-r2-${Date.now()}` });
  await waitForOrderStatus(co.orderId, "REFUNDED", 30_000);
  await expect.poll(() => moodleCourses(request, S.uid), { timeout: 30_000 }).toEqual([]);
  const seatsAfter = cohort(C.cohortId);
  expect(seatsAfter.seatsConfirmed).toBe(seatsBefore.seatsConfirmed - 1);
  const remBefore = mailsOf(co.orderId).filter((m) => m.template === "installment_reminder").length;
  await runCron(request, "installments");
  expect(mailsOf(co.orderId).filter((m) => m.template === "installment_reminder").length, "sin recordatorios tras el retiro").toBe(remBefore);
  expect(order(co.orderId).balanceCents).toBe(0);
});

test("I · índice de pedidos: buscar y abrir enseguida un pedido ya visible no rebota al listado", async ({ browser }) => {
  // El pedido más reciente está en la primera página SIN filtrar: el admin escribe su correo, pulsa Enter y hace clic
  // en él al instante. La búsqueda con espera (350 ms) no debe navegar después y devolverlo al listado.
  const last = one<{ id: string; number: number; email: string }>(`SELECT o.id, o.number, c.email FROM "Order" o JOIN Customer c ON c.id = o.customerId ORDER BY o.placedAt DESC LIMIT 1`);
  for (let round = 0; round < 3; round++) {
    const { page, close } = await adminPage(browser, "/admin/orders");
    try {
      await page.getByRole("button", { name: "Buscar y filtrar" }).click();
      await page.getByLabel("Buscar pedidos").fill(last.email);
      await page.getByLabel("Buscar pedidos").press("Enter");
      await page.getByRole("link", { name: `#${last.number}`, exact: true }).click();
      await page.waitForURL(`**/admin/orders/${last.id}`, { timeout: 15_000 });
      await page.waitForTimeout(1_500);
      expect(new URL(page.url()).pathname, `ronda ${round}: sigue en el pedido`).toBe(`/admin/orders/${last.id}`);
    } finally {
      await close();
    }
  }
});

test("T · índice de pedidos: pestaña y enseguida un filtro → el filtro se aplica sobre la pestaña nueva", async ({ browser }) => {
  // El admin está en «Por verificar», pulsa «Todos» y sin esperar a que cargue abre el filtro de método: el filtro no
  // debe devolverlo a «Por verificar» (antes se construía con el estado de la URL anterior).
  for (let round = 0; round < 3; round++) {
    const { page, close } = await adminPage(browser, "/admin/orders");
    try {
      await page.getByRole("tab", { name: /^Por verificar/ }).click();
      await expect(page).toHaveURL(/view=AWAITING_VERIFICATION/);
      // Red lenta para la página de «Todos»: su respuesta RSC tarda, como con una conexión móvil.
      await page.route(
        (u) => u.pathname === "/admin/orders" && !u.search.includes("view=") && !u.search.includes("method="),
        async (route) => {
          if (route.request().headers()["rsc"]) await new Promise((r) => setTimeout(r, 1_500));
          await route.fallback();
        },
      );
      await page.getByRole("tab", { name: /^Todos/ }).click();
      await page.getByRole("button", { name: "Buscar y filtrar" }).click();
      await page.getByRole("button", { name: "Método de pago" }).click();
      await page.getByRole("group", { name: "Método de pago" }).getByText("PayPal", { exact: true }).click();
      await expect(page).toHaveURL(/method=PAYPAL/);
      await page.waitForTimeout(1_000);
      expect(page.url(), `ronda ${round}`).not.toMatch(/view=AWAITING_VERIFICATION/);
      await expect(page.getByRole("tab", { name: /^Todos/ })).toHaveAttribute("aria-selected", "true");
    } finally {
      await close();
    }
  }
});
