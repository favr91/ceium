// Pieza x3 — cupo sin sobreventa, por HTTP contra la tienda real y los mocks del carril:
//   1. 40 compradores a la vez (PayPal y Pago Móvil mezclados; 36 como navegador sin JS enviando el formulario
//      del checkout y 4 navegadores reales con JavaScript) por una cohorte con 3 cupos → exactamente 3 pedidos
//      con su reserva; los otros 37 ven un aviso claro «Sin cupo» y no dejan pedido, cliente ni reserva.
//   2. Con la cohorte llena, la ficha del producto la muestra «Agotado» (radio deshabilitado), el carrito no la
//      acepta y un comprador tardío recibe «Sin cupo».
//   3. El barrido (cron expire) NO libera reservas vivas; libera la de PayPal pasados 30 min y la manual pasadas
//      72 h, una por una; la cohorte vuelve a ser comprable en la ficha y el cupo liberado se vende y se paga
//      (PayPal → webhook → Moodle), sin superar nunca el cupo.
// Carril: E2E_LANE=e2e-cert E2E_PORT=3105 npx playwright test tests/e2e/x3-oversell.spec.ts --project=desktop
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { PAYPAL, cohort, fixture, order, paypalConfig, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus, type DiplomaCohort } from "./support/purchase";
import { addToCart, checkoutFormFields, submitCheckout, type CheckoutMethod, type CheckoutOutcome } from "./support/storefront";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(420_000);

const DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";
const CAPACITY = 3;
const BUYERS = 40;
const BROWSER_BUYERS = 4;
const SOLD_OUT = /sin cupo/i;

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

let C: DiplomaCohort;
let settingsBefore: unknown = null;
const cartQuery = () => ({ product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: C.cohortId, plan: "FULL" });

interface Result {
  email: string;
  method: CheckoutMethod;
  via: "http" | "browser";
  outcome: CheckoutOutcome;
}
const winners: Result[] = [];
/** Comprador que armó su carrito y abrió el checkout cuando aún había cupo, y confirma cuando ya no queda. */
let lateBuyer: { ctx: APIRequestContext; email: string; fields: Record<string, string> } | null = null;

const ordersOf = (email: string) =>
  q<{ id: string; token: string; status: string; paymentMethod: string }>(`SELECT o.id, o.token, o.status, o.paymentMethod FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email);
const reservationsOfCohort = () => q<{ orderId: string; status: string }>(`SELECT orderId, status FROM SeatReservation WHERE cohortId = ? ORDER BY createdAt`, C.cohortId);
const customersNamed = (emails: string[]) => q<{ email: string }>(`SELECT email FROM Customer WHERE email IN (${emails.map(() => "?").join(",")})`, ...emails);

/** La cohorte en la ficha del producto (semipresencial, Barquisimeto). */
async function productCohort(page: Page) {
  await page.goto(`/products/${DIPLOMA}`);
  const form = page.getByTestId("buy-form");
  await form.locator("label.pp-radio", { hasText: "Semipresencial" }).locator("input").check();
  await form.locator("label.pp-radio", { hasText: "Barquisimeto" }).locator("input").check();
  return form.locator(`label.pp-cohort[data-cohort="${C.cohortName}"]`);
}

async function fillDoctor(page: Page, email: string, first: string, last: string, method: CheckoutMethod) {
  await page.getByLabel("Correo electrónico").fill(email);
  await page.getByLabel("Teléfono (WhatsApp)").fill("04141234567");
  await page.getByLabel("Nombre", { exact: true }).fill(first);
  await page.getByLabel("Apellidos").fill(last);
  await page.getByLabel("Cédula de identidad").fill("V-14567890");
  await page.getByLabel("Ciudad (opcional)").fill("Barquisimeto");
  await page.getByLabel("Especialidad").selectOption("Medicina general");
  if (method === "PAGO_MOVIL") await page.getByText("Pago Móvil", { exact: true }).click();
  await expect(page.getByRole("radio", { name: method === "PAYPAL" ? "PayPal" : "Pago Móvil" })).toBeChecked();
}

/** Comprador con navegador real (JS): carrito → checkout lleno, listo para pulsar «pagar». */
async function browserBuyer(browser: Browser, i: number, method: CheckoutMethod) {
  const ctx = await browser.newContext({ baseURL: e2eEnv.APP_URL, locale: "es-VE", viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const res = await page.goto(`/cart/add?${new URLSearchParams(cartQuery())}`);
  expect(res?.url()).not.toContain("error=");
  await page.goto("/checkout");
  const email = uniqueEmail(`x3b${i}`);
  await fillDoctor(page, email, "Médico", `Navegador ${i}`, method);
  const submit = async (): Promise<CheckoutOutcome> => {
    await page.locator("button.co-pay").click();
    const alert = page.locator(".co-banner[role=alert]");
    // La espera que pierde la carrera se rechaza al cerrar el contexto: se absorbe (nunca queda sin manejar).
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      page
        .waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`) || (u.pathname === "/checkout" && u.searchParams.get("pedido") === "creado"), { timeout: 150_000 })
        .then(() => "url" as const, () => new Promise<never>(() => {})),
      alert.waitFor({ state: "visible", timeout: 150_000 }).then(() => "alert" as const, () => new Promise<never>(() => {})),
      new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), 160_000))),
    ]).finally(() => clearTimeout(timer));
    expect(done, "el checkout respondió").not.toBe("timeout");
    if (done === "url") {
      const u = new URL(page.url());
      return { ok: true, status: 303, location: page.url(), paypalOrderId: u.searchParams.get("token") };
    }
    return { ok: false, status: 200, error: (await alert.innerText()).trim() };
  };
  return { ctx, page, email, method, submit };
}

test.beforeAll(({}) => {
  settingsBefore = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: 187.25, source: "BCV" } });
  C = fixture<DiplomaCohort>("diploma-cohort", { capacity: CAPACITY, sede: "barquisimeto", name: `Cohorte x3 ${Date.now().toString(36)}` });
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 0 });
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
      /* datos previos no válidos para updateSetting */
    }
  }
});

test("40 compradores a la vez (PayPal + Pago Móvil) por 3 cupos: exactamente 3 pedidos; el resto, «Sin cupo» y nada creado", async ({ browser, playwright }) => {
  // Preparación (secuencial): cada comprador con su carrito y su checkout abierto, como 40 pestañas listas.
  const httpBuyers: { ctx: APIRequestContext; email: string; method: CheckoutMethod; fields: Record<string, string>; i: number }[] = [];
  for (let i = 0; i < BUYERS - BROWSER_BUYERS; i++) {
    const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
    const added = await addToCart(ctx, cartQuery());
    expect(added.error, "la cohorte se puede agregar al carrito").toBeNull();
    httpBuyers.push({ ctx, email: uniqueEmail(`x3h${i}`), method: i % 2 === 0 ? "PAYPAL" : "PAGO_MOVIL", fields: await checkoutFormFields(ctx), i });
  }
  const lateCtx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  expect((await addToCart(lateCtx, cartQuery())).error).toBeNull();
  lateBuyer = { ctx: lateCtx, email: uniqueEmail("x3late"), fields: await checkoutFormFields(lateCtx) };
  const browserBuyers = [];
  for (let i = 0; i < BROWSER_BUYERS; i++) browserBuyers.push(await browserBuyer(browser, i, i % 2 === 0 ? "PAYPAL" : "PAGO_MOVIL"));
  expect(cohort(C.cohortId), "preparar el checkout no reserva nada").toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 0 });

  // Los 40 confirman A LA VEZ.
  const results: Result[] = await Promise.all([
    ...httpBuyers.map(async (b) => ({
      email: b.email,
      method: b.method,
      via: "http" as const,
      outcome: await submitCheckout(b.ctx, b.fields, { email: b.email, firstName: "Médico", lastName: `Concurrente ${b.i}`, method: b.method }),
    })),
    ...browserBuyers.map(async (b) => ({ email: b.email, method: b.method, via: "browser" as const, outcome: await b.submit() })),
  ]);
  await Promise.all([...httpBuyers.map((b) => b.ctx.dispose()), ...browserBuyers.map((b) => b.ctx.close())]);

  const ok = results.filter((r) => r.outcome.ok);
  const failed = results.filter((r) => !r.outcome.ok);
  console.log(`[x3] ganadores: ${ok.map((r) => `${r.via}/${r.method}`).join(", ")}`);
  const summary = results.map((r) => `${r.via}/${r.method}: ${r.outcome.ok ? `OK → ${r.outcome.location}` : `✗ ${r.outcome.error}`}`).join("\n");
  expect(ok, `exactamente ${CAPACITY} compradores obtienen cupo\n${summary}`).toHaveLength(CAPACITY);
  expect(failed).toHaveLength(BUYERS - CAPACITY);
  // Cada rechazo es el aviso claro de cupo agotado (ningún error genérico, 500 ni validación).
  for (const f of failed) {
    expect(f.outcome.status, summary).toBe(200);
    expect((f.outcome as { error: string }).error, summary).toMatch(SOLD_OUT);
    expect((f.outcome as { error: string }).error).toMatch(/otra cohorte/i);
  }
  // Los ganadores siguen el camino de su método: PayPal → aprobación en PayPal; manual → reserva con datos de pago.
  for (const w of ok) {
    if (!w.outcome.ok) continue;
    if (w.method === "PAYPAL") {
      expect(w.outcome.location).toMatch(new RegExp(`^${PAYPAL}/checkoutnow\\?token=`));
      expect(w.outcome.paypalOrderId).toBeTruthy();
    } else expect(w.outcome.location).toMatch(/\/checkout\?pedido=creado$/);
  }
  // Mezcla real: hubo intentos de ambos métodos y de ambos tipos de cliente.
  expect(new Set(results.map((r) => r.method))).toEqual(new Set(["PAYPAL", "PAGO_MOVIL"]));
  expect(new Set(results.map((r) => r.via))).toEqual(new Set(["http", "browser"]));

  // BD: 3 reservas vivas y 3 pedidos (uno por ganador, con su método); los perdedores no dejan rastro.
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: CAPACITY, seatsConfirmed: 0 });
  const res = reservationsOfCohort();
  expect(res).toHaveLength(CAPACITY);
  expect(res.every((r) => r.status === "HELD")).toBe(true);
  for (const w of ok) {
    const os = ordersOf(w.email);
    expect(os, w.email).toHaveLength(1);
    expect(os[0]).toMatchObject({ status: "PENDING_PAYMENT", paymentMethod: w.method });
    expect(res.map((r) => r.orderId)).toContain(os[0].id);
  }
  const loserEmails = failed.map((f) => f.email);
  expect(q(`SELECT o.id FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email IN (${loserEmails.map(() => "?").join(",")})`, ...loserEmails)).toHaveLength(0);
  expect(customersNamed(loserEmails), "un checkout sin cupo no crea el cliente").toHaveLength(0);
  winners.push(...ok);
});

test("cohorte llena: la ficha la muestra «Agotado» y no se puede elegir; el carrito no la acepta; quien tenía el checkout abierto recibe «Sin cupo»", async ({ page, playwright }) => {
  expect(winners).toHaveLength(CAPACITY);
  const card = await productCohort(page);
  await expect(card).toHaveAttribute("data-phase", "SOLD_OUT");
  await expect(card).toContainText("Agotado");
  await expect(card.locator("input[type=radio]")).toBeDisabled();

  // Por la ruta del carrito (un enlace directo a la cohorte), la tienda la rechaza.
  const direct = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  try {
    expect((await addToCart(direct, cartQuery())).error).toMatch(/cupo/i);
  } finally {
    await direct.dispose();
  }

  // El carrito de este comprador se armó con cupo; al confirmar ahora (PayPal), el checkout lo re-valida.
  const late = lateBuyer!;
  const out = await submitCheckout(late.ctx, late.fields, { email: late.email, firstName: "Médico", lastName: "Tardío", method: "PAYPAL" });
  expect(out.ok).toBe(false);
  expect((out as { error: string }).error).toMatch(SOLD_OUT);
  expect(ordersOf(late.email)).toHaveLength(0);
  // Su /checkout muestra el programa bloqueado con el mismo aviso (no un formulario que parece funcionar).
  const html = await (await late.ctx.get("/checkout")).text();
  expect(html).toMatch(SOLD_OUT);
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: CAPACITY, seatsConfirmed: 0 });
});

test("el barrido libera SOLO reservas vencidas (PayPal a los 30 min, manual a las 72 h); el cupo liberado se vende y se paga sin sobreventa", async ({ page, request, playwright }) => {
  await lateBuyer?.ctx.dispose();
  const ws = winners.map((w) => ({ ...w, order: ordersOf(w.email)[0] }));
  const ttlMinutes = (m: CheckoutMethod) => (m === "PAYPAL" ? 30 : 72 * 60);

  // Nada vencido todavía: el barrido no toca las reservas vivas.
  await runCron(request, "expire");
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: CAPACITY, seatsConfirmed: 0 });

  for (const [n, w] of ws.entries()) {
    const ttl = ttlMinutes(w.method);
    // Faltando 5 min para su vencimiento: sigue reservada.
    fixture("age-order", { orderId: w.order.id, minutes: ttl - 5 });
    await runCron(request, "expire");
    expect(reservationOf(w.order.id).status, `${w.method}: aún vigente a ${ttl - 5} min`).toBe("HELD");
    expect(order(w.order.id).status).toBe("PENDING_PAYMENT");
    expect(cohort(C.cohortId).seatsHeld).toBe(CAPACITY - n);
    // Pasado el plazo: el barrido vence el pedido y libera SU cupo (solo el suyo).
    fixture("age-order", { orderId: w.order.id, minutes: 10 });
    await runCron(request, "expire");
    expect(reservationOf(w.order.id).status, `${w.method}: liberada pasado el plazo`).toBe("RELEASED");
    expect(order(w.order.id).status).toBe("EXPIRED");
    expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: CAPACITY - n - 1, seatsConfirmed: 0 });
    // En cuanto se libera el primero, la ficha vuelve a ofrecer la cohorte con el cupo exacto.
    if (n === 0) {
      const card = await productCohort(page);
      await expect(card).toHaveAttribute("data-phase", "OPEN");
      await expect(card).toContainText("¡Último cupo!");
      await expect(card.locator("input[type=radio]")).toBeEnabled();
    }
  }
  // Correr el barrido otra vez no libera de más ni deja contadores negativos.
  await runCron(request, "expire");
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 0 });

  // Otros 6 compradores a la vez (4 PayPal, 2 Pago Móvil) por los 3 cupos liberados: 3 lo consiguen (al menos uno de PayPal).
  const again = [];
  for (let i = 0; i < 6; i++) {
    const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
    expect((await addToCart(ctx, cartQuery())).error).toBeNull();
    again.push({ ctx, email: uniqueEmail(`x3r${i}`), fields: await checkoutFormFields(ctx), method: (i % 3 === 2 ? "PAGO_MOVIL" : "PAYPAL") as CheckoutMethod });
  }
  const outs = await Promise.all(again.map((b) => submitCheckout(b.ctx, b.fields, { email: b.email, firstName: "Médico", lastName: "Segunda ronda", method: b.method })));
  await Promise.all(again.map((b) => b.ctx.dispose()));
  expect(outs.filter((o) => o.ok)).toHaveLength(CAPACITY);
  for (const o of outs.filter((x) => !x.ok)) expect((o as { error: string }).error).toMatch(SOLD_OUT);
  expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: CAPACITY, seatsConfirmed: 0 });

  // Un ganador de PayPal paga de verdad (PayPal mock → retorno → webhook → Moodle): su reserva pasa a ocupada.
  const paypalWin = again.map((b, i) => ({ b, o: outs[i] })).find((x) => x.o.ok && x.b.method === "PAYPAL");
  expect(paypalWin, "con 4 de 6 por PayPal, al menos un ganador paga con PayPal").toBeTruthy();
  if (paypalWin && paypalWin.o.ok) {
    const a = await (await request.post(`${PAYPAL}/__mock/approve/${paypalWin.o.paypalOrderId}?json=1`)).json();
    const ret = await request.get(a.redirect, { maxRedirects: 0 });
    expect(ret.status()).toBe(303);
    expect(new URL(ret.headers()["location"], e2eEnv.APP_URL).searchParams.get("paypal")).toBe("completado");
    const o = ordersOf(paypalWin.b.email)[0];
    await waitForOrderStatus(o.id, "ENROLLED", 60_000);
    expect(reservationOf(o.id).status).toBe("CONFIRMED");
    expect(cohort(C.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: CAPACITY - 1, seatsConfirmed: 1 });
  }
  // Pase lo que pase, nunca más reservas activas que el cupo.
  const live = reservationsOfCohort().filter((r) => r.status === "HELD" || r.status === "CONFIRMED");
  expect(live).toHaveLength(CAPACITY);
  const c = cohort(C.cohortId);
  expect(c.seatsHeld + c.seatsConfirmed).toBe(CAPACITY);
});
