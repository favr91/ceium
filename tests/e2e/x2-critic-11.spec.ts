// x2 critic 11 — sondas nuevas contra pago móvil → verificación del admin → Moodle → cupo → correos, por HTTP contra
// el carril (app + mocks), comprobando el resultado REAL (BD, estado del mock de Moodle, bandeja de correos):
//   1. El médico YA tiene cuenta en Moodle (alta manual del flujo anterior: username = cédula) con el mismo correo:
//      al aprobar se vincula esa cuenta (no se crea otra), se matricula una vez y el correo de acceso da SU usuario,
//      sin contraseña temporal ni tocar la que ya tiene.
//   2. Igual, pero la cuenta guarda el correo con mayúsculas, como lo escribió el médico en el Google Form desde el
//      teléfono («Dra.lopez@gmail.com» por el autocorrector, o «Dra.Lopez@Gmail.com»), y la tienda lo guarda en
//      minúsculas: Moodle busca por email EXACTO pero rechaza crear otra cuenta con el mismo email sin distinguir
//      mayúsculas («Email address already exists») → antes el médico pagaba y quedaba sin matrícula (error
//      permanente). Debe quedar matriculado en SU cuenta — con CUALQUIER combinación de mayúsculas («dra.lOpez@eXample»):
//      la búsqueda usa core_user_get_users (LIKE sin distinguir mayúsculas).
//   3. Si el token de Moodle NO tiene core_user_get_users (se recurre a las variantes habituales) y el correo tiene
//      mayúsculas raras: el pedido queda pagado sin matrícula con un ATTENTION que dice exactamente qué hacer, y el
//      admin lo resuelve desde la ficha del cliente con «Vincular cuenta de Moodle» → matriculado en SU cuenta.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-11.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import { MOODLE, cohort, customerOf, emails, enrolCallsFor, events, fixture, moodleCalls, moodleState, one, order, reservationOf, waitForOrderStatus } from "./support/purchase";
import { todayCaracas } from "./support/dates";

test.describe.configure({ mode: "default" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const COURSE = "curso-universitario-ecografia-de-abdomen";
const RATE = 187.25;
const ADMIN_EMAIL = "admin@ceium.net";
const ENV = (() => {
  try {
    return parseDotenv(fs.readFileSync(path.join(__dirname, "../../.env")));
  } catch {
    return {} as Record<string, string>;
  }
})();
const ADMIN_PASSWORD = ENV.ADMIN_PASSWORD || "ceium-admin-2026";
// En un carril el mock de Moodle usa el token de .env; en el entorno e2e aislado, el de playwright.config.
const MOODLE_TOKEN = process.env.E2E_LANE ? ENV.MOODLE_TOKEN || e2eEnv.MOODLE_TOKEN : e2eEnv.MOODLE_TOKEN;
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
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2c11 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, extra: Record<string, unknown> = {}) =>
  fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAGO_MOVIL", ...extra });
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
async function adminDecide(browser: Browser, orderId: string, reference: string, decision: "approve" | "reject", reason = "") {
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${orderId}`);
  try {
    const card = admin.getByTestId("payment").filter({ hasText: reference });
    if (decision === "approve") {
      await card.getByRole("button", { name: "Aprobar pago" }).click();
    } else {
      await card.getByRole("button", { name: "Rechazar pago" }).click();
      await card.getByRole("form", { name: "Rechazar pago" }).getByLabel("Motivo del rechazo").fill(reason);
      await card.getByRole("button", { name: "Rechazar pago" }).click();
    }
    const toast = admin.getByRole("status").or(admin.getByRole("alert")).filter({ hasText: /pago/i }).last();
    await expect(toast).toBeVisible();
    return (await toast.textContent()) ?? "";
  } finally {
    await ctx.close();
  }
}
/** Alta manual en Moodle (como la hace hoy el staff de CEIUM): por la API REST real del mock. */
async function moodleCreateUser(request: APIRequestContext, u: { username: string; email: string; firstname: string; lastname: string; password: string }) {
  const r = await request.post(`${MOODLE}/webservice/rest/server.php`, {
    form: {
      wstoken: MOODLE_TOKEN,
      wsfunction: "core_user_create_users",
      moodlewsrestformat: "json",
      "users[0][username]": u.username,
      "users[0][email]": u.email,
      "users[0][firstname]": u.firstname,
      "users[0][lastname]": u.lastname,
      "users[0][password]": u.password,
      "users[0][auth]": "manual",
    },
  });
  const body = await r.json();
  expect(Array.isArray(body), JSON.stringify(body)).toBe(true);
  return (body as { id: number; username: string }[])[0];
}
const liveHeld = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, cohortId).n;
const liveConfirmed = (cohortId: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM SeatReservation WHERE cohortId = ? AND status = 'CONFIRMED'`, cohortId).n;
function expectCohortConsistent(cohortId: string) {
  const c = cohort(cohortId);
  expect({ held: c.seatsHeld, confirmed: c.seatsConfirmed }).toEqual({ held: liveHeld(cohortId), confirmed: liveConfirmed(cohortId) });
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
    /* valor previo no válido */
  }
});

// ───────────── 1 y 2. el médico ya tiene cuenta en Moodle (alta manual) ─────────────

for (const variant of ["mismo correo", "inicial mayúscula (autocorrector)", "Nombre.Apellido@Dominio", "mayúsculas arbitrarias (dra.lOpez@eXample)"] as const) {
  test(`cuenta de Moodle creada a mano antes (${variant}): aprobar vincula ESA cuenta, matricula una vez y el correo da su usuario`, async ({ browser, page, request }) => {
    const C = newCohort(3);
    const tag = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    const lower = `dra.lopez${tag}@example.com`;
    const moodleEmail =
      variant === "mismo correo"
        ? lower
        : variant === "Nombre.Apellido@Dominio"
          ? `Dra.Lopez${tag}@Example.com`
          : variant.startsWith("mayúsculas arbitrarias")
            ? `dra.lOpez${tag}@eXample.com`
            : `Dra.lopez${tag}@example.com`;
    const cedulaUser = `v${String(Date.now()).slice(-8)}`;
    const existing = await moodleCreateUser(request, { username: cedulaUser, email: moodleEmail, firstname: "Ana", lastname: "López", password: "Ceium-2025!" });
    const pwdBefore = (await moodleState(request)).users.find((u) => u.id === existing.id)!.password;

    // El médico compra escribiendo su correo como en el teléfono (con mayúscula inicial en la variante 2).
    const o = checkout(C, variant === "mismo correo" || variant.startsWith("mayúsculas arbitrarias") ? lower : moodleEmail, { firstName: "Ana", lastName: "López" });
    const ref = newRef("0105");
    expect((await reportManual(page, o.token, ref, ves(Math.round(o.dueNowCents * RATE)))).get("pago")).toBe("registrado");
    expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
    expect(reservationOf(o.orderId).status).toBe("HELD");

    const toast = await adminDecide(browser, o.orderId, ref, "approve");
    expect(toast).toMatch(/Pago aprobado/);
    await waitForOrderStatus(o.orderId, ["ENROLLED", "PAID"], 30_000);

    const st = await moodleState(request);
    const sameEmail = st.users.filter((u) => u.email.toLowerCase() === lower);
    const cust = customerOf(o.orderId);
    const attention = events(o.orderId).filter((e) => e.type === "ATTENTION" || e.type === "ENROLLMENT_FAILED").map((e) => e.note);
    expect({ status: order(o.orderId).status, moodleUserId: cust.moodleUserId, accounts: sameEmail.map((u) => u.id) }, JSON.stringify(attention)).toEqual({
      status: "ENROLLED",
      moodleUserId: existing.id,
      accounts: [existing.id],
    });
    expect(st.enrolments.filter((e) => e.userid === existing.id).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
    expect(enrolCallsFor(await moodleCalls(request), existing.id)).toEqual([C.moodleCourseId]);
    // Su contraseña de siempre no se toca.
    expect(st.users.find((u) => u.id === existing.id)!.password).toBe(pwdBefore);
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    expectCohortConsistent(C.cohortId);

    // Correo de acceso: SU usuario (la cédula), sin contraseña temporal.
    const access = emails(o.orderId).filter((m) => m.template === "platform_access");
    expect(access).toHaveLength(1);
    expect(access[0].text).toContain(cedulaUser);
    expect(access[0].secretRef).toBeNull();
    expect(access[0].text).not.toMatch(/contraseña temporal/i);
    expect(templates(o.orderId)).toEqual(expect.arrayContaining(["payment_under_verification", "payment_approved", "cohort_details"]));
  });
}

// ───────────── 3. token sin core_user_get_users + mayúsculas raras → ATTENTION exacto → «Vincular cuenta de Moodle» ─────────────

test("sin core_user_get_users y correo con mayúsculas raras: ATTENTION con el arreglo exacto y el admin vincula la cuenta desde la ficha del cliente", async ({ browser, page, request }) => {
  const C = newCohort(3);
  const tag = Date.now().toString(36) + Math.floor(Math.random() * 1e4);
  const lower = `dra.perez${tag}@example.com`;
  const cedulaUser = `v${String(Date.now()).slice(-8)}`;
  const existing = await moodleCreateUser(request, { username: cedulaUser, email: `dra.pErez${tag}@example.com`, firstname: "Ana", lastname: "Pérez", password: "Ceium-2025!" });

  const o = checkout(C, lower, { firstName: "Ana", lastName: "Pérez" });
  const ref = newRef("0106");
  expect((await reportManual(page, o.token, ref, ves(Math.round(o.dueNowCents * RATE)))).get("pago")).toBe("registrado");

  // El servicio web de Moodle no incluye core_user_get_users (Moodle responde webservice_access_exception).
  const denied = await request.post(`${MOODLE}/__mock/fail-next`, {
    data: { wsfunction: "core_user_get_users", count: 2, exception: "webservice_access_exception", errorcode: "accessexception", message: "Excepción al control de acceso" },
  });
  expect(denied.ok()).toBe(true);
  const toast = await adminDecide(browser, o.orderId, ref, "approve");
  expect(toast).toMatch(/Pago aprobado/);
  await expect.poll(() => events(o.orderId).filter((e) => e.type === "ATTENTION").length, { timeout: 30_000 }).toBe(1);
  expect(order(o.orderId).status).toBe("PAID");
  const attention = events(o.orderId).find((e) => e.type === "ATTENTION")!.note ?? "";
  expect(attention).toContain(`no dejó crear la cuenta de ${lower}`);
  expect(attention).toContain("«Vincular cuenta de Moodle» en la ficha del cliente");
  // No se creó una cuenta duplicada.
  expect((await moodleState(request)).users.filter((u) => u.email.toLowerCase() === lower).map((u) => u.id)).toEqual([existing.id]);

  // El ATTENTION se ve en el pedido.
  const cust = customerOf(o.orderId);
  const { ctx, page: admin } = await adminLogin(browser, `/admin/orders/${o.orderId}`);
  try {
    await expect(admin.getByText(/Vincular cuenta de Moodle/).first()).toBeVisible();
    // Ficha del cliente → «Vincular cuenta de Moodle» con el correo tal como lo escribió el staff.
    await admin.goto(`/admin/customers/${cust.id}`);
    const form = admin.getByRole("form", { name: "Vincular cuenta de Moodle" });
    await form.getByLabel(/Ya tiene cuenta en Moodle/).fill(`#${existing.id}`);
    await form.getByRole("button", { name: "Vincular cuenta de Moodle" }).click();
    await expect(admin.getByRole("status").or(admin.getByRole("alert")).filter({ hasText: /vinculada/ }).last()).toContainText(`Cuenta de Moodle #${existing.id} (${cedulaUser}) vinculada. Matrícula completada.`);
    await expect(admin.getByText(`Moodle #${existing.id}`)).toBeVisible();
  } finally {
    await ctx.close();
  }

  expect(order(o.orderId).status).toBe("ENROLLED");
  expect(customerOf(o.orderId).moodleUserId).toBe(existing.id);
  const st = await moodleState(request);
  expect(st.enrolments.filter((e) => e.userid === existing.id).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expectCohortConsistent(C.cohortId);
  expect(one<{ n: number }>(`SELECT COUNT(*) AS n FROM AuditLog WHERE entityId = ? AND action = 'customer.moodle_link'`, cust.id).n).toBe(1);
  const access = emails(o.orderId).filter((m) => m.template === "platform_access");
  expect(access).toHaveLength(1);
  expect(access[0].text).toContain(cedulaUser);
  expect(access[0].secretRef).toBeNull();
});
