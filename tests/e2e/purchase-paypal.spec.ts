// Pieza x1 — PayPal → webhook → Moodle → cupo → correos, de punta a punta y sin pasos humanos:
// un médico compra el diplomado SEMIPRESENCIAL en una cohorte de Barquisimeto (cupo N) y paga en la página
// de su pedido con PayPal (mock con el protocolo real: Orders v2 + webhooks firmados). Se prueba:
//   - retorno primero y webhook después (el caso normal), y el webhook ANTES del retorno
//     (CHECKOUT.ORDER.APPROVED → la app captura → PAYMENT.CAPTURE.COMPLETED, con el navegador aún en PayPal);
//   - el webhook repetido (reentrega exacta del mismo evento y reenvíos con otro event id);
//   - Moodle: usuario creado UNA vez y matriculado UNA vez en todos los cursos (FULL/HALF) o solo en el
//     siguiente curso por cuota (MONTHLY);
//   - cupo de la cohorte descontado exactamente en 1;
//   - EmailOutbox: confirmación de compra, acceso a la plataforma y datos de la cohorte.
//   - respuesta perdida de core_user_create_users: el reintento envía una contraseña temporal nueva.
// El pedido se crea con createCheckout (lo mismo que hace el checkout de la tienda) vía scripts/e2e-fixture.ts;
// todo lo demás ocurre por HTTP contra la app y los mocks.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";
import {
  MOODLE,
  PAYPAL,
  callsFor,
  captureIdOf,
  cohort,
  customerOf,
  emails,
  enrolCallsFor,
  enrollments,
  events,
  fixture,
  moodleCalls,
  moodleState,
  order,
  payments,
  paypalConfig,
  replayWebhook,
  resendCaptureWebhook,
  reservationOf,
  runCron,
  uniqueEmail,
  waitForOrderStatus,
  webhooksFor,
  type Checkout,
  type DiplomaCohort,
} from "./support/purchase";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const CAPACITY = 3;

function newPurchase(planKind: "FULL" | "HALF" | "MONTHLY", tag: string) {
  const c = fixture<DiplomaCohort>("diploma-cohort", { capacity: CAPACITY, sede: "barquisimeto" });
  expect(c.sedeName).toBe("Barquisimeto");
  expect(c.courses.length).toBeGreaterThan(1);
  const before = cohort(c.cohortId);
  expect(before).toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 0 });
  const email = uniqueEmail(tag);
  const o = fixture<Checkout>("checkout", { productId: c.productId, cohortId: c.cohortId, planKind, email, firstName: "María", lastName: `Pérez ${tag}` });
  // El checkout reserva el cupo (HELD) hasta que se confirme el pago.
  expect(cohort(c.cohortId)).toEqual({ capacity: CAPACITY, seatsHeld: 1, seatsConfirmed: 0 });
  expect(reservationOf(o.orderId).status).toBe("HELD");
  return { c, o, email };
}

/**
 * El comprador abre su pedido, pulsa «Pagar … con PayPal», aprueba en la página de PayPal (mock) y vuelve.
 * `beforeReturn`: se ejecuta con el navegador detenido entre la aprobación y el retorno a la app (la
 * aprobación ya ocurrió en PayPal, el return URL todavía no llegó).
 */
async function payInBrowser(page: Page, token: string, opts: { beforeReturn?: () => Promise<void>; expectHeading?: RegExp } = {}) {
  await page.goto(`/pedido/${token}`);
  if (opts.expectHeading) await expect(page.getByRole("heading", { name: opts.expectHeading })).toBeVisible();
  const pay = page.getByRole("button", { name: /con PayPal/ });
  await expect(pay).toBeVisible();
  await pay.click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const paypalOrderId = new URL(page.url()).searchParams.get("token")!;
  expect(paypalOrderId).toBeTruthy();
  if (opts.beforeReturn) {
    await page.route(`${PAYPAL}/__mock/approve/**`, async (route) => {
      // La aprobación llega a PayPal; el 302 al return URL se retiene hasta que termine `beforeReturn`.
      const res = await route.fetch({ maxRedirects: 0 });
      expect(res.status()).toBe(302);
      const location = res.headers()["location"];
      expect(location).toContain(`/pedido/${token}/paypal/retorno`);
      await opts.beforeReturn!();
      await route.fulfill({ status: 302, headers: { location } });
    });
  }
  await page.getByTestId("pp-approve").click();
  await page.waitForURL(/\/pedido\/[^/?]+\?paypal=/, { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("paypal")).toBe("completado");
  await expect(page.getByText("¡Pago recibido!")).toBeVisible();
  return paypalOrderId;
}

/** El webhook repetido: reenvío con otro event id (dos veces) y reentrega exacta del mismo evento. */
async function webhookTwice(request: APIRequestContext, captureId: string) {
  const first = await resendCaptureWebhook(request, captureId);
  expect(first.status).toBe(200);
  const second = await resendCaptureWebhook(request, captureId);
  expect(second.status).toBe(200);
  expect(second.event.id).not.toBe(first.event.id);
  const replay = await replayWebhook(request, first);
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({ ok: true, duplicate: true });
}

/** Moodle: el usuario del correo existe UNA vez, se creó con UNA llamada y cada curso se matriculó UNA vez. */
async function expectMoodleExactlyOnce(request: APIRequestContext, email: string, courseIds: number[]) {
  const st = await moodleState(request);
  const users = st.users.filter((u) => u.email.toLowerCase() === email.toLowerCase());
  expect(users, "un solo usuario Moodle por correo").toHaveLength(1);
  const user = users[0];
  const calls = await moodleCalls(request);
  const mine = callsFor(calls, user.id, email);
  expect(mine.filter((c) => c.wsfunction === "core_user_create_users"), "core_user_create_users una sola vez").toHaveLength(1);
  const enrolled = enrolCallsFor(calls, user.id);
  expect([...enrolled].sort((a, b) => a - b), "cada curso matriculado exactamente una vez").toEqual([...courseIds].sort((a, b) => a - b));
  const active = st.enrolments.filter((e) => e.userid === user.id && e.status === 0).map((e) => e.courseid);
  expect(active.sort((a, b) => a - b)).toEqual([...courseIds].sort((a, b) => a - b));
  expect(st.enrolments.filter((e) => e.userid === user.id).every((e) => e.roleid === Number(e2eEnv.MOODLE_STUDENT_ROLE_ID ?? 5))).toBe(true);
  // Cuenta nueva: contraseña temporal con cambio obligatorio en el primer acceso.
  expect(user.auth).toBe("manual");
  expect(user.password).toBeTruthy();
  expect(String(user.preferences?.auth_forcepasswordchange)).toBe("1");
  return user;
}

function expectSeatsTakenOnce(cohortId: string, orderId: string) {
  expect(cohort(cohortId), "cupo descontado exactamente en 1").toEqual({ capacity: CAPACITY, seatsHeld: 0, seatsConfirmed: 1 });
  expect(reservationOf(orderId).status).toBe("CONFIRMED");
}

/** Correos del primer pago PayPal: confirmación de compra, acceso a la plataforma y datos de la cohorte. */
function expectPurchaseEmails(o: Checkout, c: DiplomaCohort, email: string, username: string) {
  const mails = emails(o.orderId);
  expect(mails.map((m) => m.template).sort()).toEqual(["cohort_details", "order_confirmation", "platform_access"]);
  for (const m of mails) {
    expect(m.status).toBe("SENT");
    expect(m.to.toLowerCase()).toBe(email.toLowerCase());
  }
  const confirmation = mails.find((m) => m.template === "order_confirmation")!;
  expect(confirmation.dedupeKey).toBe(`order_paid:${o.orderId}`);
  expect(confirmation.text).toContain(String(o.number));
  expect(confirmation.text).toContain(c.productTitle);

  const access = mails.find((m) => m.template === "platform_access")!;
  expect(access.dedupeKey).toBe(`platform_access:${o.orderId}`);
  expect(access.text).toContain(username);
  expect(access.text).toContain(e2eEnv.MOODLE_LOGIN_URL ?? `${MOODLE}/login/index.php`);
  // Cuenta nueva → lleva contraseña temporal (se entrega en el envío; la bandeja guarda solo la referencia).
  expect(JSON.parse(access.secretRef!)).toMatchObject({ kind: "moodle_temp_password" });
  expect(access.text).toContain("Contraseña temporal");

  const details = mails.find((m) => m.template === "cohort_details")!;
  expect(details.text).toContain(c.cohortName);
  expect(details.text).toContain("Barquisimeto");
  expect(details.text).toContain(c.courses[0].title);
}

test.beforeEach(async ({ request }) => {
  // Configuración conocida del mock de PayPal: webhooks automáticos tras capturar, SIN el de aprobación.
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
});
test.afterAll(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});

test("pago total (FULL): retorno de PayPal y luego el webhook (y otra vez): matrícula en TODOS los cursos una sola vez", async ({ page, request }) => {
  const { c, o, email } = newPurchase("FULL", "full");
  const paypalOrderId = await payInBrowser(page, o.token, { expectHeading: /Completa tu pago/ });

  // El webhook PAYMENT.CAPTURE.COMPLETED llega (después del retorno) y la app lo acepta.
  const captureId = await captureIdOf(request, paypalOrderId);
  await expect.poll(async () => (await webhooksFor(request, [captureId])).filter((w) => w.eventType === "PAYMENT.CAPTURE.COMPLETED" && w.status === 200).length, { timeout: 30_000 }).toBe(1);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  await webhookTwice(request, captureId);

  const ord = order(o.orderId);
  expect(ord).toMatchObject({ status: "ENROLLED", amountPaidCents: o.totalCents, balanceCents: 0 });
  const pays = payments(o.orderId);
  expect(pays).toHaveLength(1);
  expect(pays[0]).toMatchObject({ status: "COMPLETED", paypalOrderId, paypalCaptureId: captureId, amountCents: o.dueNowCents });
  expect(events(o.orderId, "PAYMENT_RECEIVED")).toHaveLength(1);
  expect(events(o.orderId, "PAYMENT_CAPTURED")).toHaveLength(1);

  const allCourses = c.courses.map((x) => x.moodleCourseId);
  const user = await expectMoodleExactlyOnce(request, email, allCourses);
  const cust = customerOf(o.orderId);
  expect(cust.moodleUserId).toBe(user.id);
  expect(enrollments(o.orderId).map((e) => [e.moodleCourseId, e.status])).toEqual([...allCourses].sort((a, b) => a - b).map((id) => [id, "ENROLLED"]));
  expectSeatsTakenOnce(c.cohortId, o.orderId);
  expectPurchaseEmails(o, c, email, cust.moodleUsername!);

  // La página del pedido refleja el pago completo.
  await page.goto(`/pedido/${o.token}`);
  await expect(page.getByRole("button", { name: /con PayPal/ })).toHaveCount(0);
});

test("webhook ANTES del retorno (y dos veces): la app captura desde CHECKOUT.ORDER.APPROVED; el retorno no duplica nada", async ({ page, request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: true, webhookDelayMs: 0 });
  const { c, o, email } = newPurchase("FULL", "early");

  let checkedBeforeReturn = false;
  const paypalOrderId = await payInBrowser(page, o.token, {
    beforeReturn: async () => {
      // El navegador sigue en PayPal: el pago lo completaron SOLO los webhooks.
      await waitForOrderStatus(o.orderId, "ENROLLED", 60_000);
      const pays = payments(o.orderId);
      expect(pays).toHaveLength(1);
      expect(pays[0].status).toBe("COMPLETED");
      const captured = events(o.orderId, "PAYMENT_CAPTURED");
      expect(captured).toHaveLength(1);
      expect(captured[0].actorType).toBe("WEBHOOK");
      // PayPal ya entregó ambos eventos a la app: la aprobación y la captura completada.
      await expect
        .poll(async () => (await webhooksFor(request, [pays[0].paypalOrderId!, pays[0].paypalCaptureId!])).filter((w) => w.status === 200).map((w) => w.eventType).sort(), { timeout: 30_000 })
        .toEqual(["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED"]);
      // …y otra vez, mientras el comprador aún no vuelve.
      await webhookTwice(request, pays[0].paypalCaptureId!);
      checkedBeforeReturn = true;
    },
  });
  expect(checkedBeforeReturn).toBe(true);

  // El retorno llegó después: la orden PayPal tiene UNA sola captura y el pedido no cambió.
  const captureId = await captureIdOf(request, paypalOrderId);
  const pays = payments(o.orderId);
  expect(pays).toHaveLength(1);
  expect(pays[0]).toMatchObject({ status: "COMPLETED", paypalCaptureId: captureId });
  expect(events(o.orderId, "PAYMENT_RECEIVED")).toHaveLength(1);
  expect(events(o.orderId, "ENROLLMENT")).toHaveLength(1);
  expect(order(o.orderId)).toMatchObject({ status: "ENROLLED", balanceCents: 0 });
  await webhookTwice(request, captureId);

  const user = await expectMoodleExactlyOnce(request, email, c.courses.map((x) => x.moodleCourseId));
  expect(customerOf(o.orderId).moodleUserId).toBe(user.id);
  expectSeatsTakenOnce(c.cohortId, o.orderId);
  expectPurchaseEmails(o, c, email, customerOf(o.orderId).moodleUsername!);
});

test("pago de la mitad (HALF): el primer pago matricula TODOS los cursos; queda saldo", async ({ page, request }) => {
  const { c, o, email } = newPurchase("HALF", "half");
  expect(o.dueNowCents).toBeLessThan(o.totalCents);
  const paypalOrderId = await payInBrowser(page, o.token);
  const captureId = await captureIdOf(request, paypalOrderId);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  await expect.poll(async () => (await webhooksFor(request, [captureId])).filter((w) => w.status === 200).length, { timeout: 30_000 }).toBe(1);
  await webhookTwice(request, captureId);

  expect(order(o.orderId)).toMatchObject({ status: "ENROLLED", amountPaidCents: o.dueNowCents, balanceCents: o.totalCents - o.dueNowCents });
  await expectMoodleExactlyOnce(request, email, c.courses.map((x) => x.moodleCourseId));
  expectSeatsTakenOnce(c.cohortId, o.orderId);
  expectPurchaseEmails(o, c, email, customerOf(o.orderId).moodleUsername!);
});

test("mes a mes (MONTHLY): cada cuota matricula SOLO el siguiente curso; el cupo se ocupa una vez", async ({ page, request }) => {
  const { c, o, email } = newPurchase("MONTHLY", "monthly");
  expect(o.installments).toHaveLength(c.courses.length);
  expect(o.installments.map((i) => i.moodleCourseId)).toEqual(c.courses.map((x) => x.moodleCourseId));
  const [first, second, third] = c.courses.map((x) => x.moodleCourseId);

  // Cuota 1 → solo el curso 1.
  const pp1 = await payInBrowser(page, o.token, { expectHeading: /Completa tu pago/ });
  const cap1 = await captureIdOf(request, pp1);
  await waitForOrderStatus(o.orderId, "ENROLLED");
  await expect.poll(async () => (await webhooksFor(request, [cap1])).filter((w) => w.status === 200).length, { timeout: 30_000 }).toBe(1);
  await webhookTwice(request, cap1);
  await expectMoodleExactlyOnce(request, email, [first]);
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: o.installments[0].amountCents, balanceCents: o.totalCents - o.installments[0].amountCents });
  expectSeatsTakenOnce(c.cohortId, o.orderId);
  expectPurchaseEmails(o, c, email, customerOf(o.orderId).moodleUsername!);

  // Cuota 2 (desde la página del pedido) → se agrega SOLO el curso 2; el cupo no se vuelve a tomar.
  const pp2 = await payInBrowser(page, o.token, { expectHeading: new RegExp(`Pagar la cuota 2 · ${c.courses[1].title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  const cap2 = await captureIdOf(request, pp2);
  await expect.poll(() => enrollments(o.orderId).filter((e) => e.status === "ENROLLED").length, { timeout: 30_000 }).toBe(2);
  await expect.poll(async () => (await webhooksFor(request, [cap2])).filter((w) => w.status === 200).length, { timeout: 30_000 }).toBe(1);
  await webhookTwice(request, cap2);
  await expectMoodleExactlyOnce(request, email, [first, second]);
  expect((await moodleState(request)).enrolments.some((e) => e.courseid === third && e.userid === customerOf(o.orderId).moodleUserId)).toBe(false);
  const paid = o.installments[0].amountCents + o.installments[1].amountCents;
  expect(order(o.orderId)).toMatchObject({ status: "ENROLLED", amountPaidCents: paid, balanceCents: o.totalCents - paid });
  const ins2 = payments(o.orderId).find((p) => p.paypalOrderId === pp2)!;
  expect(ins2.installmentId).toBe(o.installments[1].id);
  expectSeatsTakenOnce(c.cohortId, o.orderId);

  const mails = emails(o.orderId);
  expect(mails.filter((m) => m.template === "cohort_details")).toHaveLength(1);
  expect(mails.filter((m) => m.template === "order_confirmation")).toHaveLength(1);
  const access = mails.filter((m) => m.template === "platform_access");
  expect(access.map((m) => m.dedupeKey)).toEqual([`platform_access:${o.orderId}`, `course_access:${o.orderId}:${second}`]);
  expect(access[1].secretRef).toBeNull(); // la cuenta ya existía: sin contraseña nueva
  expect(access[1].text).toContain(c.courses[1].title);
  expect(access[1].text).not.toContain(c.courses[2].title);
  expect(mails.filter((m) => m.template === "payment_approved")).toHaveLength(1);
});

test("Moodle crea la cuenta pero la respuesta se pierde: el reintento envía una contraseña temporal nueva", async ({ page, request }) => {
  const before = fixture<{ before: unknown }>("setting", { key: "enrollment.retry", value: { maxAttempts: 8, baseDelaySeconds: 5 } }).before;
  try {
    const { c, o, email } = newPurchase("FULL", "lost");
    // core_user_create_users se EJECUTA en Moodle y la app recibe un 503 (respuesta perdida).
    const f = await request.post(`${MOODLE}/__mock/fail-next`, { data: { wsfunction: "core_user_create_users", type: "http", status: 503, after: true } });
    expect(f.ok()).toBe(true);
    await payInBrowser(page, o.token);
    await waitForOrderStatus(o.orderId, "PAID");
    await expect.poll(() => events(o.orderId, "MOODLE_USER_CREATE_UNCONFIRMED").length, { timeout: 30_000 }).toBe(1);
    const st = await moodleState(request);
    const user = st.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    expect(user, "la cuenta quedó creada en Moodle").toBeTruthy();
    expect(customerOf(o.orderId).moodleUserId).toBeNull();
    expect(emails(o.orderId).filter((m) => m.template === "platform_access")).toHaveLength(0);
    const pwdAtCreation = user!.password;

    // El job de reintentos (por HTTP, como el cron) matricula y envía el acceso CON contraseña nueva.
    await expect
      .poll(async () => {
        await runCron(request, "enrollments");
        return order(o.orderId).status;
      }, { timeout: 60_000, intervals: [2_000] })
      .toBe("ENROLLED");
    const after = await moodleState(request);
    const u = after.users.filter((x) => x.email.toLowerCase() === email.toLowerCase());
    expect(u).toHaveLength(1);
    expect(u[0].password).not.toBe(pwdAtCreation); // core_user_update_users fijó una temporal nueva
    expect(String(u[0].preferences?.auth_forcepasswordchange)).toBe("1");
    const calls = callsFor(await moodleCalls(request), u[0].id, email);
    expect(calls.filter((x) => x.wsfunction === "core_user_create_users")).toHaveLength(1);
    expect(calls.filter((x) => x.wsfunction === "core_user_update_users")).toHaveLength(1);
    expect(customerOf(o.orderId).moodleUserId).toBe(u[0].id);
    expect([...enrolCallsFor(await moodleCalls(request), u[0].id)].sort((a, b) => a - b)).toEqual(c.courses.map((x) => x.moodleCourseId).sort((a, b) => a - b));

    const access = emails(o.orderId).filter((m) => m.template === "platform_access");
    expect(access).toHaveLength(1);
    expect(access[0].status).toBe("SENT");
    expect(JSON.parse(access[0].secretRef!)).toMatchObject({ kind: "moodle_temp_password", moodleUserId: u[0].id });
    expect(access[0].text).toContain("Contraseña temporal");
    const ev = events(o.orderId, "MOODLE_USER");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].data!)).toMatchObject({ created: false, credentialsReset: true });
    expectSeatsTakenOnce(c.cohortId, o.orderId);
  } finally {
    if (before) fixture("setting", { key: "enrollment.retry", value: before });
  }
});
