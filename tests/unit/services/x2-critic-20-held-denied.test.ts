// x2 crítico 20:
//  (1) PayPal retiene la captura (CAPTURE_PENDING) días y al final la RECHAZA. Al médico se le dijo «PayPal está
//      revisando tu pago; te avisaremos por correo» y no se le dejó pagar de otra forma. Antes: ningún correo y el
//      job vencía el pedido y liberaba el cupo en la corrida siguiente. Ahora: correo de pago no aprobado con
//      «registra el pago de nuevo» y un plazo nuevo con SU cupo.
//  (2) Matrícula PENDING (Moodle caído) de un pedido reembolsado sin desmatricular: ya no queda «pendiente» para siempre.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR } from "@/server/deps";
import { createCheckout } from "@/server/orders";
import { adminRecordManualPayment, adminVerifyPayment, onPaypalCaptureDenied, recordManualPayment, refundPayment, startPaypalPayment, syncPaypalOrder } from "@/server/payments";
import { retryDueEnrollments } from "@/server/enrollment";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-20");
});
afterEach(async () => {
  await ctx.dispose();
});

const newOrder = (email?: string) =>
  createCheckout(ctx.d, { customer: email ? { ...buyer(), email } : buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });

describe("PayPal rechaza una captura que tenía retenida", () => {
  it("avisa al médico, le da un plazo nuevo con su cupo y luego puede pagar con pago móvil", async () => {
    const o = await newOrder();
    const s = await startPaypalPayment(ctx.d, o.id);
    const captureId = ctx.paypal.captureOutOfBand(s.paypalOrderId, "PENDING");
    expect(await syncPaypalOrder(ctx.d, s.paypalOrderId)).toBe("PENDING");

    ctx.clock.advance(80 * HOUR); // la revisión de PayPal dura más que el plazo del pedido
    await runJobs(ctx.d, ["expire"]);
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("HELD");

    await onPaypalCaptureDenied(ctx.d, { captureId, source: "webhook" });
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    expect(pay).toMatchObject({ status: "FAILED", providerStatus: "DENIED" });
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(order.expiresAt!.getTime()).toBeGreaterThan(ctx.clock.now().getTime() + 24 * HOUR);
    const mails = await ctx.db.emailOutbox.findMany({ where: { orderId: o.id, template: "payment_rejected" } });
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toMatch(/no se te cobró/);
    expect(mails[0].text).toMatch(/registrar nuevamente el pago/);

    // La siguiente corrida del job NO vence el pedido recién reabierto.
    await runJobs(ctx.d, ["expire"]);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PENDING_PAYMENT");
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("HELD");

    // Webhook repetido: no reenvía el correo ni vuelve a extender.
    await onPaypalCaptureDenied(ctx.d, { captureId, source: "webhook" });
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o.id, template: "payment_rejected" } })).toBe(1);

    // Ahora sí puede registrar el pago móvil.
    await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "01349999", bank: "Banesco", amountCents: 1_800_000, currency: "VES" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("AWAITING_VERIFICATION");

    // Si nadie paga en el plazo nuevo, vence y libera el cupo como siempre (otro pedido de control).
    const o2 = await newOrder("control.medico@example.com");
    {
      const s2 = await startPaypalPayment(ctx.d, o2.id);
      const c2 = ctx.paypal.captureOutOfBand(s2.paypalOrderId, "PENDING");
      await syncPaypalOrder(ctx.d, s2.paypalOrderId);
      ctx.clock.advance(80 * HOUR);
      await onPaypalCaptureDenied(ctx.d, { captureId: c2, source: "webhook" });
      ctx.clock.advance(73 * HOUR);
      await runJobs(ctx.d, ["expire"]);
      expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe("EXPIRED");
      expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o2.id } })).status).toBe("RELEASED");
    }
  });

  it("un rechazo inmediato de PayPal (sin retención) no manda correo: el médico lo ve en pantalla", async () => {
    const o = await newOrder();
    const s = await startPaypalPayment(ctx.d, o.id);
    await onPaypalCaptureDenied(ctx.d, { paypalOrderId: s.paypalOrderId, source: "return" });
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o.id, template: "payment_rejected" } })).toBe(0);
  });
});

describe("matrícula pendiente de un pedido reembolsado", () => {
  it("reembolso total sin desmatricular con Moodle caído → la fila deja de estar PENDING y el job no la toca", async () => {
    ctx.moodle.failEnrol = 100;
    const o = await newOrder();
    const pm = await adminRecordManualPayment(ctx.d, ctx.fx.admin, { orderId: o.id, method: "PAGO_MOVIL", reference: "01347777", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100 });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    expect((await ctx.db.enrollment.findMany({ where: { orderId: o.id } })).map((r) => r.status)).toEqual(["PENDING"]);

    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, reason: "Devolución", unenroll: false, idempotencyKey: "x2c20-refund" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("REFUNDED");
    const rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows.map((r) => r.status)).toEqual(["UNENROLLED"]);
    expect(rows[0].lastError).toMatch(/reembolsado/);
    expect(rows[0].nextAttemptAt).toBeNull();

    ctx.moodle.failEnrol = 0;
    ctx.clock.advance(HOUR);
    expect(await retryDueEnrollments(ctx.d)).toEqual({ orders: 0, enrolled: 0 });
    expect(ctx.moodle.calls.filter((c) => c.fn === "enrol").length).toBeGreaterThan(0);
    expect([...(ctx.moodle.enrolments.values())].every((s) => s.size === 0)).toBe(true);
  });

  it("filas PENDING que ya quedaron colgadas en un pedido reembolsado se cierran en la siguiente corrida del job", async () => {
    ctx.moodle.failEnrol = 100;
    const o = await newOrder();
    const pm = await adminRecordManualPayment(ctx.d, ctx.fx.admin, { orderId: o.id, method: "PAGO_MOVIL", reference: "01348888", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100 });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, reason: "Devolución", unenroll: false, idempotencyKey: "x2c20-refund-2" });
    // Simula el estado previo al arreglo (fila colgada): vuelve a PENDING.
    await ctx.db.enrollment.updateMany({ where: { orderId: o.id }, data: { status: "PENDING", nextAttemptAt: ctx.clock.now() } });
    ctx.moodle.failEnrol = 0;
    ctx.clock.advance(HOUR);
    await retryDueEnrollments(ctx.d);
    expect((await ctx.db.enrollment.findMany({ where: { orderId: o.id } })).map((r) => r.status)).toEqual(["UNENROLLED"]);
    expect(await retryDueEnrollments(ctx.d)).toEqual({ orders: 0, enrolled: 0 });
  });
});
