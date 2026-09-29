// x2 (crítico 4): el médico abre PayPal en una pestaña, registra el pago móvil con comprobante en otra (pedido
// AWAITING_VERIFICATION) y luego aprueba PayPal. La app NO captura (no se cobra dos veces), el retorno dice POR QUÉ
// (MANUAL_AWAITING, no «PayPal no aprobó») y esa decisión es definitiva: ni un retorno recargado, ni el webhook
// CHECKOUT.ORDER.APPROVED reintentado, ni la conciliación la capturan después de que el admin apruebe el pago móvil.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, reconcilePaypalPayments, recordManualPayment, startPaypalPayment, storeProofFile } from "@/server/payments";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-double-payment");
});
afterEach(async () => {
  await ctx.dispose();
});

const captures = (paypalOrderId: string) => ctx.paypal.calls.filter((c) => c.fn === "captureOrder" && JSON.stringify(c).includes(paypalOrderId)).length;

describe("PayPal aprobado con el pago móvil del mismo pedido en verificación", () => {
  it("no captura, informa MANUAL_AWAITING y nunca captura después (retorno recargado, webhook, conciliación)", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    const proof = await storeProofFile(ctx.d, o.id, "captura.jpg", TINY_JPEG);
    const pm = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "01349876", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: proof });
    expect(pm.status).toBe("AWAITING_VERIFICATION");

    ctx.paypal.approve(s.paypalOrderId);
    expect(await capturePaypalReturn(ctx.d, s.paypalOrderId)).toMatchObject({ status: "FAILED", notCaptured: "MANUAL_AWAITING" });
    // Recargar el retorno mientras sigue en verificación: mismo motivo, un solo evento.
    expect(await capturePaypalReturn(ctx.d, s.paypalOrderId)).toMatchObject({ status: "FAILED", notCaptured: "MANUAL_AWAITING" });
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "PAYMENT_NOT_CAPTURED" } })).toBe(1);

    // El admin aprueba el pago móvil → inscrito con un solo pago.
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ENROLLED");

    // Después: retorno recargado, webhook APPROVED reintentado y conciliación → nunca se captura.
    expect(await capturePaypalReturn(ctx.d, s.paypalOrderId)).toMatchObject({ status: "FAILED", notCaptured: "NOT_CAPTURED" });
    expect(await capturePaypalReturn(ctx.d, s.paypalOrderId, "webhook")).toMatchObject({ status: "FAILED" });
    await reconcilePaypalPayments(ctx.d);
    expect(captures(s.paypalOrderId)).toBe(0);
    const pays = await ctx.db.payment.findMany({ where: { orderId: o.id } });
    expect(pays.filter((p) => p.status === "COMPLETED").map((p) => p.method)).toEqual(["PAGO_MOVIL"]);
    expect(pays.find((p) => p.method === "PAYPAL")).toMatchObject({ status: "CANCELLED", providerStatus: "NOT_CAPTURED", paypalCaptureId: null });
    expect(await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ amountPaidCents: 18000, balanceCents: 0 });
  });

  it("sin pago en verificación la aprobación se captura normalmente (sin motivo de no-captura)", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    const r = await capturePaypalReturn(ctx.d, s.paypalOrderId);
    expect(r.status).toBe("COMPLETED");
    expect(r.notCaptured).toBeUndefined();
  });
});
