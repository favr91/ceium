// x2 critic 14 — el monto del pago móvil escrito en formato de EE. UU. («33,564.60», como lo muestran algunas apps de
// banco) se registraba como Bs. 33,56 (1000 veces menos) y el pago quedaba «en verificación» con ese monto; sólo el
// admin comparándolo con el comprobante lo notaba. Ahora el último separador es el decimal y lo ambiguo
// («1.234,567», «33,564,60») se rechaza. Por HTTP contra el carril: /pedido/<token> con comprobante, con y sin
// JavaScript (el formulario llega igual al servidor), aprobación en el panel → Moodle, cupo y correos.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-14.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { cohort, customerOf, emails, enrollments, fixture, moodleState, order, payments, reservationOf, uniqueEmail } from "./support/purchase";
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
/** Bs. en formato de EE. UU.: «33,564.60». */
const vesUs = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function report(page: Page, token: string, ref: string, amount: string) {
  await page.goto(`/pedido/${token}`);
  await page.getByLabel("Número de referencia").fill(ref);
  await page.getByLabel(/Monto pagado/).fill(amount);
  await page.getByLabel("Banco de origen").fill("Banesco (0134)");
  await page.getByLabel("Fecha del pago").fill(todayCaracas());
  await page.getByLabel("Cédula del titular").fill("V-14567890");
  await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: proofPng() });
  await page.getByRole("button", { name: "Enviar datos del pago" }).click();
  await page.waitForURL(/[?&]pago=(registrado|error)/);
  return new URL(page.url()).searchParams;
}

function place(tag: string) {
  const C = fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity: 3, name: `Cohorte x2c14 ${Date.now().toString(36)}` });
  const email = uniqueEmail(tag);
  const o = fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAGO_MOVIL" });
  return { C, o, email };
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
    const card = page.getByTestId("payment").filter({ hasText: ref });
    // El admin ve el comprobante y el monto correcto (no Bs. 33,56).
    await expect(card).toContainText(ves(expectedVes));
    await card.getByRole("button", { name: "Aprobar pago" }).click();
    const toast = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /pago|verific|error|intenta/i }).last();
    await toast.waitFor({ timeout: 60_000 });
    return (await toast.textContent()) ?? "";
  } finally {
    await ctx.close();
  }
}
let expectedVes = 0;

test.beforeAll(() => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
});
test.afterAll(() => {
  if (settingsBefore == null) return;
  try {
    fixture("setting", { key: "payments.manualMethods", value: settingsBefore });
  } catch {
    /* valor previo no válido para updateSetting */
  }
});

test("monto en formato de EE. UU. («33,564.60») → se registra el monto exacto, el admin aprueba y el médico queda matriculado", async ({ page, browser, request }) => {
  const { C, o, email } = place("c14-us");
  expectedVes = Math.round(o.dueNowCents * RATE);
  const ref = newRef("0134");
  const typed = vesUs(expectedVes);
  expect(typed).toMatch(/^\d{1,3}(,\d{3})+\.\d{2}$/); // de verdad lleva coma de miles y punto decimal
  expect((await report(page, o.token, ref, typed)).get("pago")).toBe("registrado");

  const [p] = payments(o.orderId);
  expect(p.amountCents).toBe(expectedVes);
  expect(p.status).toBe("AWAITING_VERIFICATION");
  expect(order(o.orderId).status).toBe("AWAITING_VERIFICATION");
  expect(reservationOf(o.orderId).status).toBe("HELD");
  expect(templates(o.orderId)).toContain("payment_under_verification");

  expect(await approveInPanel(browser, o.orderId, ref)).toMatch(/Pago aprobado/);
  await expect.poll(() => order(o.orderId).status, { timeout: 30_000 }).toBe("ENROLLED");
  expect(order(o.orderId).balanceCents).toBeLessThanOrEqual(0);
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  expect(enrollments(o.orderId)).toEqual([{ moodleCourseId: C.moodleCourseId, status: "ENROLLED" }]);
  const uid = customerOf(o.orderId).moodleUserId!;
  expect((await moodleState(request)).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid)).toEqual([C.moodleCourseId]);
  expect(templates(o.orderId)).toEqual(expect.arrayContaining(["payment_under_verification", "payment_approved", "cohort_details"]));
  expect(email).toContain("@");
});

for (const js of [true, false]) {
  test(`monto ambiguo («1.234,567», «${"33,564,60"}») ${js ? "con" : "sin"} JavaScript → rechazado, sin pago ni correo; el pedido sigue pendiente`, async ({ browser }) => {
    const ctx = await browser.newContext({ locale: "es-VE", javaScriptEnabled: js });
    try {
      const page = await ctx.newPage();
      const { C, o } = place(`c14-bad-${js ? "js" : "nojs"}`);
      for (const bad of ["1.234,567", "33,564,60"]) {
        const sp = await report(page, o.token, newRef("0102"), bad);
        expect(sp.get("pago"), bad).toBe("error");
        expect(sp.get("motivo") ?? "", bad).toMatch(/monto/i);
      }
      expect(payments(o.orderId)).toEqual([]);
      expect(order(o.orderId).status).toBe("PENDING_PAYMENT");
      expect(reservationOf(o.orderId).status).toBe("HELD");
      expect(cohort(C.cohortId).seatsHeld).toBe(1);
      expect(templates(o.orderId)).not.toContain("payment_under_verification");
    } finally {
      await ctx.close();
    }
  });
}
