// x2 critic 13 — Moodle responde una página de error (HTTP 200, HTML en vez de JSON) al aprobar un pago móvil.
// Es lo que devuelve Moodle (o el proxy delante) ante un fallo pasajero de su base de datos: «Error de lectura de la
// base de datos». Antes se tomaba como error PERMANENTE: la matrícula quedaba FAILED al primer intento, el job nunca
// la reintentaba y el panel decía «Moodle rechazó la matrícula… reintentar no lo resuelve» (o, si la respuesta perdida
// era la del alta, «no se encontró ninguna cuenta con ese correo» aunque Moodle SÍ la había creado). El médico pagó,
// recibió «Pago aprobado» y se quedaba sin aula (y, en el segundo caso, sin contraseña) hasta que alguien lo notara.
// Ahora: se reintenta con backoff como cualquier fallo transitorio y el job matricula una sola vez, con el correo de
// acceso (y la contraseña temporal) una sola vez.
// Todo por HTTP contra el carril: el médico registra el pago en /pedido/<token> con comprobante, el admin aprueba en
// el panel, el job corre por /api/cron; se verifica en la BD, en el estado del mock de Moodle y en la bandeja de correo.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-13.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { MOODLE, cohort, customerOf, emails, enrolCallsFor, enrollments, events, fixture, moodleCalls, moodleState, order, reservationOf, runCron, uniqueEmail } from "./support/purchase";
import { todayCaracas } from "./support/dates";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(150_000);

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

interface CourseCohort { productId: string; moodleCourseId: number; cohortId: string }
interface Placed { orderId: string; token: string; number: number; dueNowCents: number }
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
const ves = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const newRef = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}${Date.now().toString().slice(-7)}${n++ % 10}`;
})();
const templates = (orderId: string) => emails(orderId).map((e) => e.template);
const countOf = (xs: string[], x: string) => xs.filter((y) => y === x).length;

/** Pedido de pago móvil como lo crea la tienda + el médico registra el pago con comprobante en /pedido/<token>. */
async function placeAndReport(page: Page, tag: string) {
  const C = fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity: 3, name: `Cohorte x2c13 ${Date.now().toString(36)}` });
  const email = uniqueEmail(tag);
  const o = fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAGO_MOVIL" });
  const ref = newRef("0134");
  await page.goto(`/pedido/${o.token}`);
  await page.getByLabel("Número de referencia").fill(ref);
  await page.getByLabel(/Monto pagado/).fill(ves(Math.round(o.dueNowCents * RATE)));
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  expect(new URL(page.url()).searchParams.get("pago")).toBe("registrado");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  return { C, o, ref, email };
}

async function approveInPanel(browser: Browser, orderId: string, ref: string) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(`/admin/login?next=${encodeURIComponent(`/admin/orders/${orderId}`)}`);
    await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
    await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL((u) => u.pathname === `/admin/orders/${orderId}`);
    await page.getByTestId("payment").filter({ hasText: ref }).getByRole("button", { name: "Aprobar pago" }).click();
    const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta/i }).last();
    await toast.waitFor({ timeout: 60_000 });
    return (await toast.textContent()) ?? "";
  } finally {
    await ctx.close();
  }
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
      /* valor previo no válido para updateSetting */
    }
  }
});

test("Moodle responde HTML (HTTP 200) al matricular → no es definitivo: el job reintenta y matricula una sola vez", async ({ page, browser, request }) => {
  const { C, o, ref } = await placeAndReport(page, "c13-enrol");
  // Moodle devuelve su página de error de base de datos (200, HTML) en vez de JSON a la matrícula, en los 3 intentos
  // inmediatos (1 + enrollInlineRetries): queda para el job.
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "garbage", count: 3 } });
  expect(await approveInPanel(browser, o.orderId, ref)).toMatch(/Pago aprobado/);

  expect(order(o.orderId).status).toBe("PAID");
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  // Programado para reintento, no FAILED: nada de «reintentar no lo resuelve».
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "PENDING" }]);
  expect(events(o.orderId).filter((e) => e.type === "ATTENTION").map((e) => e.note)).toEqual([]);

  await expect
    .poll(async () => (await runCron(request, "enrollments"), order(o.orderId).status), { timeout: 45_000, intervals: [5_500] })
    .toBe("ENROLLED");
  const uid = customerOf(o.orderId).moodleUserId!;
  expect(uid).toBeGreaterThan(0);
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "ENROLLED" }]);
  const t = templates(o.orderId);
  for (const x of ["payment_under_verification", "payment_approved", "cohort_details"]) expect(countOf(t, x), x).toBe(1);
  // Cuenta nueva y matrícula pendiente: sale la contraseña temporal UNA vez (acceso «en activación») y, al matricular,
  // el aviso de acceso activo (sin contraseña). Nunca dos contraseñas.
  const access = emails(o.orderId).filter((m) => m.template === "platform_access");
  expect(access.filter((m) => m.secretRef)).toHaveLength(1);
  expect(access.filter((m) => !m.secretRef)).toHaveLength(1);
  expect(emails(o.orderId).every((m) => m.status === "SENT")).toBe(true);
});

test("Moodle crea la cuenta pero responde HTML (HTTP 200) → el job encuentra esa cuenta, envía la contraseña una vez y matricula", async ({ page, browser, request }) => {
  const { C, o, ref, email } = await placeAndReport(page, "c13-create");
  // core_user_create_users SE EJECUTA en Moodle y la respuesta llega como página de error (respuesta perdida).
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "core_user_create_users", type: "garbage", after: true, count: 1 } });
  expect(await approveInPanel(browser, o.orderId, ref)).toMatch(/Pago aprobado/);

  // La cuenta existe en Moodle (una sola) aunque la app no lo supo: la matrícula queda para reintento, sin avisos
  // falsos («no se encontró ninguna cuenta con ese correo»).
  const users = (await moodleState(request)).users.filter((u) => u.email.toLowerCase() === email.toLowerCase());
  expect(users).toHaveLength(1);
  expect(order(o.orderId).status).toBe("PAID");
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "PENDING" }]);
  expect(events(o.orderId).filter((e) => e.type === "ATTENTION").map((e) => e.note)).toEqual([]);

  await expect
    .poll(async () => (await runCron(request, "enrollments"), order(o.orderId).status), { timeout: 45_000, intervals: [5_500] })
    .toBe("ENROLLED");
  const cust = customerOf(o.orderId);
  expect(cust.moodleUserId).toBe(users[0].id);
  const st = await moodleState(request);
  expect(st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase())).toHaveLength(1);
  expect(st.enrolments.filter((e) => e.userid === cust.moodleUserId).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  expect(enrolCallsFor(await moodleCalls(request), cust.moodleUserId!)).toEqual([C.moodleCourseId]);
  // Contraseña temporal: la cuenta la creamos nosotros y el médico nunca la recibió → se fija una nueva y se envía
  // UNA vez (el correo de acceso lleva la referencia al secreto, no la contraseña).
  const access = emails(o.orderId).filter((m) => m.template === "platform_access");
  expect(access.filter((m) => m.secretRef)).toHaveLength(1);
  expect(access.every((m) => m.text.includes(cust.moodleUsername!))).toBe(true);
  expect(countOf(templates(o.orderId), "cohort_details")).toBe(1);
  expect(events(o.orderId).map((e) => e.type)).toEqual(expect.arrayContaining(["MOODLE_USER_CREATE_UNCONFIRMED", "MOODLE_USER", "ENROLLMENT"]));
});
