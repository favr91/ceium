// x2 crítico 22: la desmatrícula de un pedido reembolsado va lenta en Moodle y, MIENTRAS está en curso, el médico
// vuelve a comprar el mismo curso y el admin aprueba. La recompra toma la fila de matrícula (pedido cerrado) y
// matricula en Moodle; después Moodle ejecuta la desmatrícula del reembolso. Antes: unenrollOrder marcaba la fila
// UNENROLLED sin mirar de quién era (pisaba la matrícula del pedido nuevo) y Moodle quedaba sin el curso: el médico
// pagó, recibió «ya tienes acceso» y no tenía aula.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminRecordManualPayment, adminVerifyPayment, refundPayment } from "@/server/payments";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-22");
});
afterEach(async () => {
  await ctx.dispose();
});

const MOODLE_COURSE = 201;

async function paidOrder(email: string, ref: string) {
  const o = await createCheckout(ctx.d, { customer: { ...buyer(), email }, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const pm = await adminRecordManualPayment(ctx.d, ctx.fx.admin, { orderId: o.id, method: "PAGO_MOVIL", reference: ref, bank: "Banesco", amountCents: o.dueNowCents * 100, currency: "VES", exchangeRate: 100 });
  await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
  return { order: o, paymentId: pm.id };
}

/** La próxima desmatrícula espera a `release()` y SOLO entonces se ejecuta en Moodle (lenta; `lose`: sin respuesta). */
function slowUnenrol(lose = false) {
  const real = ctx.moodle.unenrol.bind(ctx.moodle);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inFlight = new Promise<void>((r) => (started = r));
  let armed = true;
  ctx.moodle.unenrol = async (userId, courseIds) => {
    if (armed) {
      armed = false;
      started();
      await gate;
      await real(userId, courseIds);
      if (lose) throw new Error("Moodle enrol_manual_unenrol_users: sin respuesta en 15000 ms");
      return;
    }
    return real(userId, courseIds);
  };
  return { release, inFlight };
}

describe("desmatrícula lenta de un reembolso y recompra aprobada mientras está en curso", () => {
  it("la recompra conserva su matrícula en Moodle y en la app", async () => {
    const email = "medico.carrera@example.com";
    const a = await paidOrder(email, "01345555");
    const uid = (await ctx.db.customer.findFirstOrThrow({ where: { email } })).moodleUserId!;

    const slow = slowUnenrol();
    const refund = refundPayment(ctx.d, ctx.fx.admin, { paymentId: a.paymentId, reason: "Cambio de cohorte", unenroll: true, releaseSeat: true, idempotencyKey: "x2c22-a" });
    await slow.inFlight;
    const b = await paidOrder(email, "01346666");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe("ENROLLED");
    slow.release();
    await refund;

    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe("REFUNDED");
    const row = await ctx.db.enrollment.findFirstOrThrow({ where: { moodleCourseId: MOODLE_COURSE, customer: { email } } });
    expect(row).toMatchObject({ status: "ENROLLED", orderId: b.order.id });
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])], "B pagó y se le dijo «ya tienes acceso»").toEqual([MOODLE_COURSE]);
    expect((await ctx.db.orderEvent.findMany({ where: { orderId: b.order.id, type: "ENROLLMENT" } })).some((e) => /reafirmada/.test(e.note ?? ""))).toBe(true);

    // Los jobs no cambian nada después.
    await runJobs(ctx.d, ["enrollments"]);
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([MOODLE_COURSE]);
    expect((await ctx.db.enrollment.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("ENROLLED");
  });

  it("si además la respuesta de la desmatrícula se pierde, la recompra sigue matriculada (en línea y tras el job)", async () => {
    const email = "medico.carrera.perdida@example.com";
    const a = await paidOrder(email, "01347777");
    const uid = (await ctx.db.customer.findFirstOrThrow({ where: { email } })).moodleUserId!;

    const slow = slowUnenrol(true);
    const refund = refundPayment(ctx.d, ctx.fx.admin, { paymentId: a.paymentId, reason: "Cambio de cohorte", unenroll: true, releaseSeat: true, idempotencyKey: "x2c22-b" });
    await slow.inFlight;
    const b = await paidOrder(email, "01348888");
    slow.release();
    await refund;
    expect(await ctx.db.orderEvent.count({ where: { orderId: a.order.id, type: "UNENROLLMENT_FAILED" } })).toBe(1);
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([MOODLE_COURSE]);

    // Moodle vuelve a perder la matrícula (p.ej. la desmatrícula sin respuesta se ejecuta tarde): el job del
    // reembolso conserva el curso del pedido vigente y lo reafirma en Moodle.
    ctx.moodle.enrolments.get(uid)?.delete(MOODLE_COURSE);
    await runJobs(ctx.d, ["enrollments"]);
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([MOODLE_COURSE]);
    expect(await ctx.db.enrollment.findFirstOrThrow({ where: { moodleCourseId: MOODLE_COURSE, customer: { email } } })).toMatchObject({ status: "ENROLLED", orderId: b.order.id });
  });

  it("sin recompra, la desmatrícula del reembolso sigue funcionando igual", async () => {
    const email = "medico.sin.recompra@example.com";
    const a = await paidOrder(email, "01349999");
    const uid = (await ctx.db.customer.findFirstOrThrow({ where: { email } })).moodleUserId!;
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: a.paymentId, reason: "Desistió", unenroll: true, releaseSeat: true, idempotencyKey: "x2c22-c" });
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([]);
    expect((await ctx.db.enrollment.findFirstOrThrow({ where: { moodleCourseId: MOODLE_COURSE, customer: { email } } })).status).toBe("UNENROLLED");
  });
});
