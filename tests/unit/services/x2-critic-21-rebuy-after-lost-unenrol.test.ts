// x2 crítico 21: reembolso con «Desmatricular» cuya respuesta de Moodle se pierde (Moodle SÍ desmatriculó; la fila
// sigue ENROLLED y queda un UNENROLLMENT_FAILED para el job). Si el médico compra de nuevo el MISMO curso y se aprueba
// antes de que corra el job, la matrícula nueva no puede fiarse de esa fila: antes el pedido nuevo pasaba a
// «Inscrito» y se enviaba «ya tienes acceso» sin llamar a Moodle, y el médico se quedaba sin aula para siempre.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminRecordManualPayment, adminVerifyPayment, refundPayment } from "@/server/payments";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-21");
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

describe("recompra del mismo curso tras una desmatrícula con la respuesta perdida", () => {
  it("el pedido nuevo matricula de verdad en Moodle y el job del reembolsado no se lo quita", async () => {
    const email = "medico.recompra@example.com";
    const a = await paidOrder(email, "01341111");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe("ENROLLED");
    const uid = (await ctx.db.customer.findFirstOrThrow({ where: { email } })).moodleUserId!;
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([MOODLE_COURSE]);

    // Moodle ejecuta la desmatrícula y la respuesta se pierde.
    const realUnenrol = ctx.moodle.unenrol.bind(ctx.moodle);
    let lose = 1;
    ctx.moodle.unenrol = async (userId, courseIds) => {
      await realUnenrol(userId, courseIds);
      if (lose-- > 0) throw new Error("Moodle enrol_manual_unenrol_users: respuesta no JSON");
    };
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: a.paymentId, reason: "Cambio de cohorte", unenroll: true, releaseSeat: true, idempotencyKey: "x2c21-a" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe("REFUNDED");
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([]);
    expect((await ctx.db.enrollment.findFirstOrThrow({ where: { moodleCourseId: MOODLE_COURSE, customer: { email } } })).status).toBe("ENROLLED");

    // Compra de nuevo el curso; se aprueba antes de que corra el job.
    const b = await paidOrder(email, "01342222");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: b.order.id } })).status).toBe("ENROLLED");
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([MOODLE_COURSE]);
    const row = await ctx.db.enrollment.findFirstOrThrow({ where: { moodleCourseId: MOODLE_COURSE, customer: { email } } });
    expect(row).toMatchObject({ status: "ENROLLED", orderId: b.order.id });
    expect(await ctx.db.emailOutbox.count({ where: { orderId: b.order.id, template: "platform_access" } })).toBe(1);

    // El job de desmatrículas del pedido reembolsado conserva el curso que paga el pedido nuevo.
    await runJobs(ctx.d, ["enrollments"]);
    await runJobs(ctx.d, ["enrollments"]);
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([MOODLE_COURSE]);
    expect((await ctx.db.enrollment.findFirstOrThrow({ where: { id: row.id } })).status).toBe("ENROLLED");
  });

  it("un curso que el médico conserva por OTRO pedido vigente no se vuelve a matricular", async () => {
    const email = "medico.dos.pedidos@example.com";
    const a = await paidOrder(email, "01343333");
    const calls = ctx.moodle.calls.filter((c) => c.fn === "enrol").length;
    await paidOrder(email, "01344444");
    // La fila ENROLLED pertenece a un pedido vigente: no hace falta llamar a Moodle.
    expect(ctx.moodle.calls.filter((c) => c.fn === "enrol").length).toBe(calls);
    expect((await ctx.db.enrollment.findFirstOrThrow({ where: { moodleCourseId: MOODLE_COURSE, customer: { email } } })).orderId).toBe(a.order.id);
  });
});
