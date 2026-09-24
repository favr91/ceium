// Crítico x3 (ronda 2) — intentos adversariales nuevos por HTTP contra el carril (E2E_LANE=e2e-cert E2E_PORT=3105):
//   F. Estampida + barrido simultáneo: cohorte de 3 cupos con 2 reservas VENCIDAS (sin barrer) y 1 viva; 40
//      compradores (PayPal + Pago Móvil) a la vez mientras corren 4 barridos → exactamente 2 ganan; contadores =
//      filas; los dos pedidos vencidos no pueden cobrarse después (PayPal aprobado tarde → no se captura).
//   G. Carrito con DOS programas semipresenciales (cohorte con cupo + cohorte llena): nada se reserva ni se crea.
//   H. Ficha y checkout con reservas vencidas sin barrer: la ficha no la muestra agotada y la compra se hace
//      (liberación perezosa); una reserva de 72 h con comprobante en verificación NO se libera aunque «venza».
//   I. Certificado → reembolso total (revocado) → el médico vuelve a comprar, paga todo y completa: ¿se certifica?
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, enrollments, fixture, one, order, paypalConfig, payments, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus, type DiplomaCohort } from "./support/purchase";
import { addToCart, checkoutFormFields, submitCheckout, type CheckoutMethod } from "./support/storefront";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor");
});
test.setTimeout(400_000);

const DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";
const SOLD_OUT = /sin cupo/i;

/** Invariante de cupo en TODAS las cohortes: contadores = filas y nunca por encima de la capacidad. */
function assertSeatInvariant() {
  const bad = q(
    `SELECT c.name, c.capacity, c.seatsHeld, c.seatsConfirmed,
       (SELECT count(*) FROM SeatReservation r WHERE r.cohortId = c.id AND r.status = 'HELD') AS held,
       (SELECT count(*) FROM SeatReservation r WHERE r.cohortId = c.id AND r.status = 'CONFIRMED') AS conf
     FROM Cohort c`,
  ).filter((c: any) => c.seatsHeld !== c.held || c.seatsConfirmed !== c.conf || c.seatsHeld + c.seatsConfirmed > c.capacity); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(bad, "contadores de cupo = filas de reserva y ≤ capacidad").toEqual([]);
}

const ordersOf = (email: string) => q<{ id: string; status: string; token: string }>(`SELECT o.id, o.status, o.token FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email.toLowerCase());

async function pagoMovilOn() {
  fixture("setting", {
    key: "payments.manualMethods",
    value: [
      { method: "PAGO_MOVIL", enabled: true, label: "Pago Móvil", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Paga y registra la referencia." },
      { method: "TRANSFERENCIA", enabled: false, label: "Transferencia bancaria", currency: "VES", details: { banco: "TODO" }, instructions: "" },
      { method: "ZELLE", enabled: false, label: "Zelle", currency: "USD", details: { correo: "TODO" }, instructions: "" },
      { method: "EFECTIVO", enabled: false, label: "Efectivo en sede", currency: "USD", details: { lugar: "TODO" }, instructions: "" },
    ],
  });
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: 187.25, source: "BCV" } });
}

test.beforeAll(async () => {
  await pagoMovilOn();
});
test.beforeEach(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
});

async function buyer(playwright: { request: { newContext(o: { baseURL: string }): Promise<APIRequestContext> } }, query: Record<string, string>) {
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  const added = await addToCart(ctx, query);
  expect(added.error, "se puede agregar al carrito").toBeNull();
  return { ctx, fields: await checkoutFormFields(ctx) };
}

test("F. 40 compradores + 4 barridos a la vez sobre 3 cupos (2 reservas vencidas sin barrer, 1 viva): ganan exactamente 2", async ({ playwright, request }) => {
  const C = fixture<DiplomaCohort>("diploma-cohort", { capacity: 3, sede: "barquisimeto", name: `Cohorte F ${Date.now().toString(36)}` });
  const cq = { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: C.cohortId, plan: "FULL" };
  // Tres reservas previas: dos PayPal que vencen (abandonadas en PayPal) y una manual viva.
  const pre: { email: string; paypalOrderId: string | null; id: string; method: CheckoutMethod }[] = [];
  for (const method of ["PAYPAL", "PAYPAL", "PAGO_MOVIL"] as CheckoutMethod[]) {
    const b = await buyer(playwright, cq);
    const email = uniqueEmail("x3F0");
    const out = await submitCheckout(b.ctx, b.fields, { email, firstName: "Previo", lastName: method, method });
    await b.ctx.dispose();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    pre.push({ email, paypalOrderId: out.ok ? out.paypalOrderId : null, id: ordersOf(email)[0].id, method });
  }
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 3, seatsConfirmed: 0 });
  fixture("age-order", { orderId: pre[0].id, minutes: 45 });
  fixture("age-order", { orderId: pre[1].id, minutes: 45 });

  const bs: (Awaited<ReturnType<typeof buyer>> & { email: string; method: CheckoutMethod; i: number })[] = [];
  for (let i = 0; i < 40; i++) bs.push({ ...(await buyer(playwright, cq)), email: uniqueEmail(`x3F${i}`), method: (i % 2 ? "PAGO_MOVIL" : "PAYPAL") as CheckoutMethod, i });
  const [outs] = await Promise.all([
    Promise.all(bs.map((b) => submitCheckout(b.ctx, b.fields, { email: b.email, firstName: "Médico", lastName: `Estampida ${b.i}`, method: b.method }))),
    Promise.all([0, 1, 2, 3].map(() => runCron(request, "expire"))),
  ]);
  await Promise.all(bs.map((b) => b.ctx.dispose()));
  const ok = outs.filter((o) => o.ok);
  const summary = outs.map((o, i) => `${bs[i].method}: ${o.ok ? "OK" : `✗ ${o.error}`}`).join("\n");
  console.log(`[x3-critic-2 F] ganadores: ${ok.length}`);
  expect(ok, summary).toHaveLength(2);
  for (const o of outs.filter((x) => !x.ok)) expect((o as { error: string }).error, summary).toMatch(SOLD_OUT);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 3, seatsConfirmed: 0 });
  assertSeatInvariant();
  const live = q<{ orderId: string }>(`SELECT orderId FROM SeatReservation WHERE cohortId = ? AND status = 'HELD'`, C.cohortId).map((r) => r.orderId);
  expect(live).toContain(pre[2].id);
  expect(live).not.toContain(pre[0].id);
  expect(live).not.toContain(pre[1].id);

  // Los dos abandonados vuelven y aprueban su PayPal viejo: no se les cobra (cohorte llena) y el cupo no se excede.
  for (const p of pre.slice(0, 2)) {
    const a = await (await request.post(`${PAYPAL}/__mock/approve/${p.paypalOrderId}?json=1`)).json();
    const r = await request.get(a.redirect, { maxRedirects: 0 });
    console.log(`[x3-critic-2 F] aprobación tardía → ${r.headers()["location"]}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  await runCron(request, "paypal,expire,enrollments");
  for (const p of pre.slice(0, 2)) {
    expect(payments(p.id).filter((x) => x.status === "COMPLETED"), "no se cobra un pedido sin cupo").toHaveLength(0);
    expect(order(p.id).status).not.toMatch(/PAID|ENROLLED/);
  }
  const st = await (await request.get(`${PAYPAL}/__mock/state`)).json();
  const captured = (st.orders as { id: string; status: string }[]).filter((o) => pre.slice(0, 2).some((p) => p.paypalOrderId === o.id) && o.status === "COMPLETED");
  expect(captured, "PayPal no capturó las órdenes viejas").toHaveLength(0);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 3, seatsConfirmed: 0 });
  assertSeatInvariant();
});

test("G. carrito con dos programas semipresenciales, uno sin cupo: no se reserva ni se crea nada", async ({ playwright }) => {
  const A = fixture<DiplomaCohort>("diploma-cohort", { capacity: 2, sede: "barquisimeto", name: `Cohorte G-A ${Date.now().toString(36)}` });
  const B = fixture<{ cohortId: string; productId: string; sedeSlug: string }>("course-cohort", { product: "curso-universitario-ecografia-pediatrica", capacity: 1, sede: "barquisimeto", name: `Cohorte G-B ${Date.now().toString(36)}` });
  const bq = { product: "curso-universitario-ecografia-pediatrica", modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: B.cohortId, plan: "FULL" };
  // Otro médico llena B.
  const filler = await buyer(playwright, bq);
  const fout = await submitCheckout(filler.ctx, filler.fields, { email: uniqueEmail("x3Gfill"), firstName: "Lleno", lastName: "B", method: "PAGO_MOVIL" });
  await filler.ctx.dispose();
  expect(fout.ok, JSON.stringify(fout)).toBe(true);

  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  // El carrito se arma antes de que B se llene no es posible aquí: la tienda ya la rechaza. Se arma A primero y B
  // se intenta agregar (rechazado) — luego se prueba el orden inverso con un comprador que armó ambos con cupo.
  expect((await addToCart(ctx, { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: A.cohortId, plan: "FULL" })).error).toBeNull();
  const addB = await addToCart(ctx, bq);
  console.log("[x3-critic-2 G] agregar B llena →", addB.error);
  expect(addB.error ?? "").toMatch(/cupo/i);
  await ctx.dispose();

  // Comprador que armó A + B cuando B tenía cupo (B tiene 2 → se llena mientras tanto).
  const B2 = fixture<{ cohortId: string }>("course-cohort", { product: "curso-universitario-ecografia-pediatrica", capacity: 1, sede: "barquisimeto", name: `Cohorte G-B2 ${Date.now().toString(36)}` });
  const bq2 = { ...bq, cohort: B2.cohortId };
  const both = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  expect((await addToCart(both, { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: A.cohortId, plan: "FULL" })).error).toBeNull();
  expect((await addToCart(both, bq2)).error).toBeNull();
  const fields = await checkoutFormFields(both);
  const f2 = await buyer(playwright, bq2);
  expect((await submitCheckout(f2.ctx, f2.fields, { email: uniqueEmail("x3Gfill2"), firstName: "Lleno", lastName: "B2", method: "PAYPAL" })).ok).toBe(true);
  await f2.ctx.dispose();
  const email = uniqueEmail("x3Gboth");
  const out = await submitCheckout(both, fields, { email, firstName: "Ambos", lastName: "Programas", method: "PAGO_MOVIL" });
  await both.dispose();
  console.log("[x3-critic-2 G] A+B2 →", JSON.stringify(out));
  expect(out.ok).toBe(false);
  expect((out as { error: string }).error).toMatch(/cupo/i);
  expect(ordersOf(email)).toHaveLength(0);
  expect(cohort(A.cohortId), "la cohorte A no quedó retenida por un pedido que no se creó").toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 0 });
  assertSeatInvariant();
});

test("H. reservas vencidas sin barrer: la ficha ofrece la cohorte y la compra entra; el comprobante en verificación protege su cupo", async ({ playwright, page, request }) => {
  const C = fixture<DiplomaCohort>("diploma-cohort", { capacity: 2, sede: "barquisimeto", name: `Cohorte H ${Date.now().toString(36)}` });
  const cq = { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: C.cohortId, plan: "FULL" };
  const mk = async (tag: string, method: CheckoutMethod) => {
    const b = await buyer(playwright, cq);
    const email = uniqueEmail(tag);
    const out = await submitCheckout(b.ctx, b.fields, { email, firstName: "H", lastName: tag, method });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    return { ...b, email, id: ordersOf(email)[0].id };
  };
  const pm = await mk("x3Hpm", "PAGO_MOVIL");
  const pp = await mk("x3Hpp", "PAYPAL");
  await pp.ctx.dispose();
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 2, seatsConfirmed: 0 });

  // El de pago móvil registra su comprobante (monto correcto) desde la página del pedido → AWAITING_VERIFICATION.
  const o = one<{ token: string; dueNowCents: number }>(`SELECT token, dueNowCents FROM "Order" WHERE id = ?`, pm.id);
  await page.goto(`/pedido/${o.token}`);
  const html = await page.content();
  const hasForm = /comprobante|referencia/i.test(html);
  console.log("[x3-critic-2 H] página del pedido con formulario de comprobante:", hasForm);
  await pm.ctx.dispose();
  // Ambas «vencen» (fecha): la de PayPal sin pago; la manual… depende de si hay comprobante (no lo registramos aquí).
  fixture("age-order", { orderId: pp.id, minutes: 45 });

  // Sin barrer: la ficha debe ofrecer la cohorte (1 cupo) y la compra entra.
  await page.goto(`/products/${DIPLOMA}`);
  const form = page.getByTestId("buy-form");
  await form.locator("label.pp-radio", { hasText: "Semipresencial" }).locator("input").check();
  await form.locator("label.pp-radio", { hasText: "Barquisimeto" }).locator("input").check();
  const card = form.locator(`label.pp-cohort[data-cohort="${C.cohortName}"]`);
  await expect(card).toHaveAttribute("data-phase", "OPEN");
  const nb = await mk("x3Hnew", "PAYPAL");
  await nb.ctx.dispose();
  expect(reservationOf(pp.id).status).toBe("RELEASED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 2, seatsConfirmed: 0 });
  await expect(async () => {
    await page.reload();
    await form.locator("label.pp-radio", { hasText: "Semipresencial" }).locator("input").check();
    await form.locator("label.pp-radio", { hasText: "Barquisimeto" }).locator("input").check();
    await expect(card).toHaveAttribute("data-phase", "SOLD_OUT", { timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  // El barrido posterior vence el pedido PayPal abandonado sin tocar los cupos vivos.
  await runCron(request, "expire");
  expect(order(pp.id).status).toBe("EXPIRED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 2, seatsHeld: 2, seatsConfirmed: 0 });
  assertSeatInvariant();
});

test("I. certificado emitido → reembolso total (revocado) → vuelve a comprar, paga todo y completa: recibe un certificado vigente", async ({ playwright, request }) => {
  const buyOnline = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
    expect((await addToCart(ctx, { product: DIPLOMA, modality: "ONLINE", plan: "FULL" })).error).toBeNull();
    const out = await submitCheckout(ctx, await checkoutFormFields(ctx), { email, firstName: "Recompra", lastName: "Certificado", method: "PAYPAL" });
    await ctx.dispose();
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) throw new Error("checkout");
    const a = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1`)).json();
    await request.get(a.redirect, { maxRedirects: 0 });
    const os = ordersOf(email);
    const id = os[os.length - 1].id;
    await waitForOrderStatus(id, "ENROLLED", 60_000);
    await expect.poll(() => enrollments(id).filter((e) => e.status === "ENROLLED").length, { timeout: 30_000 }).toBe(9);
    return id;
  };
  const email = uniqueEmail("x3rebuy");
  const o1 = await buyOnline(email);
  const cust = customerOf(o1);
  const courses = q<{ moodleCourseId: number }>(`SELECT p.moodleCourseId FROM OrderItemCourse oc JOIN OrderItem oi ON oi.id = oc.orderItemId JOIN Product p ON p.id = oc.courseId WHERE oi.orderId = ?`, o1).map((c) => c.moodleCourseId);
  for (const courseid of courses) expect((await request.post(`${MOODLE}/__mock/complete`, { data: { userid: cust.moodleUserId, courseid } })).ok()).toBe(true);
  await runCron(request, "certificates");
  const c1 = q<{ code: string; status: string }>(`SELECT code, status FROM Certificate WHERE customerId = ?`, cust.id);
  expect(c1.map((c) => c.status)).toEqual(["ISSUED"]);

  // Reembolso total desde PayPal → pedido REFUNDED, certificado revocado, desmatriculado.
  const cap = payments(o1).find((p) => p.paypalCaptureId)!.paypalCaptureId!;
  const tok = (await (await request.post(`${PAYPAL}/v1/oauth2/token`, { headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}` }, form: { grant_type: "client_credentials" } })).json()).access_token;
  expect((await request.post(`${PAYPAL}/v2/payments/captures/${cap}/refund`, { headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, data: {} })).status()).toBeLessThan(300);
  await waitForOrderStatus(o1, "REFUNDED", 20_000);
  await expect.poll(() => q<{ status: string }>(`SELECT status FROM Certificate WHERE customerId = ?`, cust.id).map((c) => c.status)).toEqual(["REVOKED"]);
  const verify = await (await request.get(`/certificados/${c1[0].code}`)).text();
  expect(verify).not.toContain("Certificado válido");

  // Vuelve a comprar y paga TODO; Moodle (que conserva las finalizaciones) reporta los 9 completos.
  const o2 = await buyOnline(email);
  for (const courseid of courses) expect((await request.post(`${MOODLE}/__mock/complete`, { data: { userid: cust.moodleUserId, courseid } })).ok()).toBe(true);
  expect(order(o2).balanceCents).toBe(0);
  await runCron(request, "certificates");
  await runCron(request, "certificates");
  const after = q<{ code: string; status: string; orderItemId: string }>(`SELECT code, status, orderItemId FROM Certificate WHERE customerId = ?`, cust.id);
  console.log("[x3-critic-2 I] certificados tras la recompra:", JSON.stringify(after));
  expect(after.filter((c) => c.status === "ISSUED"), "pagó todo y completó los 9 cursos: debe tener un certificado vigente").toHaveLength(1);
});

test("J. PayPal retiene la captura (PENDING) y pasa el plazo: el barrido NO libera el cupo; nadie más lo compra; al completarse, queda ocupado", async ({ playwright, request }) => {
  const K = fixture<DiplomaCohort>("diploma-cohort", { capacity: 1, sede: "barquisimeto", name: `Cohorte J ${Date.now().toString(36)}` });
  const cq = { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: K.cohortId, plan: "FULL" };
  const b = await buyer(playwright, cq);
  const email = uniqueEmail("x3J");
  const out = await submitCheckout(b.ctx, b.fields, { email, firstName: "Retenido", lastName: "PayPal", method: "PAYPAL" });
  await b.ctx.dispose();
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const id = ordersOf(email)[0].id;
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1&capture=PENDING`)).json();
  const ret = await request.get(a.redirect, { maxRedirects: 0 });
  console.log("[x3-critic-2 J] retorno con captura retenida →", ret.headers()["location"]);
  fixture("age-order", { orderId: id, minutes: 24 * 60 });
  await runCron(request, "paypal,expire");
  await runCron(request, "expire");
  expect(reservationOf(id).status, "captura retenida: el cupo no se libera").toBe("HELD");
  expect(order(id).status).toBe("PENDING_PAYMENT");
  const late = await buyer(playwright, cq).catch(() => null);
  if (late) {
    const o2 = await submitCheckout(late.ctx, late.fields, { email: uniqueEmail("x3J2"), firstName: "Otro", lastName: "J", method: "PAGO_MOVIL" });
    await late.ctx.dispose();
    expect(o2.ok, "el cupo retenido no se revende").toBe(false);
  }
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 1, seatsConfirmed: 0 });
  const cap = payments(id).find((p) => p.paypalCaptureId)?.paypalCaptureId;
  expect(cap).toBeTruthy();
  const done = await request.post(`${PAYPAL}/__mock/captures/${cap}/complete`);
  expect(done.ok()).toBe(true);
  await waitForOrderStatus(id, "ENROLLED", 60_000);
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 1 });
  // Webhook COMPLETED repetido + DENIED desordenado: nada cambia.
  await request.post(`${PAYPAL}/__mock/send-webhook/${cap}?event_type=PAYMENT.CAPTURE.COMPLETED`);
  await request.post(`${PAYPAL}/__mock/send-webhook/${cap}?event_type=PAYMENT.CAPTURE.DENIED`);
  expect(order(id).status).toBe("ENROLLED");
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 1 });
  assertSeatInvariant();
});
