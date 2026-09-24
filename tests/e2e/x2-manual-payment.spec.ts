// Pieza x2 — Pago móvil → verificación del admin → Moodle → cupo → correos, y reembolso de PayPal.
// De punta a punta por HTTP contra la app y los mocks (Moodle REST y PayPal Orders v2/Payments/Webhooks), sin
// pasos humanos:
//   0. Pago móvil viene DESHABILITADO (datos bancarios «TODO»): el checkout no lo ofrece y la configuración no
//      deja habilitarlo con datos de ejemplo. Se habilita con datos reales como lo hace el panel (updateSetting,
//      auditado) y la tienda lo ofrece.
//   1. Un médico compra un CURSO SEMIPRESENCIAL (cohorte nueva de Barquisimeto, cupo 3) en /checkout con Pago
//      Móvil, registra el pago en /pedido/<token> con referencia, monto en Bs. y comprobante (imagen) →
//      pedido AWAITING_VERIFICATION, cupo HELD, correo «en verificación».
//      El admin inicia sesión, abre /admin/orders, filtra «En verificación», abre el pedido, VE el comprobante
//      (la imagen servida por el panel es byte a byte la subida; sin sesión, 401) y aprueba → Moodle: usuario
//      creado y matriculado en el curso una sola vez; cupo CONFIRMED; correos de pago aprobado, acceso y cohorte.
//   2. Otro médico, mismo flujo; el admin rechaza con motivo → pedido REJECTED, cupo liberado, correo de rechazo
//      con el motivo, nada en Moodle.
//   3. Un médico paga con PayPal (checkout → PayPal mock → retorno) → ENROLLED. El admin reembolsa desde la
//      ficha del pedido con «Desmatricular» marcado → llamada de reembolso a PayPal, cupo liberado, desmatrícula
//      en Moodle, correo de reembolso, historial completo (quién/cuándo/qué en cada paso).
//   4. Igual, con «Desmatricular» desmarcado → PayPal reembolsa y el cupo se libera, pero Moodle NO se toca.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-manual-payment.spec.ts
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, enrolCallsFor, enrollments, fixture, moodleCalls, moodleState, one, order, payments, q, reservationOf, uniqueEmail, waitForOrderStatus } from "./support/purchase";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const COURSE = "curso-universitario-ecografia-de-abdomen";
const CAPACITY = 3;
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
const PAGO_MOVIL_SHIPPED = {
  method: "PAGO_MOVIL",
  enabled: false,
  label: "Pago móvil",
  currency: "VES",
  details: { banco: "TODO: banco (código)", telefono: "TODO: 04xx-xxxxxxx", cedulaRif: "TODO: V-/J-xxxxxxxx", titular: "TODO: titular" },
  instructions: "Realiza el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante.",
};
const OTHERS_OFF = [
  { method: "TRANSFERENCIA", enabled: false, label: "Transferencia bancaria", currency: "VES", details: { banco: "TODO: banco" }, instructions: "" },
  { method: "ZELLE", enabled: false, label: "Zelle", currency: "USD", details: { correo: "TODO: correo Zelle" }, instructions: "" },
  { method: "EFECTIVO", enabled: false, label: "Efectivo en sede", currency: "USD", details: { lugar: "TODO: sede y horario" }, instructions: "" },
];

interface CourseCohort {
  productId: string;
  productTitle: string;
  moodleCourseId: number;
  sedeSlug: string;
  sedeName: string;
  cohortId: string;
  cohortName: string;
  capacity: number;
}
let C: CourseCohort;
let settingsBefore: unknown = null;

// ───────────── utilidades ─────────────

/** PNG real (RGB, sin compresión con pérdida) para el comprobante: el panel debe servir exactamente estos bytes. */
function proofPng(w = 240, h = 120): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 9;
      raw[o + 1] = 176 - ((x + y) % 40);
      raw[o + 2] = 176;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const ordersOf = (email: string) =>
  q<{ id: string; token: string; number: number; status: string; paymentMethod: string; dueNowCents: number; totalCents: number }>(
    `SELECT o.id, o.token, o.number, o.status, o.paymentMethod, o.dueNowCents, o.totalCents FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`,
    email,
  );

const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function fillDoctor(page: Page, email: string, first: string, last: string) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill(first);
  await page.getByLabel("Apellidos").fill(last);
  await page.getByLabel("Cédula de identidad").fill("V-14567890");
  await page.getByLabel("Ciudad (opcional)").fill("Barquisimeto");
  await page.getByLabel("Especialidad").selectOption("Medicina general");
}

async function cartWithCohort(page: Page) {
  const res = await page.goto(`/cart/add?product=${COURSE}&modality=SEMIPRESENCIAL&sede=${C.sedeSlug}&cohort=${C.cohortId}&plan=FULL`);
  expect(res?.url()).not.toContain("error=");
}

/** El médico: carrito → checkout con Pago Móvil (reserva 72 h) → /pedido/<token> → registra el pago con comprobante. */
async function buyWithPagoMovil(page: Page, email: string, name: [string, string], reference: string) {
  await cartWithCohort(page);
  await page.goto("/checkout");
  await fillDoctor(page, email, ...name);
  await page.getByText("Pago Móvil", { exact: true }).click();
  await page.getByRole("button", { name: "Reservar mi cupo y ver datos de pago" }).click();
  await page.waitForURL(/\/checkout\?pedido=creado$/);
  const [o] = ordersOf(email);
  expect(o).toMatchObject({ status: "PENDING_PAYMENT", paymentMethod: "PAGO_MOVIL" });
  await expect(page.getByTestId("method-details")).toContainText("0412-0840407");
  const amountBs = Math.round(o.dueNowCents * RATE);
  await expect(page.getByTestId("method-amount")).toContainText(ves(amountBs));

  await page.getByTestId("report-payment").click();
  await page.waitForURL(new RegExp(`/pedido/${o.token}`));
  await page.getByLabel("Número de referencia").fill(reference);
  await page.getByLabel(/Monto pagado/).fill(ves(amountBs));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante-pago-movil.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=registrado/);
  // La página del pedido (la re-estiliza la tienda) dice que el pago está en verificación.
  await expect(page.getByRole("heading").filter({ hasText: /verific/i }).first()).toBeVisible();
  return { ...o, amountBs };
}

async function adminLogin(browser: Browser) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/admin/orders");
  await expect(page).toHaveURL(/\/admin\/login/); // sin sesión, el panel pide iniciar sesión
  await page.goto(`/admin/login?next=${encodeURIComponent("/admin/orders")}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === "/admin/orders");
  await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible();
  const admin = one<{ id: string }>(`SELECT id FROM AdminUser WHERE email = ?`, ADMIN_EMAIL);
  return { ctx, page, adminId: admin.id };
}

async function openOrderInAdmin(page: Page, number: number, view?: string) {
  await page.goto(view ? `/admin/orders?status=${view}` : "/admin/orders");
  await page.getByRole("link", { name: `#${number}`, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Pedido #${number}` })).toBeVisible();
}

async function paypalRefunds(request: APIRequestContext) {
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown };
  const list = Array.isArray(st.refunds) ? st.refunds : Object.values((st.refunds ?? {}) as Record<string, unknown>);
  return list as { id: string; status: string; amount: { value: string; currency_code: string }; invoice_id?: string; links?: { href: string }[] }[];
}

type Ev = { type: string; actorType: string; actorId: string | null; note: string | null; data: string | null; fromStatus: string | null; toStatus: string | null };
const fullEvents = (orderId: string) =>
  q<Ev>(`SELECT type, actorType, actorId, note, data, fromStatus, toStatus FROM OrderEvent WHERE orderId = ? ORDER BY createdAt, id`, orderId);

// ───────────── preparación ─────────────

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_SHIPPED, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  C = fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity: CAPACITY, name: `Cohorte x2 ${Date.now().toString(36)}` });
  expect(C.moodleCourseId).toBeGreaterThan(0);
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 0 });
});

test.afterAll(() => {
  // Deja los métodos como estaban antes de la corrida (otros specs del carril los configuran a su gusto).
  if (Array.isArray(settingsBefore)) {
    try {
      fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
    } catch {
      /* datos previos no válidos para updateSetting: se quedan los de esta corrida */
    }
  }
});

// ───────────── 0. configuración ─────────────

test("pago móvil viene deshabilitado; no se habilita con datos de ejemplo; con datos reales la tienda lo ofrece", async ({ page }) => {
  await cartWithCohort(page);
  await page.goto("/checkout");
  await expect(page.getByRole("radio", { name: "PayPal" })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Pago m[óo]vil/i })).toHaveCount(0);

  // Habilitarlo con los datos «TODO» del seed: la configuración lo rechaza.
  expect(() => fixture("setting", { key: "payments.manualMethods", value: [{ ...PAGO_MOVIL_SHIPPED, enabled: true }, ...OTHERS_OFF] })).toThrow();

  // Con los datos reales (como en el panel de configuración): auditado y ofrecido en el checkout.
  fixture("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] });
  const audit = one<{ actorEmail: string; action: string; after: string }>(`SELECT actorEmail, action, after FROM AuditLog WHERE entityType = 'Setting' AND entityId = 'payments.manualMethods' ORDER BY createdAt DESC LIMIT 1`);
  expect(audit.actorEmail).toBe(ADMIN_EMAIL);
  expect(audit.after).toContain("0412-0840407");

  await page.goto("/checkout");
  await page.getByText("Pago Móvil", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Pago Móvil" })).toBeChecked();
  await expect(page.getByTestId("hold-ttl")).toHaveText("72 h");
});

// ───────────── 1. pago móvil aprobado ─────────────

test("pago móvil con comprobante → en verificación → el admin ve el comprobante y aprueba → Moodle, cupo y correos", async ({ page, browser, request }) => {
  const email = uniqueEmail("x2ok");
  const reference = `0134${Date.now().toString().slice(-8)}`;
  const o = await buyWithPagoMovil(page, email, ["Ana Lucía", "Mendoza Torres"], reference);

  // Pedido en verificación, cupo HELD, pago con comprobante guardado fuera de public/.
  expect(order(o.id).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(o.id).status).toBe("HELD");
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: 1, seatsConfirmed: 0 });
  const [pay] = q<{ id: string; status: string; method: string; currency: string; amountCents: number; amountUsdCents: number; reference: string; bank: string; proofFile: string; exchangeRate: string }>(
    `SELECT id, status, method, currency, amountCents, amountUsdCents, reference, bank, proofFile, exchangeRate FROM Payment WHERE orderId = ?`,
    o.id,
  );
  expect(pay).toMatchObject({ status: "AWAITING_VERIFICATION", method: "PAGO_MOVIL", currency: "VES", amountCents: o.amountBs, reference, bank: "Banesco (0134)" });
  expect(pay.amountUsdCents).toBe(o.dueNowCents);
  expect(pay.proofFile).toMatch(/proofs[\\/].+\.png$/);
  expect(pay.proofFile).not.toContain("public");

  // Correo «en verificación» (y antes, el de pedido recibido con los datos de pago).
  await expect.poll(() => emails(o.id).map((e) => e.template)).toEqual(expect.arrayContaining(["order_confirmation", "payment_under_verification"]));
  const verif = emails(o.id).find((e) => e.template === "payment_under_verification")!;
  expect(verif.to).toBe(email);
  expect(verif.subject).toMatch(/verific/i);
  expect(verif.text).toContain(reference);
  expect(emails(o.id).map((e) => e.template)).not.toContain("payment_approved");
  expect(customerOf(o.id).moodleUserId).toBeNull();

  // El comprobante NO es público: sin sesión del panel → 401.
  const anon = await request.get(`/admin/orders/${o.id}/comprobante/${pay.id}`);
  expect(anon.status()).toBe(401);

  // El admin: login → Pedidos → «En verificación» → pedido → ve el comprobante.
  const { ctx, page: admin, adminId } = await adminLogin(browser);
  try {
    await expect(admin.getByRole("status").filter({ hasText: "por verificar" })).toBeVisible();
    await openOrderInAdmin(admin, o.number, "AWAITING_VERIFICATION");
    await expect(admin.getByTestId("order-status")).toHaveText("En verificación");
    await expect(admin.getByTestId("seat-status")).toContainText("Reservado");
    const card = admin.getByTestId("payment").filter({ hasText: reference });
    await expect(card.getByTestId("payment-status")).toHaveText("Por verificar");
    await expect(card).toContainText(`Bs. ${ves(o.amountBs)}`);
    await expect(card).toContainText("Banesco (0134)");
    const img = card.getByTestId("proof").getByRole("img", { name: /Comprobante/ });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(240);
    const served = await admin.request.get(`/admin/orders/${o.id}/comprobante/${pay.id}`);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/png");
    expect(Buffer.from(await served.body()).equals(proofPng())).toBe(true);

    // Aprobar.
    await card.getByRole("button", { name: "Aprobar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
    await waitForOrderStatus(o.id, "ENROLLED");
    await admin.reload();
    await expect(admin.getByTestId("order-status")).toHaveText("Inscrito");
    await expect(admin.getByTestId("seat-status")).toContainText("Ocupado");
    await expect(admin.getByTestId("payment").filter({ hasText: reference }).getByTestId("payment-status")).toHaveText("Confirmado");
    await expect(admin.getByTestId("payment").filter({ hasText: reference })).toContainText("Administrador CEIUM");
    await expect(admin.getByTestId("enrollments")).toContainText("Matriculado");
    for (const t of ["Pago aprobado", "Acceso a la plataforma", "Datos de la cohorte"]) await expect(admin.getByTestId("emails")).toContainText(t);
    await expect(admin.getByTestId("timeline")).toContainText("Pago aprobado");

    // Pago verificado por el admin; historial con quién y cuándo.
    expect(payments(o.id)[0].status).toBe("COMPLETED");
    const verified = one<{ verifiedById: string; verifiedAt: number | null }>(`SELECT verifiedById, verifiedAt FROM Payment WHERE id = ?`, pay.id);
    expect(verified.verifiedById).toBe(adminId);
    expect(verified.verifiedAt).toBeTruthy();
    const ev = fullEvents(o.id);
    expect(ev.find((e) => e.type === "PAYMENT_SUBMITTED")).toMatchObject({ actorType: "CUSTOMER" });
    expect(ev.find((e) => e.type === "PAYMENT_VERIFIED")).toMatchObject({ actorType: "ADMIN", actorId: adminId });
    expect(ev.filter((e) => e.type === "STATUS_CHANGE").map((e) => `${e.fromStatus}→${e.toStatus}`)).toEqual(
      expect.arrayContaining(["PENDING_PAYMENT→AWAITING_VERIFICATION", "AWAITING_VERIFICATION→PAID", "PAID→ENROLLED"]),
    );
  } finally {
    await ctx.close();
  }

  // Cupo: HELD → CONFIRMED, contado exactamente una vez.
  expect(reservationOf(o.id).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 1 });

  // Moodle: usuario creado una vez (por correo) y matriculado una vez en el curso.
  const cust = customerOf(o.id);
  expect(cust.moodleUserId).toBeGreaterThan(0);
  const st = await moodleState(request);
  expect(st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase())).toHaveLength(1);
  expect(st.enrolments.filter((e) => e.userid === cust.moodleUserId)).toEqual([expect.objectContaining({ courseid: C.moodleCourseId, status: 0 })]);
  expect(enrolCallsFor(await moodleCalls(request), cust.moodleUserId!)).toEqual([C.moodleCourseId]);
  expect(enrollments(o.id)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "ENROLLED" }]);

  // Correos: aprobado, acceso a la plataforma (usuario + enlace), datos de la cohorte.
  const mail = emails(o.id);
  const byT = (t: string) => mail.filter((m) => m.template === t);
  for (const t of ["payment_approved", "platform_access", "cohort_details"]) expect(byT(t), t).toHaveLength(1);
  expect(mail.every((m) => m.to === email && m.status === "SENT")).toBe(true);
  expect(byT("platform_access")[0].text).toContain(cust.moodleUsername!);
  expect(byT("platform_access")[0].text).toContain(`${MOODLE}/login/index.php`);
  expect(byT("cohort_details")[0].text).toContain(C.cohortName);
  expect(byT("cohort_details")[0].text).toContain(C.sedeName);

  // El médico ve su pedido inscrito.
  await page.goto(`/pedido/${o.token}`);
  await expect(page.getByRole("heading").filter({ hasText: /inscri(to|pci[óo]n est[áa] confirmada)/i }).first()).toBeVisible();
});

// ───────────── 2. pago móvil rechazado ─────────────

test("segundo pedido: el admin rechaza el pago con motivo → cupo liberado, correo de rechazo, nada en Moodle", async ({ page, browser, request }) => {
  const email = uniqueEmail("x2rej");
  const reference = `0102${Date.now().toString().slice(-8)}`;
  const before = cohort(C.cohortId);
  const o = await buyWithPagoMovil(page, email, ["Pedro José", "Rangel Suárez"], reference);
  expect(order(o.id).status).toBe("AWAITING_VERIFICATION");
  expect(cohort(C.cohortId)).toEqual({ ...before, seatsHeld: before.seatsHeld + 1 });
  const payId = payments(o.id)[0].id;

  const REASON = "La referencia no aparece en el estado de cuenta del banco.";
  const { ctx, page: admin, adminId } = await adminLogin(browser);
  try {
    await openOrderInAdmin(admin, o.number, "AWAITING_VERIFICATION");
    const card = admin.getByTestId("payment").filter({ hasText: reference });
    await expect(card.getByTestId("proof").getByRole("img", { name: /Comprobante/ })).toBeVisible();
    // Sin motivo no se puede rechazar (el navegador lo exige y el servicio también).
    await card.getByRole("button", { name: "Rechazar pago" }).click();
    expect(order(o.id).status).toBe("AWAITING_VERIFICATION");
    await card.getByRole("form", { name: "Rechazar pago" }).getByLabel("Motivo del rechazo").fill(REASON);
    await card.getByRole("button", { name: "Rechazar pago" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Pago rechazado" })).toBeVisible();
    await expect(admin.getByTestId("order-status")).toHaveText("Rechazado");
    await expect(admin.getByTestId("seat-status")).toContainText("Liberado");
    await expect(admin.getByTestId("payment").filter({ hasText: reference })).toContainText(REASON);
    await expect(admin.getByTestId("timeline")).toContainText("Cupo liberado");
    await expect(admin.getByTestId("emails")).toContainText("Pago rechazado");

    const ev = fullEvents(o.id);
    expect(ev.find((e) => e.type === "PAYMENT_REJECTED")).toMatchObject({ actorType: "ADMIN", actorId: adminId, note: REASON });
    expect(ev.find((e) => e.type === "SEAT_RELEASED")).toMatchObject({ actorType: "ADMIN", actorId: adminId });
    expect(ev.find((e) => e.type === "STATUS_CHANGE" && e.toStatus === "REJECTED")).toMatchObject({ actorType: "ADMIN", actorId: adminId, fromStatus: "AWAITING_VERIFICATION" });
  } finally {
    await ctx.close();
  }

  expect(order(o.id).status).toBe("REJECTED");
  expect(payments(o.id)[0].status).toBe("REJECTED");
  expect(one<{ rejectionReason: string; referenceKey: string | null }>(`SELECT rejectionReason, referenceKey FROM Payment WHERE id = ?`, payId)).toEqual({ rejectionReason: REASON, referenceKey: null });
  expect(reservationOf(o.id).status).toBe("RELEASED");
  expect(one<{ releasedReason: string }>(`SELECT releasedReason FROM SeatReservation WHERE orderId = ?`, o.id).releasedReason).toBe("REJECTED");
  expect(cohort(C.cohortId)).toEqual(before);

  const rej = emails(o.id).filter((m) => m.template === "payment_rejected");
  expect(rej).toHaveLength(1);
  expect(rej[0]).toMatchObject({ to: email, status: "SENT" });
  expect(rej[0].text).toContain(REASON);
  expect(emails(o.id).map((m) => m.template)).not.toEqual(expect.arrayContaining(["payment_approved"]));
  expect(emails(o.id).map((m) => m.template)).not.toContain("platform_access");

  // Nada en Moodle para este médico.
  expect(customerOf(o.id).moodleUserId).toBeNull();
  expect((await moodleState(request)).users.some((u) => u.email.toLowerCase() === email.toLowerCase())).toBe(false);

  // El médico ve el rechazo.
  await page.goto(`/pedido/${o.token}`);
  await expect(page.getByRole("heading").filter({ hasText: /rechaz/i }).first()).toBeVisible();
});

// ───────────── 3/4. reembolso de PayPal ─────────────

async function buyWithPaypal(page: Page, email: string, name: [string, string]) {
  await cartWithCohort(page);
  await page.goto("/checkout");
  await fillDoctor(page, email, ...name);
  await page.getByRole("button", { name: "Pagar con PayPal" }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL((u) => u.pathname.startsWith("/pedido/") && !u.pathname.includes("/paypal/"), { timeout: 60_000 });
  const [o] = ordersOf(email);
  await waitForOrderStatus(o.id, "ENROLLED", 45_000);
  return o;
}

async function refundInAdmin(browser: Browser, number: number, opts: { unenroll: boolean; reason: string }) {
  const { ctx, page: admin, adminId } = await adminLogin(browser);
  await openOrderInAdmin(admin, number, "ENROLLED");
  const card = admin.getByTestId("payment").filter({ hasText: "PayPal" });
  await expect(card.getByTestId("payment-status")).toHaveText("Confirmado");
  await card.getByTestId("refund").locator("summary").click();
  const form = card.getByRole("form", { name: "Reembolsar pago" });
  await form.getByLabel("Motivo").fill(opts.reason);
  const unenroll = form.getByRole("checkbox", { name: /Desmatricular de Moodle/ });
  await expect(unenroll).toBeChecked();
  if (!opts.unenroll) await unenroll.uncheck();
  await expect(form.getByRole("checkbox", { name: /Liberar el cupo/ })).toBeChecked();
  await form.getByRole("button", { name: "Reembolsar" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Reembolso completado" })).toBeVisible();
  await expect(admin.getByTestId("order-status")).toHaveText("Reembolsado");
  await expect(admin.getByTestId("seat-status")).toContainText("Liberado");
  await expect(admin.getByTestId("refunds")).toContainText("completado");
  return { ctx, admin, adminId };
}

for (const unenroll of [true, false]) {
  test(`reembolso de un pedido PayPal desde el panel (${unenroll ? "desmatricular" : "sin desmatricular"}) → PayPal, cupo, Moodle según la opción, correo e historial`, async ({ page, browser, request }) => {
    const email = uniqueEmail(unenroll ? "x2ref" : "x2refkeep");
    const before = cohort(C.cohortId);
    const o = await buyWithPaypal(page, email, unenroll ? ["Carmen", "Gil Rojas"] : ["Luis", "Ortega Páez"]);
    expect(reservationOf(o.id).status).toBe("CONFIRMED");
    expect(cohort(C.cohortId)).toEqual({ ...before, seatsConfirmed: before.seatsConfirmed + 1 });
    const cust = customerOf(o.id);
    expect((await moodleState(request)).enrolments.filter((e) => e.userid === cust.moodleUserId).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
    const [pp] = payments(o.id).filter((p) => p.status === "COMPLETED");
    expect(pp.paypalCaptureId).toBeTruthy();
    const refundsBefore = (await paypalRefunds(request)).length;
    // Por tiempo, no por índice: el mock guarda solo las últimas 200 llamadas (un slice por índice queda vacío).
    const callsSince = Date.now();

    const reason = unenroll ? "El médico no podrá asistir a la cohorte." : "Reembolso de cortesía; conserva el acceso al aula virtual.";
    const { ctx, admin, adminId } = await refundInAdmin(browser, o.number, { unenroll, reason });
    try {
      // PayPal: una llamada de reembolso por el total de la captura, con el PayPal-Request-Id/invoice del panel.
      const refunds = (await paypalRefunds(request)).slice(refundsBefore);
      const mine = refunds.filter((r) => JSON.stringify(r).includes(pp.paypalCaptureId!));
      expect(mine).toHaveLength(1);
      expect(mine[0].status).toBe("COMPLETED");
      expect(Math.round(Number(mine[0].amount.value) * 100)).toBe(pp.amountCents);
      const row = one<{ id: string; status: string; providerRefundId: string; amountCents: number; createdById: string; options: string; reason: string }>(
        `SELECT r.id, r.status, r.providerRefundId, r.amountCents, r.createdById, r.options, r.reason FROM Refund r WHERE r.paymentId = ?`,
        pp.id,
      );
      expect(row).toMatchObject({ status: "COMPLETED", providerRefundId: mine[0].id, amountCents: pp.amountCents, createdById: adminId, reason });
      expect(JSON.parse(row.options)).toMatchObject({ unenroll, releaseSeat: true });
      expect(mine[0].invoice_id).toBe(`refund-${row.id}`);

      // Pedido y cupo.
      await waitForOrderStatus(o.id, "REFUNDED");
      expect(order(o.id)).toMatchObject({ status: "REFUNDED", amountPaidCents: 0, balanceCents: 0 });
      expect(payments(o.id).find((p) => p.id === pp.id)!.status).toBe("REFUNDED");
      expect(reservationOf(o.id).status).toBe("RELEASED");
      expect(cohort(C.cohortId)).toEqual(before);

      // Moodle según la opción del reembolso.
      const after = (await moodleCalls(request)).filter((c) => c.at >= callsSince);
      const unenrolCalls = after.filter((c) => c.wsfunction === "enrol_manual_unenrol_users" && JSON.stringify(c.params).includes(String(cust.moodleUserId)));
      const stillEnrolled = (await moodleState(request)).enrolments.filter((e) => e.userid === cust.moodleUserId).map((e) => e.courseid);
      if (unenroll) {
        expect(unenrolCalls).toHaveLength(1);
        expect(stillEnrolled).toEqual([]);
        expect(enrollments(o.id)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "UNENROLLED" }]);
        await admin.reload();
        await expect(admin.getByTestId("enrollments")).toContainText("Desmatriculado");
      } else {
        expect(unenrolCalls).toHaveLength(0);
        expect(stillEnrolled).toEqual([C.moodleCourseId]);
        expect(enrollments(o.id)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "ENROLLED" }]);
      }

      // Correo de reembolso (una vez, aunque el webhook PAYMENT.CAPTURE.REFUNDED también llegue).
      await expect.poll(() => emails(o.id).filter((m) => m.template === "refund_issued").length).toBe(1);
      const refundMail = emails(o.id).find((m) => m.template === "refund_issued")!;
      expect(refundMail).toMatchObject({ to: email, status: "SENT" });
      expect(refundMail.text).toContain(reason);
      // El webhook de PayPal confirmó el mismo reembolso sin duplicarlo.
      await expect.poll(() => q(`SELECT id FROM Refund WHERE paymentId = ?`, pp.id).length).toBe(1);

      // Historial completo: pedido, pago, matrícula y, del reembolso, quién lo pidió, con qué opciones, qué pasó
      // con el cupo, el estado y Moodle.
      const ev = fullEvents(o.id);
      const types = ev.map((e) => e.type);
      for (const t of ["CREATED", "PAYPAL_ORDER_CREATED", "ENROLLMENT", "REFUND_REQUESTED", "REFUND", "SEAT_RELEASED"]) expect(types, t).toContain(t);
      const req = ev.find((e) => e.type === "REFUND_REQUESTED")!;
      expect(req).toMatchObject({ actorType: "ADMIN", actorId: adminId, note: reason });
      expect(JSON.parse(req.data!)).toMatchObject({ paymentId: pp.id, refundId: row.id, amountCents: pp.amountCents, options: { unenroll, releaseSeat: true } });
      const applied = ev.find((e) => e.type === "REFUND")!;
      expect(applied).toMatchObject({ actorType: "ADMIN", actorId: adminId });
      expect(JSON.parse(applied.data!)).toMatchObject({ refundId: row.id, amountCents: pp.amountCents, manual: false, options: { unenroll, releaseSeat: true } });
      expect(ev.find((e) => e.type === "SEAT_RELEASED")).toMatchObject({ actorType: "ADMIN", actorId: adminId });
      expect(JSON.parse(ev.find((e) => e.type === "SEAT_RELEASED")!.data!)).toMatchObject({ cohortId: C.cohortId, previousStatus: "CONFIRMED", reason: "REFUNDED" });
      expect(ev.find((e) => e.type === "STATUS_CHANGE" && e.toStatus === "REFUNDED")).toMatchObject({ actorType: "ADMIN", actorId: adminId, fromStatus: "ENROLLED" });
      if (unenroll) {
        const un = ev.find((e) => e.type === "UNENROLLMENT")!;
        expect(un).toMatchObject({ actorType: "ADMIN", actorId: adminId });
        expect(JSON.parse(un.data!).courseIds).toEqual([C.moodleCourseId]);
      } else {
        expect(types).not.toContain("UNENROLLMENT");
      }
      expect(ev.every((e) => e.actorType !== "ADMIN" || e.actorId === adminId)).toBe(true);
      // …y lo mismo se lee en la ficha del pedido.
      await admin.reload();
      const tl = admin.getByTestId("timeline");
      for (const t of ["Reembolso solicitado", "Reembolso aplicado", "Cupo liberado", "Administrador CEIUM (admin@ceium.net)"]) await expect(tl).toContainText(t);
      if (unenroll) await expect(tl).toContainText("Desmatrícula en Moodle");
      await expect(admin.getByTestId("emails")).toContainText("Reembolso");
    } finally {
      await ctx.close();
    }
    // Sin sesión, la ficha del pedido no se muestra.
    await page.goto(`/admin/orders/${o.id}`);
    await expect(page).toHaveURL(/\/admin\/login/);
  });
}

// ───────────── 5. verificación: el pago debe pertenecer al pedido abierto ─────────────

test("aprobar desde la ficha de un pedido con el paymentId de OTRO pedido → rechazado sin tocar el otro pago, su cupo, Moodle ni correos", async ({ page, browser, request }) => {
  // Independiente de los casos anteriores: pago móvil habilitado con datos reales y una cohorte propia.
  fixture("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] });
  C = fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity: CAPACITY, name: `Cohorte x2own ${Date.now().toString(36)}` });
  const ctxB = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const emailA = uniqueEmail("x2owna");
  const emailB = uniqueEmail("x2ownb");
  const refA = `0105${Date.now().toString().slice(-8)}`;
  const refB = `0108${(Date.now() + 1).toString().slice(-8)}`;
  try {
    const a = await buyWithPagoMovil(page, emailA, ["Luisa", "Pérez Díaz"], refA);
    const b = await buyWithPagoMovil(await ctxB.newPage(), emailB, ["Tomás", "Rivas León"], refB);
    const payA = payments(a.id)[0].id;
    const payB = payments(b.id)[0].id;
    const snapB = () => ({
      order: order(b.id).status,
      payment: one<{ status: string; verifiedAt: string | null; verifiedById: string | null }>(`SELECT status, verifiedAt, verifiedById FROM Payment WHERE id = ?`, payB),
      seat: reservationOf(b.id).status,
      emails: emails(b.id).map((m) => m.template).sort(),
      events: fullEvents(b.id).length,
    });
    const beforeB = snapB();
    expect(beforeB).toMatchObject({ order: "AWAITING_VERIFICATION", seat: "HELD", payment: { status: "AWAITING_VERIFICATION", verifiedById: null } });
    const cohortBefore = cohort(C.cohortId);

    const { ctx, page: admin, adminId } = await adminLogin(browser);
    try {
      await openOrderInAdmin(admin, a.number, "AWAITING_VERIFICATION");
      // Un POST manipulado: la acción de servidor recibe el pedido A pero el pago de B.
      let tampered = 0;
      await admin.route(`**/admin/orders/${a.id}**`, async (route) => {
        const req = route.request();
        const body = req.postData();
        if (req.method() === "POST" && req.headers()["next-action"] && body?.includes(payA)) {
          tampered++;
          return route.continue({ postData: body.split(payA).join(payB) });
        }
        return route.continue();
      });
      await admin.getByTestId("payment").filter({ hasText: refA }).getByRole("button", { name: "Aprobar pago" }).click();
      await expect(admin.getByRole("status").or(admin.getByRole("alert")).filter({ hasText: "El pago no pertenece a este pedido." })).toBeVisible();
      expect(tampered).toBe(1);
      await admin.unroute(`**/admin/orders/${a.id}**`);

      // Nada cambió en B (ni en A): ni pago, ni cupo, ni correos, ni historial, ni Moodle.
      expect(snapB()).toEqual(beforeB);
      expect(order(a.id).status).toBe("AWAITING_VERIFICATION");
      expect(cohort(C.cohortId)).toEqual(cohortBefore);
      expect(customerOf(b.id).moodleUserId).toBeNull();
      expect((await moodleState(request)).users.some((u) => u.email.toLowerCase() === emailB.toLowerCase())).toBe(false);

      // Sin manipular, cada pedido se verifica desde su propia ficha: A aprobado, B rechazado.
      await admin.reload();
      await admin.getByTestId("payment").filter({ hasText: refA }).getByRole("button", { name: "Aprobar pago" }).click();
      await expect(admin.getByRole("status").filter({ hasText: "Pago aprobado" })).toBeVisible();
      await waitForOrderStatus(a.id, "ENROLLED");
      expect(one<{ verifiedById: string }>(`SELECT verifiedById FROM Payment WHERE id = ?`, payA).verifiedById).toBe(adminId);

      await openOrderInAdmin(admin, b.number, "AWAITING_VERIFICATION");
      const cardB = admin.getByTestId("payment").filter({ hasText: refB });
      await cardB.getByRole("button", { name: "Rechazar pago" }).click();
      await cardB.getByRole("form", { name: "Rechazar pago" }).getByLabel("Motivo del rechazo").fill("Monto no recibido.");
      await cardB.getByRole("button", { name: "Rechazar pago" }).click();
      await expect(admin.getByRole("status").filter({ hasText: "Pago rechazado" })).toBeVisible();
      expect(order(b.id).status).toBe("REJECTED");
      expect(reservationOf(b.id).status).toBe("RELEASED");
    } finally {
      await ctx.close();
    }
  } finally {
    await ctxB.close();
  }
});
