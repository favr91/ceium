// Crítico x3: el job de certificados verifica la finalización en Moodle curso por curso (lento); si en medio de
// esa verificación llega el reembolso total del diplomado (webhook PAYMENT.CAPTURE.REFUNDED), el pedido queda
// REFUNDED y el job NO debe terminar emitiendo ni enviando el certificado (antes lo emitía: leía el pedido
// «pagado» al principio y creaba el certificado sin volver a comprobarlo).
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, onPaypalRefundCompleted, startPaypalPayment } from "@/server/payments";
import { runCertificateSweep } from "@/server/certificates";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x3critic");
});
afterEach(async () => {
  await ctx.dispose();
});

async function enrolledFull() {
  const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  return { orderId: o.id, moodleUserId: c.moodleUserId! };
}

it("reembolso total a mitad de la verificación de Moodle: no se emite certificado ni correo", async () => {
  const a = await enrolledFull();
  expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe("ENROLLED");
  for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(a.moodleUserId, id);
  const pay = await ctx.db.payment.findFirstOrThrow({ where: { orderId: a.orderId, paypalCaptureId: { not: null } } });

  const original = ctx.moodle.getCompletion.bind(ctx.moodle);
  let n = 0;
  ctx.moodle.getCompletion = async (userId: number, courseId: number) => {
    if (++n === 4) {
      // PayPal avisa el reembolso total mientras el job va por el 4.º curso.
      await onPaypalRefundCompleted(ctx.d, { captureId: pay.paypalCaptureId!, refundId: "REFUND-RACE-1" });
    }
    return original(userId, courseId);
  };
  await runCertificateSweep(ctx.d);
  ctx.moodle.getCompletion = original;

  expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.orderId } })).status).toBe("REFUNDED");
  expect(await ctx.db.certificate.count({ where: { status: "ISSUED" } })).toBe(0);
  expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } })).toBe(0);
  expect(await ctx.db.orderEvent.count({ where: { orderId: a.orderId, type: "CERTIFICATE_ISSUED" } })).toBe(0);
  // Y ninguna corrida posterior lo emite.
  await runCertificateSweep(ctx.d);
  expect(await ctx.db.certificate.count()).toBe(0);
}, 60_000);

it("doble clic en la tienda (reusePendingTwin): 6 checkouts simultáneos del mismo médico → UN pedido y UN cupo", async () => {
  const { createCheckout: cc } = await import("@/server/orders");
  const b = buyer();
  const cohortId = ctx.fx.courseCohort; // capacidad 3
  const input = { customer: b, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL" as const, cohortId, planKind: "FULL" as const }], paymentMethod: "PAYPAL" as const, reusePendingTwin: true };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const other = { ...ctx.makeDeps(ctx.extraClient()), sleep };
  const here = { ...ctx.d, sleep };
  const outs = await Promise.all([here, other, here, other, here, other].map((d) => cc(d, input))).finally(() => other.db.$disconnect());
  expect(new Set(outs.map((o) => o.id)).size).toBe(1);
  expect(await ctx.db.order.count()).toBe(1);
  expect(await ctx.db.cohort.findUniqueOrThrow({ where: { id: cohortId }, select: { seatsHeld: true } })).toEqual({ seatsHeld: 1 });
  // Otro médico sigue teniendo cupo; y el mismo médico con OTRO método o nombre corregido no reutiliza ese pedido.
  await cc(ctx.d, { ...input, customer: buyer() });
  const renamed = await cc(ctx.d, { ...input, customer: { ...b, firstName: `${b.firstName} José` } });
  expect(renamed.id).not.toBe(outs[0].id);
  expect(await ctx.db.cohort.findUniqueOrThrow({ where: { id: cohortId }, select: { seatsHeld: true } })).toEqual({ seatsHeld: 3 });
}, 60_000);
