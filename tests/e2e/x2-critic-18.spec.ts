// Pieza x2 — ronda 18 (crítico). Reembolso PayPal de un diplomado de más de 1.000 USD desde el panel escribiendo
// el monto a mano. El panel muestra los montos en formato de EE. UU. («$1,278.00») y en Venezuela se escribe
// «1.278» / «1.278,00». El diálogo (RefundDialog.toCents) y la acción del servidor (orders/actions.ts parseCents)
// leen «1,278.00» → «1.27800» y «1.278» → 1.278, o sea 1,28 USD (el mismo defecto que la ronda 14 corrigió para el
// monto en Bs. del médico). Resultado real, comprobado: PayPal devuelve 1,28 USD en vez de 1.278 USD, el pedido
// sigue «Inscrito» con cupo y Moodle (las opciones por defecto de un reembolso parcial no retiran) y el correo de
// reembolso dice 1,28 USD. «1.278,00» sí se lee bien.
// CORREGIDO: RefundDialog, AdjustModal y orders/actions.ts (reembolso, equivalente USD al aprobar, ajuste de saldo)
// usan parseMoney del catálogo: «1,278.00» y «1.278,00» → 1.278 USD; «1.278» es ambiguo → campo inválido, sin
// reembolso de otro monto.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-18.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { PAYPAL, fixture, one, order, uniqueEmail, waitForOrderStatus, type Checkout, type DiplomaCohort } from "./support/purchase";

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const ADMIN_EMAIL = "admin@ceium.net";
const ADMIN_PASSWORD = (() => {
  try {
    return parseDotenv(fs.readFileSync(path.join(__dirname, "../../.env"))).ADMIN_PASSWORD || "ceium-admin-2026";
  } catch {
    return "ceium-admin-2026";
  }
})();

async function payInBrowser(page: Page, token: string) {
  await page.goto(`/pedido/${token}`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
}

async function adminPage(browser: Browser) {
  const ctx = await browser.newContext({ locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/admin/login?next=${encodeURIComponent("/admin/orders")}`);
  await page.getByLabel("Correo electrónico").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((u) => u.pathname === "/admin/orders");
  return { ctx, page };
}

const usdUS = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdVE = (cents: number) => (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

for (const variant of ["en-US «1,278.00» (como lo muestra el panel)", "es-VE «1.278,00»", "es-VE sin decimales «1.278»"] as const) {
  test(`reembolso total de un diplomado > 1.000 USD escribiendo el monto ${variant} → se reembolsa ese monto, no mil veces menos`, async ({ browser, page }) => {
    const c = fixture<DiplomaCohort>("diploma-cohort", { capacity: 3, sede: "barquisimeto" });
    const email = uniqueEmail("x2c18");
    const o = fixture<Checkout>("checkout", { productId: c.productId, cohortId: c.cohortId, planKind: "FULL", email, firstName: "Rosa", lastName: "Linares" });
    expect(o.dueNowCents).toBeGreaterThanOrEqual(100_000);
    await payInBrowser(page, o.token);
    await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
    const pay = one<{ id: string; amountUsdCents: number }>(`SELECT id, amountUsdCents FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.orderId);
    const typed = variant.startsWith("en-US") ? usdUS(pay.amountUsdCents) : variant.includes("sin decimales") ? usdVE(pay.amountUsdCents).replace(/,00$/, "") : usdVE(pay.amountUsdCents);
    expect(pay.amountUsdCents % 100 === 0 || !variant.includes("sin decimales")).toBe(true);

    const { ctx, page: admin } = await adminPage(browser);
    try {
      await admin.goto(`/admin/orders/${o.orderId}`);
      const card = admin.getByTestId("payment").filter({ hasText: "PayPal" });
      await card.getByTestId("refund").locator("summary").click();
      const form = card.getByRole("form", { name: "Reembolsar pago" });
      await form.getByLabel("Motivo").fill("El médico se retira del diplomado.");
      await form.locator('input[name="amount"]').fill(typed);
      // Lo que el admin escribió es el total: el botón debe decir el total (o, si es ambiguo, el campo marcarse
      // inválido y no dejar reembolsar otro monto).
      const submit = form.getByRole("button", { name: /^Reembolsar/ });
      const label = (await submit.textContent())?.trim() ?? "";
      test.info().annotations.push({ type: "typed", description: `${typed} → botón «${label}»` });
      const ambiguousRejected = (await form.locator('input[name="amount"]').getAttribute("aria-invalid")) === "true" && !/\$\d/.test(label);
      if (!ambiguousRejected) expect(label, `el admin escribió ${typed}`).toContain(usdUS(pay.amountUsdCents));
    } finally {
      await ctx.close();
    }
    expect(order(o.orderId).status).toBe("ENROLLED");
  });
}

test("reembolso enviado con «1,278.00» → PayPal devuelve 1.278 USD, el pedido queda reembolsado y el correo dice 1,278.00", async ({ browser, page, request }) => {
  const c = fixture<DiplomaCohort>("diploma-cohort", { capacity: 3, sede: "barquisimeto" });
  const email = uniqueEmail("x2c18real");
  const o = fixture<Checkout>("checkout", { productId: c.productId, cohortId: c.cohortId, planKind: "FULL", email, firstName: "Rosa", lastName: "Linares" });
  await payInBrowser(page, o.token);
  await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
  const pay = one<{ id: string; amountUsdCents: number; paypalCaptureId: string }>(`SELECT id, amountUsdCents, paypalCaptureId FROM Payment WHERE orderId = ? AND status = 'COMPLETED'`, o.orderId);

  const { ctx, page: admin } = await adminPage(browser);
  try {
    await admin.goto(`/admin/orders/${o.orderId}`);
    const card = admin.getByTestId("payment").filter({ hasText: "PayPal" });
    await card.getByTestId("refund").locator("summary").click();
    const form = card.getByRole("form", { name: "Reembolsar pago" });
    await form.getByLabel("Motivo").fill("El médico se retira del diplomado.");
    await form.locator('input[name="amount"]').fill(usdUS(pay.amountUsdCents));
    await form.getByRole("button", { name: /^Reembolsar/ }).click();
    await expect(admin.getByRole("status").filter({ hasText: /Reembolso completado/ })).toBeVisible();
  } finally {
    await ctx.close();
  }
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown };
  const all = (Array.isArray(st.refunds) ? st.refunds : Object.values((st.refunds ?? {}) as Record<string, unknown>)) as { amount: { value: string } }[];
  const mine = all.filter((r) => JSON.stringify(r).includes(pay.paypalCaptureId));
  const refundMail = one<{ text: string }>(`SELECT text FROM EmailOutbox WHERE orderId = ? AND template = 'refund_issued'`, o.orderId);
  test.info().annotations.push({ type: "outcome", description: JSON.stringify({ paypal: mine.map((r) => r.amount.value), order: order(o.orderId).status, mail: refundMail?.text.match(/\$?[\d.,]+\s*USD|\$[\d.,]+/g)?.slice(0, 3) }) });
  expect(mine.map((r) => Math.round(Number(r.amount.value) * 100))).toEqual([pay.amountUsdCents]);
  expect(order(o.orderId).status).toBe("REFUNDED");
  expect(refundMail?.text ?? "").toContain(usdUS(pay.amountUsdCents));
});
