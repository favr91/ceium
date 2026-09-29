// Puerta final (x4) — ataques de integración sobre el plan «mes a mes» ya en marcha, por HTTP y por el navegador,
// contra el carril (E2E_LANE=final E2E_PORT=3106). Solo se LEE la BD para verificar; los datos de partida salen de los
// mismos servicios de dominio que la tienda y el panel (scripts/e2e-fixture.ts).
//   G0. Cron y webhook sin credenciales / firma falsa → rechazados, nada cambia.
//   G1. El admin sube la cuota mensual del diplomado en el panel con un médico a mitad de plan: la tienda muestra el
//       precio nuevo, pero la cuota 2 de ese médico se cobra en PayPal por el monto que compró (no el nuevo).
//   G2. Webhooks fuera de orden sobre la captura de la cuota 2 ya imputada: DENIED firmado y COMPLETED con firma
//       falsa → nada cambia (pago, saldo, cuotas, Moodle).
//   G3. Doble clic en «Aprobar pago» de la cuota 3 (Pago Móvil) → se imputa una vez: un curso, un correo.
//   G4. Moodle lento al matricular la cuota 4 y el admin pulsa «Rematricular» mientras tanto → curso 4 una vez, un
//       solo aviso de acceso para el curso 4.
//   G5. Retiro a mitad de camino desde el panel con Moodle caído al desmatricular → pedido reembolsado en PayPal y
//       cupo libre; el job desmatricula TODOS los cursos al volver Moodle; el enlace PayPal del último recordatorio ya
//       no cobra y el job de cuotas no vuelve a recordar.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, fixture, one, order, paypalConfig, paypalState, q, runCron, uniqueEmail, waitForOrderStatus, type Checkout, type DiplomaCohort } from "./support/purchase";
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0x33)]))))), chunk("IEND", Buffer.alloc(0))]);
}
const PROOF = { name: "comprobante.png", mimeType: "image/png", buffer: proofPng() };
const bs = (usdCents: number) => (Math.round(usdCents * RATE) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let refSeq = 0;
const newRef = () => `7${(Date.now() % 1e6).toString().padStart(6, "0")}${(refSeq++).toString().padStart(2, "0")}`;

async function moodleCourses(request: APIRequestContext, userId: number): Promise<number[]> {
  const st = (await (await request.get(`${MOODLE}/__mock/state`)).json()) as { enrolments: { userid: number; courseid: number; status: number }[] };
  return st.enrolments.filter((e) => e.userid === userId && e.status === 0).map((e) => e.courseid).sort((a, b) => a - b);
}
const insOf = (orderId: string) => q<{ id: string; sequence: number; status: string; paidCents: number; amountCents: number }>(`SELECT id, sequence, status, paidCents, amountCents FROM Installment WHERE orderId = ? ORDER BY sequence`, orderId);
const mailsOf = (orderId: string) => q<{ template: string; subject: string; text: string; html: string }>(`SELECT template, subject, text, html FROM EmailOutbox WHERE orderId = ? ORDER BY createdAt, id`, orderId);
const paidSeqs = (orderId: string) => insOf(orderId).filter((i) => i.status === "PAID").map((i) => i.sequence);

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

async function adminRemind(browser: Browser, orderId: string, sequence: number) {
  const { page, close } = await adminPage(browser, `/admin/orders/${orderId}`);
  try {
    await page.getByTestId("installments").getByRole("button", { name: `Enviar recordatorio de la cuota ${sequence}` }).click();
    await expect(page.getByRole("status").filter({ hasText: `Recordatorio de la cuota ${sequence} enviado` })).toBeVisible({ timeout: 30_000 });
  } finally {
    await close();
  }
}
function lastReminder(orderId: string) {
  const r = mailsOf(orderId).filter((m) => m.template === "installment_reminder").pop()!;
  const html = r.html.replace(/&amp;/g, "&");
  return { ...r, paypal: html.match(/href="([^"]*\/cuota\/[^"/]+\/paypal)"/)?.[1] ?? null, manual: html.match(/href="([^"]*\?cuota=[^"#]+#pagar)"/)?.[1] ?? null };
}

async function payPaypal(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
}

async function payManual(page: Page, url: string, usdCents: number, reference: string) {
  await page.goto(url);
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

const SEDES = ["Barquisimeto", "Caracas", "Maracaibo"];
const S = { C: null as DiplomaCohort | null, co: null as Checkout | null, uid: 0, email: uniqueEmail("x4gate"), monthlyWas: "" };

test.beforeAll(async ({ request }) => {
  manualBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  fixture("setting", { key: "payments.paypal", value: { enabled: true } });
  fixture("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } });
  expect((await request.post(`${MOODLE}/__mock/fail-clear`)).ok()).toBe(true);
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});
test.afterAll(async ({ request }) => {
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

test("G0 · cron sin secreto y webhooks sin firma válida → rechazados", async ({ request }) => {
  const base = e2eEnv.APP_URL;
  expect((await request.post(`${base}/api/cron?jobs=certificates`)).status()).toBe(401);
  expect((await request.post(`${base}/api/cron?jobs=certificates`, { headers: { authorization: "Bearer nope" } })).status()).toBe(401);
  const forged = {
    id: `WH-FORGED-${Date.now()}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "CAP-FORGED", status: "COMPLETED", amount: { currency_code: "USD", value: "1620.00" }, supplementary_data: { related_ids: { order_id: "NOPE" } } },
  };
  const r = await request.post(`${base}/api/webhooks/paypal`, {
    headers: { "content-type": "application/json", "paypal-transmission-id": "x", "paypal-transmission-time": new Date().toISOString(), "paypal-transmission-sig": "Zm9v", "paypal-cert-url": `${PAYPAL}/certs/fake.pem`, "paypal-auth-algo": "SHA256withRSA" },
    data: JSON.stringify(forged),
  });
  expect(r.status()).toBe(400);
  expect((await request.post(`${base}/api/webhooks/paypal`, { data: "no-json{" })).status()).toBe(400);
});

test("G1 · precio mensual editado a mitad del plan: la tienda lo refleja y la cuota 2 del médico se cobra por lo que compró", async ({ browser, page, request }) => {
  S.C = fixture<DiplomaCohort>("diploma-cohort", { product: DIPLOMA, capacity: 2, name: `Cohorte gate ${Date.now().toString(36)}` });
  S.co = fixture<Checkout>("checkout", { productId: S.C.productId, cohortId: S.C.cohortId, planKind: "MONTHLY", email: S.email, paymentMethod: "PAYPAL" });
  const co = S.co;
  expect(co.installments).toHaveLength(9);
  const bought = co.installments[1].amountCents;
  await payPaypal(page, `/pedido/${co.token}`);
  await waitForOrderStatus(co.orderId, "ENROLLED", 60_000);
  S.uid = customerOf(co.orderId).moodleUserId!;
  expect(await moodleCourses(request, S.uid)).toEqual([S.C.courses[0].moodleCourseId]);

  // El admin sube la cuota mensual de TODAS las sedes en la matriz de precios.
  const { page: admin, close } = await adminPage(browser, `/admin/products/${S.C.productId}`);
  const newMonthly = bought / 100 + 19;
  try {
    const inp = admin.getByLabel(/^Cuota mensual para todas las sedes/).first();
    // Se guarda la cuota de CADA sede: si difieren, el campo de grupo está vacío («Varias») y restaurarlo con ese
    // valor vaciaba las tres cuotas (y ensuciaba las pruebas siguientes: «9 cuotas de $157.78»).
    S.monthlyWas = JSON.stringify(Object.fromEntries(await Promise.all(SEDES.map(async (sede) => [sede, await admin.getByLabel(`Cuota mensual Semipresencial ${sede}`, { exact: true }).inputValue()]))));
    await inp.fill(String(newMonthly));
    await admin.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
    await expect(admin.getByRole("region", { name: "Cambios sin guardar" })).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await close();
  }
  try {
    const shop = await browser.newPage();
    await shop.goto(`/products/${DIPLOMA}`);
    const form = shop.getByTestId("buy-form");
    await form.getByRole("group", { name: "Modalidad" }).getByRole("radio", { name: "Semipresencial" }).check();
    await form.getByRole("group", { name: "Sede" }).getByRole("radio", { name: "Barquisimeto" }).check();
    await form.getByRole("group", { name: "Forma de pago" }).getByRole("radio", { name: "Paga mes a mes" }).check();
    await expect(form).toContainText(`9 cuotas de $${newMonthly.toFixed(2)}`);
    await shop.close();

    // Cuota 2 desde el recordatorio, con PayPal: PayPal recibe el monto COMPRADO.
    await adminRemind(browser, co.orderId, 2);
    const rem = lastReminder(co.orderId);
    expect(rem.text).toContain(`$${(bought / 100).toFixed(2)}`);
    expect(rem.text).not.toContain(`$${newMonthly.toFixed(2)}`);
    await payPaypal(page, rem.paypal!);
    await expect.poll(() => paidSeqs(co.orderId), { timeout: 60_000 }).toEqual([1, 2]);
    const p2 = one<{ paypalOrderId: string; amountCents: number }>(`SELECT paypalOrderId, amountCents FROM Payment WHERE orderId = ? AND installmentId = ? AND status = 'COMPLETED'`, co.orderId, co.installments[1].id);
    expect(p2.amountCents).toBe(bought);
    const ppOrder = (await paypalState(request)).orders.find((o) => o.id === p2.paypalOrderId) as unknown as { purchase_units: { amount: { value: string } }[] };
    expect(ppOrder.purchase_units[0].amount.value).toBe((bought / 100).toFixed(2));
    expect(order(co.orderId)).toMatchObject({ totalCents: 9 * bought, balanceCents: 7 * bought, amountPaidCents: 2 * bought });
    await expect.poll(() => moodleCourses(request, S.uid), { timeout: 30_000 }).toEqual(S.C.courses.slice(0, 2).map((c) => c.moodleCourseId).sort((a, b) => a - b));
  } finally {
    // Deja el precio como estaba.
    const { page: admin2, close: close2 } = await adminPage(browser, `/admin/products/${S.C.productId}`);
    try {
      for (const [sede, value] of Object.entries(JSON.parse(S.monthlyWas || "{}") as Record<string, string>)) {
        await admin2.getByLabel(`Cuota mensual Semipresencial ${sede}`, { exact: true }).fill(value);
      }
      await admin2.getByRole("region", { name: "Cambios sin guardar" }).getByRole("button", { name: "Guardar" }).click();
      await expect(admin2.getByRole("region", { name: "Cambios sin guardar" })).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await close2();
    }
  }
});

test("G2 · webhooks fuera de orden sobre la captura de la cuota 2 ya imputada (DENIED firmado, COMPLETED con firma falsa) → nada cambia", async ({ request }) => {
  const co = S.co!;
  const cap = one<{ id: string; paypalCaptureId: string; status: string }>(`SELECT id, paypalCaptureId, status FROM Payment WHERE orderId = ? AND installmentId = ? AND status = 'COMPLETED'`, co.orderId, co.installments[1].id);
  const before = order(co.orderId);
  const denied = await (await request.post(`${PAYPAL}/__mock/send-webhook/${cap.paypalCaptureId}?event_type=PAYMENT.CAPTURE.DENIED`)).json();
  expect(denied.status, JSON.stringify(denied)).toBeLessThan(500);
  const tampered = await (await request.post(`${PAYPAL}/__mock/send-webhook/${cap.paypalCaptureId}?event_type=PAYMENT.CAPTURE.COMPLETED&tamper=signature`)).json();
  expect(tampered.status).toBe(400);
  const tamperedBody = await (await request.post(`${PAYPAL}/__mock/send-webhook/${cap.paypalCaptureId}?event_type=PAYMENT.CAPTURE.COMPLETED&tamper=body`)).json();
  expect(tamperedBody.status).toBe(400);
  expect(one<{ status: string }>(`SELECT status FROM Payment WHERE id = ?`, cap.id).status).toBe("COMPLETED");
  const after = order(co.orderId);
  expect({ s: after.status, p: after.amountPaidCents, b: after.balanceCents }).toEqual({ s: before.status, p: before.amountPaidCents, b: before.balanceCents });
  expect(paidSeqs(co.orderId)).toEqual([1, 2]);
  expect(await moodleCourses(request, S.uid)).toHaveLength(2);
});

test("G3 · doble clic en «Aprobar pago» de la cuota 3 → se imputa una vez", async ({ browser, page, request }) => {
  const co = S.co!;
  const ins3 = co.installments[2];
  await adminRemind(browser, co.orderId, 3);
  const ref = newRef();
  await payManual(page, lastReminder(co.orderId).manual!, ins3.amountCents, ref);
  const approvedBefore = mailsOf(co.orderId).filter((m) => m.template === "payment_approved").length;
  const { page: admin, close } = await adminPage(browser, `/admin/orders/${co.orderId}`);
  try {
    const card = admin.getByTestId("payment").filter({ hasText: ref });
    await card.getByRole("button", { name: "Aprobar pago" }).dblclick();
    await expect(admin.getByRole("status").filter({ hasText: /Pago aprobado/ })).toBeVisible({ timeout: 60_000 });
  } finally {
    await close();
  }
  await expect.poll(() => paidSeqs(co.orderId), { timeout: 30_000 }).toEqual([1, 2, 3]);
  await expect.poll(() => moodleCourses(request, S.uid), { timeout: 30_000 }).toEqual(S.C!.courses.slice(0, 3).map((c) => c.moodleCourseId).sort((a, b) => a - b));
  expect(order(co.orderId).amountPaidCents).toBe(3 * ins3.amountCents);
  expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND type = 'PAYMENT_RECEIVED'`, co.orderId)).toHaveLength(3);
  expect(mailsOf(co.orderId).filter((m) => m.template === "payment_approved").length - approvedBefore).toBe(1);
});

test("G4 · Moodle lento al matricular la cuota 4 y «Rematricular» a la vez → curso 4 una vez y un solo aviso", async ({ browser, page, request }) => {
  const co = S.co!;
  const C = S.C!;
  const ins4 = co.installments[3];
  await adminRemind(browser, co.orderId, 4);
  const ref = newRef();
  await payManual(page, lastReminder(co.orderId).manual!, ins4.amountCents, ref);
  const a = await adminPage(browser, `/admin/orders/${co.orderId}`);
  const b = await adminPage(browser, `/admin/orders/${co.orderId}`);
  try {
    expect((await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "ok", delayMs: 5000, count: 1 } })).ok()).toBe(true);
    const approve = (async () => {
      await a.page.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
      await expect(a.page.getByRole("status").filter({ hasText: /Pago aprobado/ })).toBeVisible({ timeout: 60_000 });
    })();
    // Mientras la aprobación espera a Moodle, el admin (otra pestaña) pulsa «Rematricular».
    await expect.poll(() => paidSeqs(co.orderId), { timeout: 30_000 }).toEqual([1, 2, 3, 4]);
    await b.page.getByRole("button", { name: "Rematricular" }).first().click();
    await b.page.getByRole("dialog").getByRole("button", { name: "Rematricular" }).click();
    await expect(b.page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
    await approve;
  } finally {
    await request.post(`${MOODLE}/__mock/fail-clear`);
    await a.close();
    await b.close();
  }
  await runCron(request, "enrollments");
  await expect.poll(() => moodleCourses(request, S.uid), { timeout: 30_000 }).toEqual(C.courses.slice(0, 4).map((c) => c.moodleCourseId).sort((x, y) => x - y));
  const access4 = mailsOf(co.orderId).filter((m) => m.template === "platform_access" && m.text.includes(C.courses[3].title));
  expect(access4, "un solo aviso de acceso del curso 4").toHaveLength(1);
  expect(q(`SELECT id FROM Enrollment WHERE customerId = ? AND moodleCourseId = ?`, customerOf(co.orderId).id, C.courses[3].moodleCourseId)).toHaveLength(1);
});

test("G5 · retiro a mitad de camino desde el panel con Moodle caído al desmatricular → reembolso, cupo libre, luego sin cursos y sin más cobros", async ({ browser, page, request }) => {
  const co = S.co!;
  const C = S.C!;
  await adminRemind(browser, co.orderId, 5);
  const rem5 = lastReminder(co.orderId);
  const seatsBefore = cohort(C.cohortId);
  const pp = q<{ id: string; paypalCaptureId: string; amountCents: number }>(`SELECT id, paypalCaptureId, amountCents FROM Payment WHERE orderId = ? AND method = 'PAYPAL' AND status = 'COMPLETED' ORDER BY createdAt`, co.orderId);
  expect(pp).toHaveLength(2);
  expect((await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_unenrol_users", type: "http", status: 503, count: 20 } })).ok()).toBe(true);
  const { page: admin, close } = await adminPage(browser, `/admin/orders/${co.orderId}`);
  try {
    // Reembolsa el primer pago PayPal (cuota 1) con desmatrícula: retiro del programa.
    await admin.getByRole("button", { name: "Reembolsar", exact: true }).first().click();
    const form = admin.getByRole("form", { name: "Reembolsar pago" }).first();
    await expect(form).toBeVisible();
    await form.getByLabel("Motivo").fill("Retiro del programa");
    const un = form.getByRole("checkbox", { name: /Desmatricular de Moodle/ });
    if (!(await un.isChecked())) await un.check();
    const rel = form.getByRole("checkbox", { name: /Liberar el cupo/ });
    if (!(await rel.isChecked())) await rel.check();
    await form.getByRole("button", { name: "Reembolsar" }).click();
    await waitForOrderStatus(co.orderId, "REFUNDED", 60_000);
  } finally {
    await close();
  }
  expect(cohort(C.cohortId).seatsConfirmed, "cupo liberado").toBe(seatsBefore.seatsConfirmed - 1);
  const refunds = q<{ status: string }>(`SELECT r.status FROM Refund r JOIN Payment p ON p.id = r.paymentId WHERE p.orderId = ?`, co.orderId);
  expect(refunds.length).toBeGreaterThan(0);
  expect(refunds.every((r) => r.status === "COMPLETED")).toBe(true);
  // Moodle sigue caído: el médico aún ve sus cursos; al volver, el job los quita TODOS.
  expect((await moodleCourses(request, S.uid)).length).toBeGreaterThan(0);
  await request.post(`${MOODLE}/__mock/fail-clear`);
  await expect
    .poll(async () => {
      await runCron(request, "enrollments");
      return moodleCourses(request, S.uid);
    }, { timeout: 90_000, intervals: [2_000, 3_000, 5_000] })
    .toEqual([]);
  // El enlace PayPal del último recordatorio ya no cobra.
  const ppOrdersBefore = (await paypalState(request)).orders.length;
  await page.goto(rem5.paypal!);
  const btn = page.getByRole("button", { name: /con PayPal/ });
  if (await btn.count()) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(2_000);
  }
  expect(page.url().startsWith(PAYPAL), "no debe llevar a PayPal").toBe(false);
  expect((await paypalState(request)).orders.length).toBe(ppOrdersBefore);
  const remBefore = mailsOf(co.orderId).filter((m) => m.template === "installment_reminder").length;
  await runCron(request, "installments");
  expect(mailsOf(co.orderId).filter((m) => m.template === "installment_reminder").length).toBe(remBefore);
  // Los cursos 1..4 se desmatricularon en la BD también (ninguna fila ENROLLED del pedido).
  expect(q(`SELECT status FROM Enrollment WHERE customerId = ? AND status = 'ENROLLED'`, customerOf(co.orderId).id)).toEqual([]);
});
