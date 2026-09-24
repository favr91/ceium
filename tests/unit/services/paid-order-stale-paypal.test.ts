// x2 crítico 15: un pedido ya pagado (pago móvil aprobado) con una orden PayPal vieja abierta en otra pestaña.
// Si el médico la aprueba después (retorno, webhook CHECKOUT.ORDER.APPROVED o conciliación), NO se captura:
// cobrar y reembolsar el excedente le duplicaba el cargo y la comisión de PayPal no se recuperaba.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, startPaypalPayment } from "@/server/payments";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("stalepp");
});
afterEach(async () => {
  await ctx.dispose();
});

async function paidByPagoMovilWithStalePaypal() {
  const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const s = await startPaypalPayment(ctx.d, o.id); // pestaña de PayPal abierta, sin aprobar
  const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "PM-1", amountCents: o.dueNowCents * 100, currency: "VES", exchangeRate: 100 });
  await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
  expect([order.status, order.balanceCents]).toEqual(["ENROLLED", 0]);
  ctx.paypal.approve(s.paypalOrderId);
  return { o, s };
}

describe("pedido pagado + orden PayPal vieja aprobada después", () => {
  it("retorno (y su recarga): no se captura ni se reembolsa; el pago queda CANCELLED/NOT_CAPTURED con evento", async () => {
    const { o, s } = await paidByPagoMovilWithStalePaypal();
    const sent = await ctx.db.emailOutbox.count();
    const r = await capturePaypalReturn(ctx.d, s.paypalOrderId);
    expect(r).toMatchObject({ status: "FAILED", notCaptured: "NOT_CAPTURED" });
    expect(await capturePaypalReturn(ctx.d, s.paypalOrderId, "webhook")).toMatchObject({ status: "FAILED", notCaptured: "NOT_CAPTURED" });
    expect(ctx.paypal.orders.get(s.paypalOrderId)!.captureId ?? null).toBeNull();
    expect(ctx.paypal.calls.filter((c) => c.fn === "captureOrder")).toHaveLength(0);
    expect(ctx.paypal.refunds).toHaveLength(0);
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    expect([pay.status, pay.providerStatus, pay.paypalCaptureId]).toEqual(["CANCELLED", "NOT_CAPTURED", null]);
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([order.status, order.amountPaidCents, order.balanceCents]).toEqual(["ENROLLED", o.totalCents, 0]);
    const ev = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "PAYMENT_NOT_CAPTURED" } });
    expect(ev).toHaveLength(1);
    expect(ev[0].note).toContain("ya está pagado");
    expect(await ctx.db.emailOutbox.count()).toBe(sent);
  });

  it("conciliación (job paypal) sobre la orden aprobada: tampoco la captura", async () => {
    const { o, s } = await paidByPagoMovilWithStalePaypal();
    await runJobs(ctx.d, ["paypal"]);
    expect(ctx.paypal.refunds).toHaveLength(0);
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    expect(pay.paypalCaptureId).toBeNull();
    expect(ctx.paypal.calls.filter((c) => c.fn === "captureOrder")).toHaveLength(0);
    expect(pay.status).not.toBe("COMPLETED");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).amountPaidCents).toBe(o.totalCents);
  });
});
