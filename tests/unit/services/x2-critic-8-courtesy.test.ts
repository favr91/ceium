// x2 (crítico 8): un reembolso PARCIAL de cortesía (sin retiro) sobre un pedido pagado por completo no convierte lo
// devuelto en deuda: ni saldo, ni cuota reabierta/vencida, ni «Cuota vencida — paga X» al médico. Desde el panel o
// desde PayPal (solo llega el webhook). Un pedido con saldo pendiente (mitad) conserva el comportamiento anterior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, handlePaypalWebhook, recordManualPayment, refundPayment, startPaypalPayment, storeProofFile } from "@/server/payments";
import { runInstallmentReminders } from "@/server/installments";
import { DAY } from "@/server/deps";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-8-courtesy");
});
afterEach(async () => {
  await ctx.dispose();
});

let refN = 0;
async function paidPagoMovil(planKind: "FULL" | "HALF", payments: number) {
  const o = await createCheckout(ctx.d, { customer: buyer(++refN), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind }], paymentMethod: "PAGO_MOVIL" });
  const per = planKind === "FULL" ? 1_800_000 : 900_000;
  const ids: string[] = [];
  for (let i = 0; i < payments; i++) {
    const proof = await storeProofFile(ctx.d, o.id, "captura.jpg", TINY_JPEG);
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: `0134${refN}${i}9876`, bank: "Banesco", amountCents: per, currency: "VES", exchangeRate: 100, proofFile: proof });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    ids.push(p.id);
  }
  return { o, ids };
}
const orderOf = (id: string) => ctx.db.order.findUniqueOrThrow({ where: { id } });
const installments = (orderId: string) => ctx.db.installment.findMany({ where: { orderId }, orderBy: { sequence: "asc" } }).then((l) => l.map((i) => [i.status, i.amountCents, i.paidCents]));
const reminders = (orderId: string) => ctx.db.emailOutbox.count({ where: { orderId, template: "installment_reminder" } });
async function dunning() {
  for (let i = 0; i < 3; i++) {
    ctx.clock.advance(8 * DAY);
    await runInstallmentReminders(ctx.d);
  }
}

describe("reembolso parcial de cortesía en un pedido pagado completo", () => {
  it("pago móvil, plan de contado, desde el panel (opciones por defecto) → saldo 0, cuota pagada, sin recordatorios, auditado", async () => {
    const { o, ids } = await paidPagoMovil("FULL", 1);
    expect((await orderOf(o.id)).status).toBe("ENROLLED");
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: ids[0], amountCents: 1000, reason: "Cortesía" });
    await dunning();
    const after = await orderOf(o.id);
    expect([after.status, after.amountPaidCents, after.balanceCents]).toEqual(["ENROLLED", 17000, 0]);
    expect(await installments(o.id)).toEqual([["PAID", 17000, 17000]]);
    expect(await reminders(o.id)).toBe(0);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "INSTALLMENT_OVERDUE" } })).toBe(0);
    expect((await ctx.db.balanceAdjustment.findMany({ where: { orderId: o.id } })).map((a) => [a.amountCents, a.createdById])).toEqual([[-1000, ctx.fx.adminId]]);
    const ev = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: { in: ["REFUND", "BALANCE_ADJUSTED"] } }, orderBy: { createdAt: "asc" } });
    expect(ev.map((e) => e.type).sort()).toEqual(["BALANCE_ADJUSTED", "REFUND"]);
    expect(ev.find((e) => e.type === "BALANCE_ADJUSTED")!.note).toMatch(/cortesía/);
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItem: { orderId: o.id } } })).status).toBe("CONFIRMED");
    expect(ctx.moodle.count("unenrol")).toBe(0);
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o.id, template: "refund_issued" } })).toBe(1);
  });

  it("PayPal, reembolso parcial hecho en el panel de PayPal (solo webhook) → sin deuda; luego el resto → REFUNDED", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(99), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    expect((await handlePaypalWebhook(ctx.d, {}, ctx.paypal.refundEvent(pay.paypalCaptureId!, "REF-EXT-C1", 2000))).ok).toBe(true);
    await dunning();
    let after = await orderOf(o.id);
    expect([after.status, after.balanceCents]).toEqual(["ENROLLED", 0]);
    expect(await installments(o.id)).toEqual([["PAID", 16000, 16000]]);
    expect(await reminders(o.id)).toBe(0);
    const adj = await ctx.db.balanceAdjustment.findMany({ where: { orderId: o.id } });
    expect(adj.map((a) => [a.amountCents, a.createdById])).toEqual([[-2000, null]]);
    // El resto también desde PayPal: reembolso total → pedido cerrado, cupo liberado, desmatriculado.
    await handlePaypalWebhook(ctx.d, {}, ctx.paypal.refundEvent(pay.paypalCaptureId!, "REF-EXT-C2", 16000));
    after = await orderOf(o.id);
    expect([after.status, after.balanceCents]).toEqual(["REFUNDED", 0]);
    expect(ctx.moodle.count("unenrol")).toBe(1);
    expect(await ctx.db.balanceAdjustment.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("plan de mitad con ambas cuotas pagadas: reembolso de la segunda cuota completa → exonerada, sin deuda", async () => {
    const { o, ids } = await paidPagoMovil("HALF", 2);
    expect((await orderOf(o.id)).balanceCents).toBe(0);
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: ids[1], reason: "Beca" });
    await dunning();
    const after = await orderOf(o.id);
    expect([after.status, after.amountPaidCents, after.balanceCents]).toEqual(["ENROLLED", 9000, 0]);
    expect(await installments(o.id)).toEqual([
      ["PAID", 9000, 9000],
      ["WAIVED", 9000, 0],
    ]);
    expect(await reminders(o.id)).toBe(0);
  });

  it("plan de mitad con saldo pendiente: el reembolso parcial SÍ vuelve a ser deuda (comportamiento anterior)", async () => {
    const { o, ids } = await paidPagoMovil("HALF", 1);
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: ids[0], amountCents: 1000, reason: "Error de monto" });
    const after = await orderOf(o.id);
    expect([after.amountPaidCents, after.balanceCents]).toEqual([8000, 10000]);
    expect(await ctx.db.balanceAdjustment.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("reembolso parcial con retiro (libera el cupo) → pedido cerrado, sin ajuste de cortesía", async () => {
    const { o, ids } = await paidPagoMovil("FULL", 1);
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: ids[0], amountCents: 9000, reason: "Retiro con retención", releaseSeat: true, unenroll: true });
    const after = await orderOf(o.id);
    expect([after.status, after.balanceCents]).toEqual(["REFUNDED", 0]);
    expect(await ctx.db.balanceAdjustment.count({ where: { orderId: o.id } })).toBe(0);
  });
});
