// x2 crítico 16 (brecha secundaria): un reembolso PayPal cuya llamada se quedó sin respuesta (timeout) quedaba
// Refund PENDING para siempre si además se perdía el webhook PAYMENT.CAPTURE.REFUNDED. El job "paypal" ahora lo
// retoma con el MISMO PayPal-Request-Id: nunca reembolsa dos veces, aplica las opciones del admin (cupo, Moodle)
// y deja ATTENTION cuando PayPal lo rechaza o sigue sin responder.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, reconcilePendingRefunds, refundPayment, startPaypalPayment } from "@/server/payments";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2c17");
});
afterEach(async () => {
  await ctx.dispose();
});

async function paidPaypalSemi() {
  const o = await createCheckout(ctx.d, {
    customer: buyer(),
    items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }],
    paymentMethod: "PAYPAL",
  });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
  expect(pay.status).toBe("COMPLETED");
  return { o, pay };
}

const MIN = 60_000;
const refundCalls = () => ctx.paypal.calls.filter((c) => c.fn === "refundCapture");
const attention = (orderId: string) => ctx.db.orderEvent.findMany({ where: { orderId, type: "ATTENTION" } });

describe("reembolso PayPal PENDING sin respuesta ni webhook", () => {
  it("PayPal SÍ reembolsó (respuesta perdida): el job lo aplica una vez, con las opciones del admin, sin volver a reembolsar", async () => {
    const { o, pay } = await paidPaypalSemi();
    ctx.paypal.refundNetworkErrorAfterRefund = true;
    await expect(
      refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, reason: "Retiro", unenroll: true, releaseSeat: true }),
    ).rejects.toMatchObject({ code: "PAYMENT_PROVIDER" });
    const row = await ctx.db.refund.findFirstOrThrow({ where: { paymentId: pay.id } });
    expect(row.status).toBe("PENDING");
    expect(ctx.paypal.refunds).toHaveLength(1);

    // Recién creado: el job no lo toca (puede estar aún en vuelo).
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 0 });

    ctx.clock.advance(6 * MIN);
    const out = (await runJobs(ctx.d, ["paypal"])) as { paypal: { refunds: Record<string, number> } };
    expect(out.paypal.refunds).toMatchObject({ checked: 1, completed: 1 });

    // El mismo PayPal-Request-Id: PayPal devolvió el reembolso ya hecho; no hay un segundo.
    expect(ctx.paypal.refunds).toHaveLength(1);
    const ids = new Set(refundCalls().map((c) => (c.args[2] as { requestId?: string }).requestId));
    expect([...ids]).toEqual([`refund-${row.id}`]);

    const after = await ctx.db.refund.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("COMPLETED");
    expect(after.providerRefundId).toBe(ctx.paypal.refunds[0].id);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe("REFUNDED");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("REFUNDED");
    const res = await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } });
    expect(res.status).toBe("RELEASED");
    expect(ctx.moodle.calls.some((c) => c.fn === "unenrol")).toBe(true);

    // Segunda pasada: nada que hacer, ningún reembolso más.
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 0 });
    expect(ctx.paypal.refunds).toHaveLength(1);
  });

  it("PayPal NO lo hizo (error de red antes): el job lo hace ahora, una sola vez, y respeta «no desmatricular»", async () => {
    const { o, pay } = await paidPaypalSemi();
    ctx.paypal.refundNetworkErrorAfterRefund = false;
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 5000, reason: "Cortesía", unenroll: false, releaseSeat: false })).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER",
    });
    expect(ctx.paypal.refunds).toHaveLength(0);
    ctx.clock.advance(6 * MIN);
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 1, completed: 1 });
    expect(ctx.paypal.refunds).toHaveLength(1);
    expect(ctx.paypal.refunds[0].amountCents).toBe(5000);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).refundedCents).toBe(5000);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe("REFUNDED");
    expect(ctx.moodle.calls.some((c) => c.fn === "unenrol")).toBe(false);
  });

  it("PayPal lo rechaza en el reintento: fila FAILED y un solo ATTENTION (el dinero no se devolvió)", async () => {
    const { o, pay } = await paidPaypalSemi();
    ctx.paypal.refundNetworkErrorAfterRefund = false;
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id })).rejects.toMatchObject({ code: "PAYMENT_PROVIDER" });
    ctx.paypal.failRefund = true;
    ctx.clock.advance(6 * MIN);
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 1, failed: 1 });
    const row = await ctx.db.refund.findFirstOrThrow({ where: { paymentId: pay.id } });
    expect(row.status).toBe("FAILED");
    const att = await attention(o.id);
    expect(att.filter((e) => e.note?.includes(row.id))).toHaveLength(1);
    expect(att.find((e) => e.note?.includes(row.id))!.note).toMatch(/NO se devolvió/);
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 0 });
    expect((await attention(o.id)).filter((e) => e.note?.includes(row.id))).toHaveLength(1);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe("REFUNDED");
  });

  it("PayPal sigue sin responder: sigue PENDING (reintenta cada pasada) y tras 24 h avisa una sola vez", async () => {
    const { o, pay } = await paidPaypalSemi();
    ctx.paypal.refundNetworkErrorAfterRefund = false;
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id })).rejects.toMatchObject({ code: "PAYMENT_PROVIDER" });
    const row = await ctx.db.refund.findFirstOrThrow({ where: { paymentId: pay.id } });
    ctx.clock.advance(6 * MIN);
    ctx.paypal.refundNetworkErrorAfterRefund = false;
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 1, pending: 1 });
    expect((await attention(o.id)).filter((e) => e.note?.includes(row.id))).toHaveLength(0);
    ctx.clock.advance(25 * 60 * MIN);
    for (let i = 0; i < 2; i++) {
      ctx.paypal.refundNetworkErrorAfterRefund = false;
      expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ checked: 1, pending: 1 });
    }
    const att = (await attention(o.id)).filter((e) => e.note?.includes(row.id));
    expect(att).toHaveLength(1);
    expect(att[0].note).toMatch(/sigue sin confirmar/);
    expect((await ctx.db.refund.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("PENDING");
    expect(ctx.paypal.refunds).toHaveLength(0);
    // Cuando PayPal vuelve, la siguiente pasada lo completa.
    expect(await reconcilePendingRefunds(ctx.d)).toMatchObject({ completed: 1 });
    expect(ctx.paypal.refunds).toHaveLength(1);
  });
});
