// Pieza x2 — ronda 17. Brecha del crítico 16: un reembolso PayPal pedido desde el panel cuya llamada se queda sin
// respuesta (timeout) quedaba Refund PENDING para siempre si además se perdía el webhook PAYMENT.CAPTURE.REFUNDED:
// el pedido seguía ENROLLED, el cupo ocupado y Moodle con acceso, aunque PayPal ya hubiera devuelto el dinero.
// Ahora el job "paypal" (POST /api/cron) retoma la fila con el MISMO PayPal-Request-Id:
//   1. PayPal SÍ reembolsó (respuesta y webhook perdidos) → se aplica UNA vez (el mock no registra otro reembolso)
//      con las opciones del admin: REFUNDED, cupo liberado, desmatriculado, correo de reembolso, auditoría.
//   2. PayPal NO llegó a reembolsar → el job lo hace ahora, una sola vez, y aplica lo mismo.
// El «timeout» lo produce el fixture (mismo servicio del panel con el puerto PayPal real envuelto): el mock de
// PayPal no simula respuestas perdidas.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-17.spec.ts --project=desktop
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, events, fixture, one, order, paypalConfig, q, reservationOf, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const COURSE = "curso-universitario-ecografia-de-abdomen";
interface CourseCohort { productId: string; moodleCourseId: number; cohortId: string; capacity: number }
interface Placed { orderId: string; token: string; number: number; dueNowCents: number; totalCents: number }
const newCohort = () => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity: 3, name: `Cohorte x2c17 ${Date.now().toString(36)}` });

const refundRow = (id: string) => one<{ status: string; providerRefundId: string | null; amountCents: number }>(`SELECT status, providerRefundId, amountCents FROM Refund WHERE id = ?`, id);
const paypalPayment = (orderId: string) =>
  one<{ id: string; status: string; paypalCaptureId: string; amountUsdCents: number; refundedCents: number }>(
    `SELECT id, status, paypalCaptureId, amountUsdCents, refundedCents FROM Payment WHERE orderId = ? AND method = 'PAYPAL' AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')`,
    orderId,
  );
async function mockRefundsFor(request: APIRequestContext, captureId: string) {
  const st = (await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { refunds?: unknown };
  const all = Array.isArray(st.refunds) ? st.refunds : Object.values((st.refunds ?? {}) as Record<string, unknown>);
  return all.filter((r) => JSON.stringify(r).includes(captureId)) as { id: string }[];
}
async function moodleCourses(request: APIRequestContext, uid: number | null) {
  if (uid == null) return [];
  const st = (await (await request.get(`${MOODLE}/__mock/state`)).json()) as { enrolments: { userid: number; courseid: number }[] };
  return st.enrolments.filter((e) => e.userid === uid).map((e) => e.courseid);
}

test.afterEach(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: true });
});

for (const paypalDid of [true, false]) {
  test(`reembolso PayPal sin respuesta y sin webhook (PayPal ${paypalDid ? "SÍ" : "NO"} lo hizo) → el job lo concilia una sola vez: REFUNDED, cupo libre, sin Moodle, correo y auditoría`, async ({ page, request }) => {
    const C = newCohort();
    const email = uniqueEmail(`x2c17${paypalDid ? "si" : "no"}`);
    const o = fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod: "PAYPAL" });

    // El médico paga con PayPal desde la página de su pedido.
    await page.goto(`/pedido/${o.token}`);
    await page.getByRole("button", { name: /con PayPal/ }).click();
    await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
    await page.getByTestId("pp-approve").click();
    await page.waitForURL((u) => u.pathname.startsWith("/pedido/") && !u.pathname.includes("/paypal/"), { timeout: 60_000 });
    await waitForOrderStatus(o.orderId, "ENROLLED", 45_000);
    const uid = customerOf(o.orderId).moodleUserId;
    expect(await moodleCourses(request, uid)).toContain(C.moodleCourseId);
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");
    const pay = paypalPayment(o.orderId);

    // El admin reembolsa; PayPal no responde y su webhook REFUNDED se pierde.
    await paypalConfig(request, { autoWebhooks: false, approvalWebhooks: false });
    const lost = fixture<{ refundId: string; status: string; error: string }>("refund-lost-response", { paymentId: pay.id, paypalDid, reason: "Retiro del curso (x2c17)", unenroll: true, releaseSeat: true, ageMinutes: 10 });
    expect(lost.status).toBe("PENDING");
    expect(lost.error).toMatch(/PayPal no respondió/);
    expect(await mockRefundsFor(request, pay.paypalCaptureId)).toHaveLength(paypalDid ? 1 : 0);
    // Sin conciliación el pedido quedaría así para siempre: pagado, matriculado y con el cupo ocupado.
    expect(order(o.orderId).status).toBe("ENROLLED");
    expect(reservationOf(o.orderId).status).toBe("CONFIRMED");

    // Cron "paypal".
    const out = (await runCron(request, "paypal")) as { results?: { paypal?: { refunds?: Record<string, number> } }; paypal?: { refunds?: Record<string, number> } };
    const refunds = (out.results ?? out).paypal?.refunds;
    expect(refunds, JSON.stringify(out)).toMatchObject({ completed: expect.any(Number) });
    expect(refunds!.completed).toBeGreaterThanOrEqual(1);

    // Un único reembolso en PayPal (mismo PayPal-Request-Id), aplicado una vez en la BD.
    const inPaypal = await mockRefundsFor(request, pay.paypalCaptureId);
    expect(inPaypal).toHaveLength(1);
    const row = refundRow(lost.refundId);
    expect(row).toMatchObject({ status: "COMPLETED", providerRefundId: inPaypal[0].id, amountCents: pay.amountUsdCents });
    expect(q(`SELECT id FROM Refund WHERE paymentId = ?`, pay.id)).toHaveLength(1);
    expect(paypalPayment(o.orderId)).toMatchObject({ status: "REFUNDED", refundedCents: pay.amountUsdCents });

    // Opciones del admin: pedido reembolsado, cupo liberado, sin acceso a Moodle.
    await waitForOrderStatus(o.orderId, "REFUNDED");
    expect(reservationOf(o.orderId).status).toBe("RELEASED");
    const c = cohort(C.cohortId);
    expect(c.seatsConfirmed + c.seatsHeld).toBe(0);
    await expect.poll(() => moodleCourses(request, uid), { timeout: 30_000 }).not.toContain(C.moodleCourseId);

    // Correo al médico y auditoría completa.
    expect(emails(o.orderId).filter((m) => m.template === "refund_issued")).toHaveLength(1);
    const types = events(o.orderId).map((e) => e.type);
    for (const t of ["REFUND_REQUESTED", "REFUND", "SEAT_RELEASED"]) expect(types, t).toContain(t);

    // Segunda pasada: nada que hacer, ningún reembolso más ni correo repetido.
    await runCron(request, "paypal");
    expect(await mockRefundsFor(request, pay.paypalCaptureId)).toHaveLength(1);
    expect(emails(o.orderId).filter((m) => m.template === "refund_issued")).toHaveLength(1);
  });
}
