// Crítico x3 — intentos adversariales por HTTP contra el carril (E2E_LANE=e2e-cert E2E_PORT=3105):
//   A. Carrera certificado × reembolso: el job de certificados está consultando Moodle (lento) y en ese momento
//      PayPal registra el reembolso total del diplomado (webhook). El pedido queda REFUNDED: el job NO debe
//      terminar emitiendo (ni enviando por correo) un certificado para un diplomado que ya no está pagado.
//   B. Fallos de Moodle durante la verificación de finalización (excepción, HTML basura, 503): ninguna corrida
//      emite con un curso sin confirmar; al recuperarse Moodle se emite exactamente uno.
//   C. Doble clic en «pagar» (misma sesión, 6 envíos simultáneos) por una cohorte con 3 cupos: no se comen
//      varios cupos para el mismo comprador.
//   D. Webhooks duplicados/desordenados + pago tardío tras vencer la reserva con la cohorte revendida: el cupo
//      confirmado nunca supera la capacidad.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, enrollments, fixture, one, order, paypalConfig, payments, q, runCron, uniqueEmail, waitForOrderStatus, type DiplomaCohort } from "./support/purchase";
import { addToCart, checkoutFormFields, submitCheckout } from "./support/storefront";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor");
});
test.setTimeout(300_000);

const DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";
const diplomaId = () => one<{ id: string }>(`SELECT id FROM Product WHERE slug = ?`, DIPLOMA).id;

async function buyOnlineFull(request: APIRequestContext, ctx: APIRequestContext, tag: string) {
  expect((await addToCart(ctx, { product: DIPLOMA, modality: "ONLINE", plan: "FULL" })).error).toBeNull();
  const email = uniqueEmail(tag);
  const out = await submitCheckout(ctx, await checkoutFormFields(ctx), { email, firstName: "Crítico", lastName: tag, method: "PAYPAL" });
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error("checkout");
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1`)).json();
  await request.get(a.redirect, { maxRedirects: 0 });
  const o = one<{ id: string }>(`SELECT o.id FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email);
  await waitForOrderStatus(o.id, "ENROLLED", 60_000);
  await expect.poll(() => enrollments(o.id).filter((e) => e.status === "ENROLLED").length, { timeout: 30_000 }).toBe(9);
  const courses = q<{ moodleCourseId: number }>(
    `SELECT p.moodleCourseId FROM OrderItemCourse oc JOIN OrderItem oi ON oi.id = oc.orderItemId JOIN Product p ON p.id = oc.courseId WHERE oi.orderId = ? ORDER BY oc.position`,
    o.id,
  ).map((c) => c.moodleCourseId);
  return { email, orderId: o.id, customerId: customerOf(o.id).id, moodleUserId: customerOf(o.id).moodleUserId!, courses };
}

async function completeAll(request: APIRequestContext, userid: number, courses: number[]) {
  for (const courseid of courses) expect((await request.post(`${MOODLE}/__mock/complete`, { data: { userid, courseid } })).ok()).toBe(true);
}

async function paypalToken(request: APIRequestContext) {
  const r = await request.post(`${PAYPAL}/v1/oauth2/token`, {
    headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}` },
    form: { grant_type: "client_credentials" },
  });
  return (await r.json()).access_token as string;
}

/** Vacía la cola de fallos inyectados del mock de Moodle (los tests son en serie: se descartan todos). */
async function drainMoodleFailures(request: APIRequestContext) {
  expect((await request.post(`${MOODLE}/__mock/fail-clear`)).ok()).toBe(true);
}

const certsOf = (customerId: string) =>
  q<{ id: string; code: string; status: string }>(`SELECT id, code, status FROM Certificate WHERE customerId = ? AND diplomaId = ?`, customerId, diplomaId());
const certMails = (email: string) => q<{ status: string }>(`SELECT status FROM EmailOutbox WHERE template = 'certificate_issued' AND "to" = ?`, email);

test.beforeEach(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
});

test("A. reembolso total por PayPal MIENTRAS el job verifica Moodle: no queda un certificado vigente para un diplomado reembolsado", async ({ request, playwright }) => {
  // Otras parejas sin certificado del carril (compras previas) también pasan por el barrido: se les da su propio
  // certificado o se sacan del camino primero, para que la lentitud caiga sobre el comprador de este test.
  await runCron(request, "certificates");
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  const b = await buyOnlineFull(request, ctx, "x3race");
  await ctx.dispose();
  await completeAll(request, b.moodleUserId, b.courses);

  // Moodle lento en la verificación de finalización (1,2 s por curso) y en la baja (la baja tarda en llegar).
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "core_completion_get_course_completion_status", userid: b.moodleUserId, type: "ok", delayMs: 1200, count: 60 } });
  await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "enrol_manual_unenrol_users", type: "ok", delayMs: 15_000, count: 3 } });

  const sweep = runCron(request, "certificates");
  // Esperar a que el barrido esté DENTRO de la verificación de ESTE comprador (ya leyó su pedido pagado).
  await expect
    .poll(async () => {
      const calls = (await (await request.get(`${MOODLE}/__mock/calls`)).json()) as { wsfunction: string; params: Record<string, unknown> }[];
      return calls.filter((c) => c.wsfunction === "core_completion_get_course_completion_status" && Number(c.params.userid) === b.moodleUserId).length;
    }, { timeout: 60_000, intervals: [100] })
    .toBeGreaterThanOrEqual(2);
  console.log("[x3-critic A] barrido dentro de la verificación del comprador; reembolsando…");
  // El médico pide el reembolso y CEIUM lo hace desde PayPal: PayPal envía PAYMENT.CAPTURE.REFUNDED.
  const cap = payments(b.orderId).find((p) => p.paypalCaptureId)!.paypalCaptureId!;
  const token = await paypalToken(request);
  const rr = await request.post(`${PAYPAL}/v2/payments/captures/${cap}/refund`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, data: {} });
  expect(rr.status(), await rr.text()).toBeLessThan(300);
  await waitForOrderStatus(b.orderId, "REFUNDED", 20_000);
  const res = await sweep;
  console.log("[x3-critic A] sweep:", JSON.stringify(res.results.certificates), "order:", order(b.orderId).status);

  // Después de todo (también otra corrida), no puede haber un certificado ISSUED para este pedido reembolsado.
  await new Promise((r) => setTimeout(r, 16_000));
  await runCron(request, "certificates");
  const certs = certsOf(b.customerId);
  console.log("[x3-critic A] certs:", JSON.stringify(certs), "mails:", JSON.stringify(certMails(b.email)));
  expect(order(b.orderId).status).toBe("REFUNDED");
  expect(certs.filter((c) => c.status === "ISSUED"), "certificado vigente de un diplomado reembolsado").toHaveLength(0);
  expect(certMails(b.email).filter((m) => m.status === "SENT"), "correo de certificado de un diplomado reembolsado").toHaveLength(0);
});

test("B. Moodle falla (excepción / HTML basura / 503) en la verificación: nunca emite con un curso sin confirmar; luego emite uno", async ({ request, playwright }) => {
  await drainMoodleFailures(request);
  await runCron(request, "certificates");
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  const b = await buyOnlineFull(request, ctx, "x3mfail");
  await ctx.dispose();
  // 8 de 9 → el job cachea 8 finalizaciones.
  await completeAll(request, b.moodleUserId, b.courses.slice(0, 8));
  await runCron(request, "certificates");
  expect(certsOf(b.customerId)).toHaveLength(0);
  expect(q(`SELECT id FROM Enrollment WHERE customerId = ? AND completedAt IS NOT NULL`, b.customerId)).toHaveLength(8);
  // Se completa el 9.º, pero Moodle falla en TODAS las consultas de finalización de esa corrida.
  await completeAll(request, b.moodleUserId, [b.courses[8]]);
  for (const type of ["exception", "garbage", "http"]) {
    await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "core_completion_get_course_completion_status", userid: b.moodleUserId, type, count: 60 } });
    await runCron(request, "certificates");
    expect(certsOf(b.customerId), `Moodle ${type}`).toHaveLength(0);
    await drainMoodleFailures(request);
  }
  // Recién se recupera: pero además, una de las finalizaciones cacheadas deja de estar (curso reiniciado) → no emite.
  await request.post(`${MOODLE}/__mock/complete`, { data: { userid: b.moodleUserId, courseid: b.courses[3], completed: false } });
  await runCron(request, "certificates");
  expect(certsOf(b.customerId), "curso reiniciado en Moodle").toHaveLength(0);
  await request.post(`${MOODLE}/__mock/complete`, { data: { userid: b.moodleUserId, courseid: b.courses[3] } });
  await Promise.all([runCron(request, "certificates"), runCron(request, "certificates"), runCron(request, "certificates")]);
  expect(certsOf(b.customerId)).toHaveLength(1);
  await expect.poll(() => certMails(b.email).map((m) => m.status)).toEqual(["SENT"]);
});

let C: DiplomaCohort;
const cartQuery = () => ({ product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: C.cohortId, plan: "FULL" });

test("C. doble clic: 6 envíos simultáneos del mismo checkout (misma sesión) no ocupan más de un cupo", async ({ playwright, request }) => {
  C = fixture<DiplomaCohort>("diploma-cohort", { capacity: 3, sede: "barquisimeto", name: `Cohorte crítico ${Date.now().toString(36)}` });
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  expect((await addToCart(ctx, cartQuery())).error).toBeNull();
  const fields = await checkoutFormFields(ctx);
  const email = uniqueEmail("x3dbl");
  const outs = await Promise.all(Array.from({ length: 6 }, () => submitCheckout(ctx, fields, { email, firstName: "Doble", lastName: "Clic", method: "PAYPAL" })));
  await ctx.dispose();
  console.log("[x3-critic C]", outs.map((o) => (o.ok ? `OK ${o.location}` : `✗ ${o.error}`)).join("\n"));
  const orders = q<{ id: string; status: string }>(`SELECT o.id, o.status FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email);
  const c = cohort(C.cohortId);
  console.log("[x3-critic C] orders", orders.length, "cohort", JSON.stringify(c));
  expect(c.seatsHeld + c.seatsConfirmed, "cupos tomados por un solo comprador con doble clic").toBe(1);
  expect(orders.filter((o) => o.status === "PENDING_PAYMENT")).toHaveLength(1);
  // Todos los clics llevan al mismo pedido (ninguno ve «Sin cupo» por culpa de sus propios clics).
  expect(outs.every((o) => o.ok), "cada clic continúa a PayPal").toBe(true);
  const pp = payments(orders[0].id);
  console.log("[x3-critic C] pagos PayPal del pedido:", JSON.stringify(pp.map((p) => [p.status, p.paypalOrderId])));
  // Los otros 2 cupos siguen disponibles para otros compradores.
  const other = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  expect((await addToCart(other, cartQuery())).error).toBeNull();
  const o2 = await submitCheckout(other, await checkoutFormFields(other), { email: uniqueEmail("x3dbl2"), firstName: "Otro", lastName: "Médico", method: "PAYPAL" });
  await other.dispose();
  expect(o2.ok, JSON.stringify(o2)).toBe(true);
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 2, seatsConfirmed: 0 });
  // Si el médico paga UNA de las órdenes PayPal generadas por sus clics, queda matriculado una vez y el cupo pasa a ocupado.
  const tokens = [...new Set(outs.filter((o) => o.ok).map((o) => (o as { paypalOrderId: string | null }).paypalOrderId!))];
  console.log("[x3-critic C] órdenes PayPal distintas:", tokens.length);
  // Adversarial: el navegador se quedó con la redirección de un clic «viejo» (orden PayPal ya cancelada en la app) y el
  // médico la aprueba; luego también aprueba la vigente. Nunca dos cobros retenidos ni dos cupos.
  const cancelled = pp.filter((p) => p.status === "CANCELLED").map((p) => p.paypalOrderId!);
  const live = pp.filter((p) => p.status === "PENDING").map((p) => p.paypalOrderId!);
  for (const tok of [cancelled[0], live[0]].filter(Boolean)) {
    const a = await (await request.post(`${PAYPAL}/__mock/approve/${tok}?json=1`)).json();
    const r = await request.get(a.redirect, { maxRedirects: 0 });
    console.log("[x3-critic C] aprobada", tok, "→", r.status(), r.headers()["location"]);
    await new Promise((res) => setTimeout(res, 1_500));
  }
  await runCron(request, "paypal,expire,enrollments");
  const after = payments(orders[0].id);
  console.log("[x3-critic C] pagos tras aprobar:", JSON.stringify(after.map((p) => [p.status, p.paypalOrderId, p.amountCents])));
  const st = await (await request.get(`${PAYPAL}/__mock/state`)).json();
  const captured = (st.orders as { id: string; purchase_units: { payments?: { captures?: { status: string }[] } }[] }[])
    .filter((o) => tokens.includes(o.id))
    .flatMap((o) => o.purchase_units[0]?.payments?.captures ?? [])
    .filter((c) => c.status === "COMPLETED");
  const refunded = q(`SELECT r.status FROM Refund r JOIN Payment p ON p.id = r.paymentId WHERE p.orderId = ?`, orders[0].id);
  console.log("[x3-critic C] capturas COMPLETED en PayPal:", captured.length, "reembolsos:", JSON.stringify(refunded));
  expect(captured.length - refunded.length, "cobros netos retenidos al médico").toBeLessThanOrEqual(1);
  expect(order(orders[0].id).status).toBe("ENROLLED");
  const c2 = cohort(C.cohortId);
  expect(c2.seatsConfirmed).toBe(1);
  expect(c2.seatsHeld + c2.seatsConfirmed).toBeLessThanOrEqual(3);
});

test("D. pago tardío tras vencer la reserva con la cohorte revendida + webhooks duplicados/desordenados: nunca más confirmados que el cupo", async ({ request, playwright }) => {
  // Cohorte nueva con 1 cupo. El comprador 1 abre PayPal y abandona: su reserva vence y el barrido la libera.
  const K = fixture<DiplomaCohort>("diploma-cohort", { capacity: 1, sede: "barquisimeto", name: `Cohorte tardía ${Date.now().toString(36)}` });
  const cq = { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: K.cohortId, plan: "FULL" };
  const buy = async (tag: string) => {
    const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
    expect((await addToCart(ctx, cq)).error).toBeNull();
    const email = uniqueEmail(tag);
    const out = await submitCheckout(ctx, await checkoutFormFields(ctx), { email, firstName: "Tardío", lastName: tag, method: "PAYPAL" });
    await ctx.dispose();
    const o = out.ok ? one<{ id: string }>(`SELECT o.id FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email) : null;
    return { out, email, orderId: o?.id ?? null };
  };
  const b1 = await buy("x3late1");
  expect(b1.out.ok).toBe(true);
  fixture("age-order", { orderId: b1.orderId, minutes: 40 });
  await runCron(request, "expire");
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 0 });

  // El comprador 2 toma el cupo y paga.
  const b2 = await buy("x3late2");
  expect(b2.out.ok).toBe(true);
  if (!b2.out.ok || !b1.out.ok) return;
  const a2 = await (await request.post(`${PAYPAL}/__mock/approve/${b2.out.paypalOrderId}?json=1`)).json();
  await request.get(a2.redirect, { maxRedirects: 0 });
  await waitForOrderStatus(b2.orderId!, "ENROLLED", 60_000);
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 1 });

  // El comprador 1 vuelve y aprueba en PayPal su orden vieja (retorno + webhook), y PayPal repite el webhook.
  const a1 = await (await request.post(`${PAYPAL}/__mock/approve/${b1.out.paypalOrderId}?json=1`)).json();
  const ret = await request.get(a1.redirect, { maxRedirects: 0 });
  console.log("[x3-critic D] retorno tardío →", ret.status(), ret.headers()["location"]);
  await new Promise((r) => setTimeout(r, 2_000));
  for (const p of payments(b1.orderId!).filter((x) => x.paypalCaptureId)) {
    await Promise.all([1, 2, 3].map(() => request.post(`${PAYPAL}/__mock/send-webhook/${p.paypalCaptureId}`)));
  }
  await Promise.all([1, 2, 3].map(async () => {
    const p2 = payments(b2.orderId!).find((x) => x.paypalCaptureId)!;
    await request.post(`${PAYPAL}/__mock/send-webhook/${p2.paypalCaptureId}`);
    await request.post(`${PAYPAL}/__mock/send-webhook/${p2.paypalCaptureId}?event_type=PAYMENT.CAPTURE.DENIED`);
  }));
  await runCron(request, "paypal,expire,enrollments");
  const c = cohort(K.cohortId);
  const live = q<{ status: string }>(`SELECT status FROM SeatReservation WHERE cohortId = ? AND status IN ('HELD','CONFIRMED')`, K.cohortId);
  console.log("[x3-critic D] cohort", JSON.stringify(c), "b1", order(b1.orderId!).status, JSON.stringify(payments(b1.orderId!)), "b2", order(b2.orderId!).status);
  expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(1);
  expect(live.length).toBeLessThanOrEqual(1);
  expect(order(b2.orderId!).status, "el DENIED desordenado tras COMPLETED no deshace el pago").toBe("ENROLLED");
  // El comprador 1 no puede quedar ENROLLED sin cupo; su dinero no queda cobrado sin atención.
  expect(order(b1.orderId!).status).not.toBe("ENROLLED");
  const b1Paid = payments(b1.orderId!).filter((p) => p.status === "COMPLETED");
  if (b1Paid.length) {
    const attn = q(`SELECT type, note FROM OrderEvent WHERE orderId = ? AND type IN ('ATTENTION','SEAT_UNAVAILABLE','REFUND')`, b1.orderId!);
    console.log("[x3-critic D] b1 capturado:", JSON.stringify(attn));
    expect(attn.length, "cobro sin cupo sin aviso ni reembolso").toBeGreaterThan(0);
  }

  // Webhook con el cuerpo alterado (monto cambiado, firma que ya no corresponde): rechazado, sin efectos.
  const p2 = payments(b2.orderId!).find((x) => x.paypalCaptureId)!;
  const eventsBefore = q(`SELECT id FROM OrderEvent WHERE orderId = ?`, b2.orderId!).length;
  const tampered = await (await request.post(`${PAYPAL}/__mock/send-webhook/${p2.paypalCaptureId}?tamper=body`)).json();
  console.log("[x3-critic D] webhook alterado →", tampered.status);
  expect(tampered.status).toBeGreaterThanOrEqual(400);
  expect(q(`SELECT id FROM OrderEvent WHERE orderId = ?`, b2.orderId!).length).toBe(eventsBefore);

  // Reembolso total desde PayPal a mitad de camino: el cupo confirmado se libera y la ficha vuelve a ofrecer la cohorte.
  const token = await paypalToken(request);
  const rr = await request.post(`${PAYPAL}/v2/payments/captures/${p2.paypalCaptureId}/refund`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, data: {} });
  expect(rr.status()).toBeLessThan(300);
  await waitForOrderStatus(b2.orderId!, "REFUNDED", 20_000);
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 0 });
  // Webhook de reembolso repetido: no libera de más (contadores nunca negativos) ni duplica el reembolso.
  const refundIds = q<{ providerRefundId: string }>(`SELECT r.providerRefundId FROM Refund r WHERE r.paymentId = ?`, p2.id);
  expect(refundIds).toHaveLength(1);
  await request.post(`${PAYPAL}/__mock/send-webhook/${p2.paypalCaptureId}?event_type=PAYMENT.CAPTURE.REFUNDED`);
  expect(q(`SELECT id FROM Refund WHERE paymentId = ?`, p2.id)).toHaveLength(1);
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 0, seatsConfirmed: 0 });
  const b3 = await buy("x3late3");
  expect(b3.out.ok, "el cupo liberado por el reembolso se puede volver a comprar").toBe(true);
  expect(cohort(K.cohortId)).toEqual({ capacity: 1, seatsHeld: 1, seatsConfirmed: 0 });
});

test("E. mismo correo desde DOS sesiones distintas (dos navegadores, sin cookie compartida), 8 envíos a la vez: un pedido y un cupo", async ({ playwright }) => {
  const E = fixture<DiplomaCohort>("diploma-cohort", { capacity: 3, sede: "barquisimeto", name: `Cohorte crítico E ${Date.now().toString(36)}` });
  const q2 = { product: DIPLOMA, modality: "SEMIPRESENCIAL", sede: "barquisimeto", cohort: E.cohortId, plan: "FULL" };
  const email = uniqueEmail("x3two");
  const sessions = await Promise.all([0, 1].map(async () => {
    const s = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
    expect((await addToCart(s, q2)).error).toBeNull();
    return { s, fields: await checkoutFormFields(s) };
  }));
  // El correo en mayúsculas en una de las sesiones: se normaliza y es el mismo médico.
  const outs = await Promise.all(
    Array.from({ length: 8 }, (_, i) => {
      const { s, fields } = sessions[i % 2];
      return submitCheckout(s, fields, { email: i % 2 ? email.toUpperCase() : email, firstName: "Dos", lastName: "Sesiones", method: "PAYPAL" });
    }),
  );
  await Promise.all(sessions.map(({ s }) => s.dispose()));
  console.log("[x3-critic E]", outs.map((o) => (o.ok ? "OK" : `✗ ${o.error}`)).join(" | "));
  const orders = q<{ id: string; status: string }>(`SELECT o.id, o.status FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email.toLowerCase());
  expect(outs.every((o) => o.ok), "ningún envío del mismo médico ve «Sin cupo» por sus propios envíos").toBe(true);
  expect(orders).toHaveLength(1);
  expect(q(`SELECT id FROM Customer WHERE email = ?`, email.toLowerCase())).toHaveLength(1);
  expect(cohort(E.cohortId)).toEqual({ capacity: 3, seatsHeld: 1, seatsConfirmed: 0 });
});
