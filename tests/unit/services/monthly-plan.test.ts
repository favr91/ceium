// Plan mes a mes de diplomados (SPEC, confirmado por el cliente): una cuota por curso, cada cuota
// confirmada matricula SOLO el siguiente curso, recordatorio con enlace directo de pago, certificado solo
// con los 9 cursos completos y el saldo en 0.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY } from "@/server/deps";
import { createCheckout, getOrder } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, refundPayment, startPaypalPayment } from "@/server/payments";
import { runInstallmentReminders } from "@/server/installments";
import { runJobs } from "@/server/jobs";
import { checkDiplomaCompletion } from "@/server/certificates";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("monthly");
});
afterEach(async () => {
  await ctx.dispose();
});

async function monthlyOrder() {
  return createCheckout(ctx.d, {
    customer: buyer(),
    items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind: "MONTHLY" }],
    paymentMethod: "PAYPAL",
  });
}

async function payPaypal(orderId: string, installmentId?: string) {
  const s = await startPaypalPayment(ctx.d, orderId, installmentId ? { installmentId } : undefined);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  return s;
}

const enrolledIds = async (orderCustomerId: string) =>
  (await ctx.db.enrollment.findMany({ where: { customerId: orderCustomerId, status: "ENROLLED" } })).map((e) => e.moodleCourseId).sort();

describe("diplomado mes a mes", () => {
  it("9 cuotas de $180 (una por curso, en orden) y el primer pago matricula SOLO el curso 1", async () => {
    const o = await monthlyOrder();
    expect([o.totalCents, o.dueNowCents, o.balanceCents]).toEqual([9 * 18000, 18000, 9 * 18000]);
    expect(o.installments.map((i) => i.amountCents)).toEqual(Array(9).fill(18000));
    expect(o.installments.map((i) => i.moodleCourseId)).toEqual(ctx.fx.diplomaMoodleIds);
    expect(o.installments.map((i) => i.course?.id)).toEqual(ctx.fx.diplomaCourses);

    await payPaypal(o.id);
    const after = await getOrder(ctx.d, o.id);
    expect(after.status).toBe("ENROLLED");
    expect([after.amountPaidCents, after.balanceCents]).toEqual([18000, 8 * 18000]);
    expect(after.installments.map((i) => i.status)).toEqual(["PAID", ...Array(8).fill("PENDING")]);
    expect(await enrolledIds(o.customerId)).toEqual([301]);
    expect(ctx.moodle.calls.filter((c) => c.fn === "enrol").map((c) => c.args[1])).toEqual([[301]]);
    // El cupo de la cohorte se ocupa con la primera cuota.
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.diplomaCohort } });
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([0, 1]);
    const access = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "platform_access" } });
    expect(access.text).toContain("Curso 1 del Diplomado");
    expect(access.text).not.toContain("Curso 2 del Diplomado");
  });

  it("cuota N+1 pagada → se matricula el curso N+1 (y solo ese) con aviso por correo; no se puede saltar cuotas", async () => {
    const o = await monthlyOrder();
    await payPaypal(o.id);
    const ins = (await getOrder(ctx.d, o.id)).installments;
    await expect(startPaypalPayment(ctx.d, o.id, { installmentId: ins[3].id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(startPaypalPayment(ctx.d, o.id, { installmentId: ins[0].id })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const s = await payPaypal(o.id, ins[1].id);
    expect(s.amountCents).toBe(18000);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).installmentId).toBe(ins[1].id);
    expect(await enrolledIds(o.customerId)).toEqual([301, 302]);
    expect(ctx.moodle.calls.filter((c) => c.fn === "enrol").map((c) => c.args[1])).toEqual([[301], [302]]);
    const mails = await ctx.db.emailOutbox.findMany({ where: { orderId: o.id, template: "platform_access" }, orderBy: { createdAt: "asc" } });
    expect(mails).toHaveLength(2);
    expect(mails[1].dedupeKey).toBe(`course_access:${o.id}:302`);
    expect(mails[1].text).toContain("Curso 2 del Diplomado");
    expect(mails[1].text).not.toContain("Curso 3 del Diplomado");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ENROLLED");
  });

  it("recordatorio de la siguiente cuota con enlace directo de pago; vencida → OVERDUE; pago manual verificado matricula el curso", async () => {
    const o = await monthlyOrder();
    await payPaypal(o.id);
    const ins = (await getOrder(ctx.d, o.id)).installments;

    // Faltan más de 3 días para el vencimiento de la cuota 2 (2026-10-01): nada.
    expect(await runInstallmentReminders(ctx.d)).toEqual({ overdue: 0, reminded: 0 });
    ctx.clock.t = new Date(ins[1].dueDate!.getTime() - 2 * DAY);
    expect(await runInstallmentReminders(ctx.d)).toEqual({ overdue: 0, reminded: 1 });
    expect(await runInstallmentReminders(ctx.d)).toEqual({ overdue: 0, reminded: 0 }); // idempotente
    const r = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "installment_reminder" } });
    expect(r.subject).toBe("Paga tu próximo curso: Curso 2 del Diplomado");
    expect(r.text).toContain("Cuota: 2 de 9");
    expect(r.text).toContain("$180.00");
    expect(r.html).toContain(`https://ceium.test/pedido/${o.token}/cuota/${ins[1].id}/paypal`);
    expect(r.html).toContain(`https://ceium.test/pedido/${o.token}?cuota=${ins[1].id}#pagar`);

    // Vence sin pagar → OVERDUE (evento) y recordatorio de cuota vencida.
    ctx.clock.t = new Date(ins[1].dueDate!.getTime() + 8 * DAY);
    const out = await runJobs(ctx.d, ["installments"]);
    expect(out.installments).toEqual({ overdue: 1, reminded: 1 });
    expect((await ctx.db.installment.findUniqueOrThrow({ where: { id: ins[1].id } })).status).toBe("OVERDUE");
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "INSTALLMENT_OVERDUE" } })).toBe(1);
    const overdue = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "installment_reminder", dedupeKey: { endsWith: ":overdue-1" } } });
    expect(overdue.subject).toContain("Cuota vencida");

    // Pago móvil de la cuota 2 → verificación → curso 2.
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "556677", amountCents: 1_800_000, currency: "VES", exchangeRate: 100 });
    expect(await enrolledIds(o.customerId)).toEqual([301]); // aún sin verificar
    await adminVerifyPayment(ctx.d, { paymentId: p.id, decision: "approve", adminId: ctx.fx.adminId });
    expect(await enrolledIds(o.customerId)).toEqual([301, 302]);
    const i2 = await ctx.db.installment.findUniqueOrThrow({ where: { id: ins[1].id } });
    expect([i2.status, i2.paidCents]).toEqual(["PAID", 18000]);
  });

  it("certificado: nunca con cursos sin pagar; solo con los 9 pagados, matriculados y completados", async () => {
    const o = await monthlyOrder();
    await payPaypal(o.id);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(cust.moodleUserId!, id);
    let r = await checkDiplomaCompletion(ctx.d, o.customerId, ctx.fx.diploma);
    expect([r.issued, r.completed, r.pendingCourseIds.length]).toEqual([false, 1, 8]);

    const ins = (await getOrder(ctx.d, o.id)).installments;
    for (let k = 1; k < 9; k++) await payPaypal(o.id, ins[k].id);
    expect(await enrolledIds(o.customerId)).toEqual(ctx.fx.diplomaMoodleIds);
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([after.status, after.balanceCents, after.amountPaidCents]).toEqual(["ENROLLED", 0, 9 * 18000]);
    r = await checkDiplomaCompletion(ctx.d, o.customerId, ctx.fx.diploma);
    expect(r.issued).toBe(true);
  });

  it("reembolso parcial: la última cuota cubierta vuelve a quedar pendiente, se avisa del curso matriculado y la siguiente cuota a cobrar es la correcta", async () => {
    const o = await monthlyOrder();
    await payPaypal(o.id);
    let ins = (await getOrder(ctx.d, o.id)).installments;
    await payPaypal(o.id, ins[1].id);
    const third = await payPaypal(o.id, ins[2].id);
    expect(await enrolledIds(o.customerId)).toEqual([301, 302, 303]);

    await refundPayment(ctx.d, { paymentId: third.paymentId, amountCents: 10000, reason: "Ajuste", adminId: ctx.fx.adminId });
    ins = (await getOrder(ctx.d, o.id)).installments;
    expect(ins.slice(0, 4).map((i) => [i.status, i.paidCents])).toEqual([["PAID", 18000], ["PAID", 18000], ["PENDING", 8000], ["PENDING", 0]]);
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([order.amountPaidCents, order.balanceCents]).toEqual([44000, 9 * 18000 - 44000]);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "ATTENTION", note: { contains: "cuota 3" } } });
    expect(ev.note).toContain("sigue matriculado");
    // Siguiente cobro: el resto de la cuota 3 (no la 4).
    const next = await startPaypalPayment(ctx.d, o.id);
    expect(next.amountCents).toBe(10000);
    await expect(startPaypalPayment(ctx.d, o.id, { installmentId: ins[3].id })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
