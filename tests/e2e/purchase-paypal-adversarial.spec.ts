// Pieza x1 — intentos de romper la compra PayPal → webhook → Moodle → cupo → correos por HTTP, contra la app
// y los mocks reales del carril. Cada test verifica el RESULTADO (BD, estado del mock de Moodle, órdenes y
// reembolsos del mock de PayPal, bandeja de correo), no solo la interfaz:
//   - compradores concurrentes por los últimos cupos (nunca sobreventa);
//   - doble clic / dos pestañas: dos órdenes PayPal aprobadas → se cobra una y la otra no se captura (o se reembolsa si se cruzaron);
//   - webhooks fuera de orden (DENIED después de COMPLETED), falsificados (cuerpo/firma) y de una orden ajena
//     con otro monto;
//   - Moodle falla (5xx, excepción transitoria, respuesta perdida tras matricular) → reintentos → una matrícula;
//   - reembolso a mitad de camino (Moodle caído): el reintento posterior NO matricula; reembolso desde PayPal;
//   - reservas vencidas: pago tardío con el cupo ya vendido (sin sobreventa ni matrícula) y con cupo libre;
//   - tope de retención al pulsar «Pagar con PayPal» una y otra vez.
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import {
  MOODLE,
  PAYPAL,
  cohort,
  customerOf,
  emails,
  enrolCallsFor,
  enrollments,
  events,
  fixture,
  fixtureAsync,
  moodleCalls,
  moodleState,
  one,
  q,
  order,
  payments,
  paypalConfig,
  paypalState,
  reservationOf,
  resendCaptureWebhook,
  runCron,
  uniqueEmail,
  waitForOrderStatus,
  type Checkout,
  type DiplomaCohort,
} from "./support/purchase";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(240_000);

test.beforeEach(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
});
test.afterAll(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});

function newCohort(capacity: number) {
  return fixture<DiplomaCohort>("diploma-cohort", { capacity, sede: "barquisimeto" });
}
function checkout(c: DiplomaCohort, tag: string, planKind: "FULL" | "HALF" | "MONTHLY" = "FULL") {
  const email = uniqueEmail(tag);
  const o = fixture<Checkout>("checkout", { productId: c.productId, cohortId: c.cohortId, planKind, email, lastName: `Pérez ${tag}` });
  return { o, email };
}

/** El comprador pulsa «Pagar con PayPal» en su pedido y queda en la página de PayPal (sin aprobar). */
async function startPaypal(page: Page, token: string): Promise<string> {
  await page.goto(`/pedido/${token}`);
  const pay = page.getByRole("button", { name: /con PayPal/ });
  await expect(pay).toBeVisible();
  await pay.click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  return new URL(page.url()).searchParams.get("token")!;
}

/** Aprueba la orden en PayPal (mock) y sigue el return URL como lo haría el navegador. Devuelve ?paypal=… */
async function approveAndReturn(request: APIRequestContext, paypalOrderId: string): Promise<string | null> {
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${paypalOrderId}?json=1`)).json();
  expect(a.redirect).toBeTruthy();
  const r = await request.get(a.redirect, { maxRedirects: 0 });
  expect(r.status()).toBe(303);
  return new URL(r.headers()["location"], e2eEnv.APP_URL).searchParams.get("paypal");
}

async function payFully(page: Page, request: APIRequestContext, token: string) {
  const pp = await startPaypal(page, token);
  expect(await approveAndReturn(request, pp)).toBe("completado");
  return pp;
}

async function userOf(request: APIRequestContext, email: string) {
  const st = await moodleState(request);
  return { users: st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase()), st };
}

/** Moodle: un usuario y exactamente estos cursos activos; correos de compra una sola vez cada uno. */
async function expectEnrolledOnce(request: APIRequestContext, orderId: string, email: string, courseIds: number[]) {
  const { users, st } = await userOf(request, email);
  expect(users, "un solo usuario Moodle").toHaveLength(1);
  const mine = st.enrolments.filter((e) => e.userid === users[0].id);
  expect(mine.map((e) => e.courseid).sort((a, b) => a - b), "una matrícula por curso").toEqual([...courseIds].sort((a, b) => a - b));
  expect(mine.every((e) => e.status === 0)).toBe(true);
  const calls = await moodleCalls(request);
  expect(calls.filter((c) => c.wsfunction === "core_user_create_users" && JSON.stringify(c.params).toLowerCase().includes(email.toLowerCase()))).toHaveLength(1);
  const mails = emails(orderId);
  for (const t of ["order_confirmation", "cohort_details"]) expect(mails.filter((m) => m.template === t), t).toHaveLength(1);
  // Acceso: UN correo del pedido; si Moodle falló tras crear la cuenta, antes salió UNO con las credenciales
  // (la contraseña no se guarda). La contraseña temporal viaja exactamente una vez.
  const access = mails.filter((m) => m.template === "platform_access");
  expect(access.filter((m) => m.dedupeKey === `platform_access:${orderId}`), "platform_access").toHaveLength(1);
  expect(access.filter((m) => m.dedupeKey !== `platform_access:${orderId}`).every((m) => m.dedupeKey?.startsWith("platform_credentials:"))).toBe(true);
  expect(access.filter((m) => m.secretRef), "contraseña temporal una sola vez").toHaveLength(1);
  expect(mails.every((m) => m.status === "SENT")).toBe(true);
  return users[0];
}

async function paypalToken(request: APIRequestContext): Promise<string> {
  const r = await request.post(`${PAYPAL}/v1/oauth2/token`, {
    headers: { authorization: `Basic ${Buffer.from(`${e2eEnv.PAYPAL_CLIENT_ID}:${e2eEnv.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    data: "grant_type=client_credentials",
  });
  expect(r.ok()).toBe(true);
  return (await r.json()).access_token;
}

test("compradores concurrentes por los últimos 2 cupos: nunca se vende de más", async ({ browser, request }) => {
  const c = newCohort(2);
  const buyers = Array.from({ length: 6 }, (_, i) => ({ email: uniqueEmail(`race${i}`), i }));
  const results = await Promise.all(
    buyers.map((b) => fixtureAsync<Checkout>("checkout", { productId: c.productId, cohortId: c.cohortId, planKind: "FULL", email: b.email, lastName: `Carrera ${b.i}` })),
  );
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok) as { ok: false; error: string }[];
  expect(ok, "exactamente 2 checkouts obtienen cupo").toHaveLength(2);
  for (const f of failed) expect(f.error).toMatch(/SOLD_OUT|cupo/i);
  expect(cohort(c.cohortId)).toEqual({ capacity: 2, seatsHeld: 2, seatsConfirmed: 0 });

  // Los dos ganadores pagan A LA VEZ, cada uno en su navegador.
  const winners = ok.map((r) => (r as { ok: true; value: Checkout }).value);
  await Promise.all(
    winners.map(async (w) => {
      const ctx = await (browser as Browser).newContext({ baseURL: e2eEnv.APP_URL });
      try {
        await payFully(await ctx.newPage(), request, w.token);
      } finally {
        await ctx.close();
      }
    }),
  );
  for (const w of winners) await waitForOrderStatus(w.orderId, "ENROLLED", 60_000);
  expect(cohort(c.cohortId)).toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 2 });
  for (const w of winners) await expectEnrolledOnce(request, w.orderId, customerOf(w.orderId).email, c.courses.map((x) => x.moodleCourseId));

  // Un séptimo comprador ya no puede comprar esa cohorte.
  const late = await fixtureAsync("checkout", { productId: c.productId, cohortId: c.cohortId, planKind: "FULL", email: uniqueEmail("late") });
  expect(late.ok).toBe(false);
  expect(cohort(c.cohortId).seatsConfirmed).toBe(2);
});

test("doble clic / dos pestañas: dos órdenes PayPal aprobadas → se cobra una; la otra no se captura (o, si ambas capturas se cruzaron, se reembolsa sola)", async ({ browser, request }) => {
  const c = newCohort(3);
  const { o, email } = checkout(c, "dbl");
  const ctxA = await browser.newContext({ baseURL: e2eEnv.APP_URL });
  const ctxB = await browser.newContext({ baseURL: e2eEnv.APP_URL });
  let returns: (string | null)[] = [];
  try {
    const [ppA, ppB] = await Promise.all([startPaypal(await ctxA.newPage(), o.token), startPaypal(await ctxB.newPage(), o.token)]);
    expect(ppA).not.toBe(ppB);
    // El comprador aprueba LAS DOS (la primera pestaña quedó abierta) y ambos retornos llegan a la vez.
    returns = await Promise.all([approveAndReturn(request, ppA), approveAndReturn(request, ppB)]);
    // x2 crítico 15: si el pedido ya quedó pagado cuando llega el segundo retorno, ese NO se captura («no-cobrado»);
    // solo si las dos capturas salieron a la vez PayPal cobra ambas y el excedente se reembolsa solo.
    expect(returns.sort()).toEqual(expect.arrayContaining(["completado"]));
    expect(returns.every((r) => r === "completado" || r === "no-cobrado"), returns.join(",")).toBe(true);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
  await waitForOrderStatus(o.orderId, "ENROLLED", 60_000);
  const bothCaptured = returns.every((r) => r === "completado");
  if (bothCaptured) {
    // Esperar a que el reembolso automático del excedente se refleje (webhook REFUNDED incluido).
    await expect.poll(() => payments(o.orderId).filter((p) => p.status === "REFUNDED").length, { timeout: 30_000 }).toBe(1);
  }
  const pays = payments(o.orderId);
  expect(pays.filter((p) => p.status === "COMPLETED")).toHaveLength(1);
  expect(order(o.orderId)).toMatchObject({ status: "ENROLLED", amountPaidCents: o.totalCents, balanceCents: 0 });
  const refunded = q<{ amountCents: number; status: string }>(`SELECT r.amountCents, r.status FROM Refund r JOIN Payment p ON p.id = r.paymentId WHERE p.orderId = ?`, o.orderId);
  const caps = pays.map((p) => p.paypalCaptureId).filter(Boolean);
  if (bothCaptured) {
    expect(refunded, "un solo reembolso, por el pago duplicado completo").toEqual([{ amountCents: o.totalCents, status: "COMPLETED" }]);
    const st = await paypalState(request);
    expect(caps).toHaveLength(2);
    const refunds = (st as unknown as { refunds?: { status: string; links?: unknown; amount: { value: string } }[] }).refunds ?? [];
    expect(refunds.filter((r) => r.status === "COMPLETED" && Math.round(Number(r.amount.value) * 100) === o.totalCents).length).toBeGreaterThanOrEqual(1);
  } else {
    // Un solo cobro: la segunda aprobación queda sin capturar y sin reembolso (ni comisión perdida).
    expect(caps).toHaveLength(1);
    expect(refunded).toEqual([]);
    expect(q(`SELECT id FROM Payment WHERE orderId = ? AND status = 'CANCELLED' AND providerStatus = 'NOT_CAPTURED'`, o.orderId)).toHaveLength(1);
    expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND type = 'PAYMENT_NOT_CAPTURED'`, o.orderId)).toHaveLength(1);
  }
  expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
  await expectEnrolledOnce(request, o.orderId, email, c.courses.map((x) => x.moodleCourseId));
});

test("webhooks fuera de orden, falsificados y de una orden ajena con otro monto: no cambian nada", async ({ page, request }) => {
  const c = newCohort(3);
  const { o, email } = checkout(c, "ooo");

  // Orden PayPal AJENA (monto 1.00, mismo custom_id/invoice del pedido) aprobada y capturada: su webhook llega firmado.
  const tok = await paypalToken(request);
  const foreign = await (
    await request.post(`${PAYPAL}/v2/checkout/orders`, {
      headers: { authorization: `Bearer ${tok}` },
      data: { intent: "CAPTURE", purchase_units: [{ custom_id: o.orderId, invoice_id: `${o.number}-evil`, amount: { currency_code: "USD", value: "1.00" } }] },
    })
  ).json();
  await request.post(`${PAYPAL}/__mock/approve/${foreign.id}?json=1`);
  const fcap = await (await request.post(`${PAYPAL}/v2/checkout/orders/${foreign.id}/capture`, { headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, data: {} })).json();
  const foreignCapture = fcap.purchase_units[0].payments.captures[0].id;
  const fw = await resendCaptureWebhook(request, foreignCapture);
  expect(fw.status).toBeLessThan(500); // registrado, sin reintentos infinitos
  // …y su return URL contra nuestro pedido.
  const back = await request.get(`/pedido/${o.token}/paypal/retorno?token=${foreign.id}`, { maxRedirects: 0 });
  expect(new URL(back.headers()["location"], e2eEnv.APP_URL).searchParams.get("paypal")).toBe("error");
  expect(order(o.orderId)).toMatchObject({ status: "PENDING_PAYMENT", amountPaidCents: 0 });
  expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 1, seatsConfirmed: 0 });

  // Pago real, SIN webhooks automáticos: el retorno captura.
  await paypalConfig(request, { autoWebhooks: false, approvalWebhooks: false });
  const pp = await payFully(page, request, o.token);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  const cap = payments(o.orderId).find((p) => p.paypalOrderId === pp)!.paypalCaptureId!;

  // DENIED llega DESPUÉS del COMPLETED (fuera de orden) → no deshace el pago.
  const denied = await (await request.post(`${PAYPAL}/__mock/send-webhook/${cap}?event_type=PAYMENT.CAPTURE.DENIED`)).json();
  expect(denied.status).toBe(200);
  // Webhooks falsificados: cuerpo alterado y firma alterada → 400, sin efecto.
  for (const tamper of ["body", "signature"]) {
    const t = await (await request.post(`${PAYPAL}/__mock/send-webhook/${cap}?event_type=PAYMENT.CAPTURE.DENIED&tamper=${tamper}`)).json();
    expect(t.status, `tamper=${tamper}`).toBe(400);
  }
  // Cuerpo ilegible y evento sin firmar (sin cabeceras paypal-*) → 400: PayPal no debe reintentarlos.
  const garbage = await request.post(`/api/webhooks/paypal`, { headers: { "content-type": "application/json" }, data: "not json" });
  expect(garbage.status()).toBe(400);
  const unsigned = await request.post(`/api/webhooks/paypal`, { data: { id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "X", amount: { value: "1278.00", currency_code: "USD" }, links: [{ rel: "up", href: `${PAYPAL}/v2/payments/captures/${cap}` }] } } });
  expect(unsigned.status()).toBe(400);
  // COMPLETED tardío (el caso normal, llega después del retorno) dos veces.
  expect((await resendCaptureWebhook(request, cap)).status).toBe(200);
  expect((await resendCaptureWebhook(request, cap)).status).toBe(200);

  expect(order(o.orderId)).toMatchObject({ status: "ENROLLED", amountPaidCents: o.totalCents, balanceCents: 0 });
  const pays = payments(o.orderId);
  expect(pays.filter((p) => p.status === "COMPLETED")).toHaveLength(1);
  expect(events(o.orderId, "PAYMENT_RECEIVED")).toHaveLength(1);
  expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
  await expectEnrolledOnce(request, o.orderId, email, c.courses.map((x) => x.moodleCourseId));
});

test("Moodle falla (5xx, excepción transitoria y respuesta perdida tras matricular): reintentos → una sola matrícula y un solo correo", async ({ page, request }) => {
  const before = fixture<{ before: unknown }>("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } }).before;
  try {
    const c = newCohort(3);
    const { o, email } = checkout(c, "mfail");
    // 1ª pasada: 3 fallos seguidos (el intento en línea + 2 reintentos en línea) → queda para el job.
    await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "http", status: 503, count: 2 } });
    await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "exception", exception: "dml_write_exception", errorcode: "dmlwriteexception", message: "Error writing to database", count: 1 } });
    await payFully(page, request, o.token);
    await waitForOrderStatus(o.orderId, "PAID");
    await expect.poll(() => events(o.orderId, "ENROLLMENT_FAILED").length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    // 2ª pasada (job): Moodle matricula pero la respuesta se pierde.
    await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "http", status: 502, after: true, count: 3 } });
    await expect
      .poll(async () => {
        await runCron(request, "enrollments");
        return order(o.orderId).status;
      }, { timeout: 120_000, intervals: [3_000] })
      .toBe("ENROLLED");
    expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });
    const user = await expectEnrolledOnce(request, o.orderId, email, c.courses.map((x) => x.moodleCourseId));
    // Las llamadas se repitieron (idempotentes), pero el estado final es una matrícula por curso.
    expect(enrolCallsFor(await moodleCalls(request), user.id).length).toBeGreaterThan(c.courses.length);
    // La contraseña temporal viajó en un solo correo.
    expect(emails(o.orderId).filter((m) => m.secretRef)).toHaveLength(1);
  } finally {
    if (before) fixture("setting", { key: "enrollment.retry", value: before });
  }
});

test("reembolso a mitad de camino (Moodle caído): el reintento posterior no matricula y el cupo se libera", async ({ page, request }) => {
  const before = fixture<{ before: unknown }>("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } }).before;
  try {
    const c = newCohort(3);
    const { o, email } = checkout(c, "midref");
    await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_enrol_users", type: "http", status: 503, count: 3 } });
    const pp = await payFully(page, request, o.token);
    await waitForOrderStatus(o.orderId, "PAID");
    await expect.poll(() => events(o.orderId, "ENROLLMENT_FAILED").length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 1 });

    const pay = payments(o.orderId).find((p) => p.paypalOrderId === pp)!;
    const r = fixture<{ status: string; fullyRefunded: boolean }>("refund", { paymentId: pay.id, reason: "El médico desiste" });
    expect(r.fullyRefunded).toBe(true);
    await waitForOrderStatus(o.orderId, "REFUNDED");
    expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });

    // Moodle vuelve; el job de reintentos NO debe matricular un pedido reembolsado. (Esperar al backoff.)
    await new Promise((res) => setTimeout(res, 6_000));
    for (let i = 0; i < 3; i++) await runCron(request, "enrollments");
    const { users, st } = await userOf(request, email);
    const active = users.length ? st.enrolments.filter((e) => e.userid === users[0].id && e.status === 0) : [];
    expect(active, "sin matrículas activas tras el reembolso").toHaveLength(0);
    expect(order(o.orderId).status).toBe("REFUNDED");
    expect(emails(o.orderId).filter((m) => m.template === "platform_access" && !m.dedupeKey?.startsWith("platform_credentials:"))).toHaveLength(0);
    expect(emails(o.orderId).filter((m) => m.template === "cohort_details")).toHaveLength(0);
    expect(enrollments(o.orderId).every((e) => e.status !== "ENROLLED")).toBe(true);
  } finally {
    if (before) fixture("setting", { key: "enrollment.retry", value: before });
  }
});

test("reembolso hecho desde PayPal (webhook REFUNDED) tras matricular: pedido reembolsado, cupo libre, sin matrícula", async ({ page, request }) => {
  const c = newCohort(3);
  const { o, email } = checkout(c, "ppref");
  const pp = await payFully(page, request, o.token);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  const cap = payments(o.orderId).find((p) => p.paypalOrderId === pp)!.paypalCaptureId!;
  const tok = await paypalToken(request);
  const rr = await request.post(`${PAYPAL}/v2/payments/captures/${cap}/refund`, { headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, data: {} });
  expect(rr.ok()).toBe(true);
  await waitForOrderStatus(o.orderId, "REFUNDED", 30_000);
  // La reentrega del REFUNDED no reembolsa dos veces.
  for (let i = 0; i < 2; i++) {
    const again = await (await request.post(`${PAYPAL}/__mock/send-webhook/${cap}?event_type=PAYMENT.CAPTURE.REFUNDED`)).json();
    expect(again.status).toBe(200);
  }
  const refunded = q<{ amountCents: number; status: string }>(`SELECT r.amountCents, r.status FROM Refund r JOIN Payment p ON p.id = r.paymentId WHERE p.orderId = ?`, o.orderId);
  expect(refunded, "un solo reembolso aunque el webhook se repita").toEqual([{ amountCents: o.totalCents, status: "COMPLETED" }]);
  expect(order(o.orderId)).toMatchObject({ status: "REFUNDED", amountPaidCents: 0, balanceCents: 0 });
  expect(cohort(c.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  const { users, st } = await userOf(request, email);
  expect(st.enrolments.filter((e) => e.userid === users[0].id && e.status === 0)).toHaveLength(0);
});

test("reserva vencida y cupo vendido a otro: la aprobación tardía NO se captura (no se cobra), no sobrevende ni matricula", async ({ browser, request }) => {
  const c = newCohort(1);
  const a = checkout(c, "lateA");
  const ctxA = await browser.newContext({ baseURL: e2eEnv.APP_URL });
  const ppA = await startPaypal(await ctxA.newPage(), a.o.token);
  await ctxA.close();
  // Pasan 40 min sin aprobar: el barrido vence el pedido y libera el cupo.
  fixture("age-order", { orderId: a.o.orderId, minutes: 40 });
  await runCron(request, "expire");
  expect(order(a.o.orderId).status).toBe("EXPIRED");
  expect(reservationOf(a.o.orderId).status).toBe("RELEASED");
  expect(cohort(c.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 0 });

  // Otro médico toma el cupo y paga.
  const b = checkout(c, "lateB");
  const ctxB = await browser.newContext({ baseURL: e2eEnv.APP_URL });
  await payFully(await ctxB.newPage(), request, b.o.token);
  await ctxB.close();
  await waitForOrderStatus(b.o.orderId, "ENROLLED");
  expect(cohort(c.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 1 });

  // A aprueba su orden PayPal vieja y vuelve; además llegan CHECKOUT.ORDER.APPROVED y la conciliación.
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: true, webhookDelayMs: 0 });
  expect(await approveAndReturn(request, ppA)).toBe("no-cobrado"); // aprobó, pero no se cobró: no es «PayPal no aprobó el pago»
  await expect.poll(async () => (await paypalState(request)).webhooks.filter((w) => w.orderId === ppA || w.resourceId === ppA).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await runCron(request, "paypal,enrollments");
  expect(cohort(c.cohortId), "nunca más confirmados que el cupo").toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 1 });
  // No se le cobró: la orden PayPal quedó aprobada SIN captura.
  const ppOrder = (await paypalState(request)).orders.find((x) => x.id === ppA)!;
  expect(ppOrder.status).toBe("APPROVED");
  expect(ppOrder.purchase_units[0].payments?.captures ?? []).toHaveLength(0);
  expect(order(a.o.orderId)).toMatchObject({ status: "EXPIRED", amountPaidCents: 0 });
  expect(payments(a.o.orderId).map((p) => p.status)).toEqual(["CANCELLED"]);
  expect(events(a.o.orderId, "PAYMENT_NOT_CAPTURED")).toHaveLength(1);
  expect(events(a.o.orderId, "PAYMENT_RECEIVED")).toHaveLength(0);
  const { users, st } = await userOf(request, a.email);
  const active = users.length ? st.enrolments.filter((e) => e.userid === users[0].id && e.status === 0) : [];
  expect(active, "A no queda matriculado sin cupo").toHaveLength(0);
  expect(emails(a.o.orderId), "ni confirmación de compra, ni acceso, ni cohorte").toHaveLength(0);
});

test("reserva vencida pero con cupo libre: el pago tardío vuelve a tomar el cupo y matricula una vez", async ({ browser, request }) => {
  const c = newCohort(2);
  const a = checkout(c, "lateFree");
  const ctx = await browser.newContext({ baseURL: e2eEnv.APP_URL });
  const pp = await startPaypal(await ctx.newPage(), a.o.token);
  await ctx.close();
  fixture("age-order", { orderId: a.o.orderId, minutes: 40 });
  await runCron(request, "expire");
  expect(order(a.o.orderId).status).toBe("EXPIRED");
  expect(cohort(c.cohortId)).toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 0 });
  expect(await approveAndReturn(request, pp)).toBe("completado");
  await waitForOrderStatus(a.o.orderId, "ENROLLED");
  expect(cohort(c.cohortId)).toEqual({ capacity: 2, seatsHeld: 0, seatsConfirmed: 1 });
  expect(reservationOf(a.o.orderId).status).toBe("CONFIRMED");
  expect(events(a.o.orderId, "SEAT_REACQUIRED"), "el cupo se retoma ANTES de capturar").toHaveLength(1);
  await expectEnrolledOnce(request, a.o.orderId, a.email, c.courses.map((x) => x.moodleCourseId));
});

test("tope de retención: pulsar «Pagar con PayPal» una y otra vez no retiene el cupo más de 90 min desde el pedido", async ({ page, request }) => {
  const c = newCohort(1);
  const { o } = checkout(c, "cap");
  const placed = () => one<{ placedAt: string; expiresAt: string }>(`SELECT placedAt, expiresAt FROM "Order" WHERE id = ?`, o.orderId);
  const resv = () => one<{ expiresAt: string; status: string }>(`SELECT expiresAt, status FROM SeatReservation WHERE orderId = ?`, o.orderId);
  const CAP = 90 * 60_000;

  // A los 70 min (dentro del tope): un intento extiende solo hasta placedAt + 90 min, no ahora + 30.
  fixture("age-order", { orderId: o.orderId, minutes: 25 });
  await startPaypal(page, o.token);
  fixture("age-order", { orderId: o.orderId, minutes: 25 });
  await startPaypal(page, o.token);
  fixture("age-order", { orderId: o.orderId, minutes: 20 });
  await startPaypal(page, o.token);
  const t = placed();
  const ms = (x: unknown) => Date.parse(String(x));
  expect(ms(t.expiresAt) - ms(t.placedAt), "el pedido no vence más allá de placedAt + 90 min").toBe(CAP);
  expect(ms(resv().expiresAt) - ms(t.placedAt), "la reserva tampoco").toBe(CAP);
  expect(events(o.orderId, "SEAT_HOLD_EXTENDED")).toHaveLength(3);
  const ppCount = payments(o.orderId).length;

  // Pasado el tope: el botón ya no abre otra orden PayPal y el barrido libera el cupo.
  fixture("age-order", { orderId: o.orderId, minutes: 25 });
  await page.goto(`/pedido/${o.token}`);
  const pay = page.getByRole("button", { name: /con PayPal/ });
  if (await pay.count()) {
    await pay.click();
    await page.waitForURL((u) => u.searchParams.get("pago") === "error" || u.href.startsWith(`${PAYPAL}/`), { timeout: 30_000 });
    expect(page.url().startsWith(`${PAYPAL}/`), "no debe llegar a PayPal pasado el tope").toBe(false);
  }
  expect(payments(o.orderId).length, "ninguna orden PayPal nueva pasado el tope").toBe(ppCount);
  await runCron(request, "expire");
  expect(cohort(c.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 0 });
  expect(order(o.orderId).status).toBe("EXPIRED");
  const other = await fixtureAsync("checkout", { productId: c.productId, cohortId: c.cohortId, planKind: "FULL", email: uniqueEmail("capnext") });
  expect(other.ok, "el cupo liberado lo puede comprar otro").toBe(true);
});
