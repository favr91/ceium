// x2 crítico 19: PayPal retiene la captura (CAPTURE_PENDING, el dinero del médico está en camino) y además hay un pago
// manual del mismo primer pago. (1) El médico no puede registrar otro pago desde una pestaña vieja del pedido (igual que
// startPaypalPayment). (2) Si el pago manual existe igual (lo registró el staff) y se rechaza, el pedido NO se cierra
// ni libera el cupo: al confirmar PayPal el médico queda pagado CON su cupo, nunca «cobrado sin cupo».
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR } from "@/server/deps";
import { createCheckout } from "@/server/orders";
import { adminRecordManualPayment, adminVerifyPayment, onPaypalCaptureCompleted, recordManualPayment, startPaypalPayment, storeProofFile, syncPaypalOrder } from "@/server/payments";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-19");
});
afterEach(async () => {
  await ctx.dispose();
});

async function heldByPaypal() {
  const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  const captureId = ctx.paypal.captureOutOfBand(s.paypalOrderId, "PENDING");
  expect(await syncPaypalOrder(ctx.d, s.paypalOrderId)).toBe("PENDING");
  return { o, s, captureId };
}

describe("captura de PayPal retenida + pago manual del mismo primer pago", () => {
  it("el médico no puede registrar un pago móvil mientras PayPal revisa su pago (y no queda comprobante huérfano)", async () => {
    const { o } = await heldByPaypal();
    const proof = await storeProofFile(ctx.d, o.id, "captura.png", TINY_JPEG);
    await expect(recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "01341234", bank: "Banesco", amountCents: 1_800_000, currency: "VES", proofFile: proof })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await ctx.db.payment.count({ where: { orderId: o.id, method: "PAGO_MOVIL" } })).toBe(0);
    expect(await ctx.db.payment.count({ where: { proofFile: proof } })).toBe(0);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PENDING_PAYMENT");
  });

  it("rechazar el pago manual no cierra el pedido ni libera el cupo; PayPal confirma → pagado con SU cupo", async () => {
    const { o, s, captureId } = await heldByPaypal();
    const pm = await adminRecordManualPayment(ctx.d, ctx.fx.admin, { orderId: o.id, method: "PAGO_MOVIL", reference: "01345678", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100 });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("AWAITING_VERIFICATION");

    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "reject", note: "No aparece en el banco" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PENDING_PAYMENT");
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("HELD");
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "payment_rejected" } });
    expect(mail.text).not.toMatch(/cupo reservado fue liberado/i);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "ATTENTION", note: { contains: "PayPal retiene" } } })).toBe(1);

    // Pasa el plazo: el job no vence el pedido ni libera el cupo, y nadie más lo toma.
    ctx.clock.advance(80 * HOUR);
    expect(await runJobs(ctx.d, ["expire"])).toMatchObject({ expire: { orders: 0, reservations: 0 } });
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("HELD");
    await createCheckout(ctx.d, { customer: { ...buyer(), email: "otro.medico@example.com" }, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" }).catch(() => null);
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);

    // PayPal confirma la captura → pagado con su cupo (no SEAT_UNAVAILABLE).
    await onPaypalCaptureCompleted(ctx.d, { captureId, paypalOrderId: s.paypalOrderId, amountCents: 18000, currency: "USD", source: "webhook" });
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(["PAID", "ENROLLED"]).toContain(after.status);
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("CONFIRMED");
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "SEAT_UNAVAILABLE" } })).toBe(0);
  });
});
