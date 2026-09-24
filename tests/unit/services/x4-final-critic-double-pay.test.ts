// x4 crítico final — cobro doble de una cuota del plan «mes a mes»:
//  - Pago Móvil de la cuota en verificación y la MISMA cuota con PayPal (enlace del recordatorio): antes se cobraba y
//    se imputaba a la cuota siguiente (o, en la última, quedaba saldo a favor que el staff debía devolver).
//  - Orden PayPal abierta ANTES de registrar ese Pago Móvil y aprobada después: no se captura.
//  - Dos pestañas de PayPal de la misma cuota aprobadas a la vez: una sola captura (antes: dos, y un reembolso
//    automático del excedente — cobro doble al médico y comisión de PayPal perdida).
//  - El job de recordatorios no le pide pagar la cuota mientras su pago está en verificación.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminRecordManualPayment, capturePaypalReturn, recordManualPayment, startPaypalPayment } from "@/server/payments";
import { runInstallmentReminders } from "@/server/installments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x4-final-double-pay");
});
afterEach(async () => {
  await ctx.dispose();
});

async function monthlyEnrolled() {
  const o = await createCheckout(ctx.d, {
    customer: buyer(),
    items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind: "MONTHLY" }],
    paymentMethod: "PAYPAL",
  });
  await payPaypal(o.id);
  return o;
}
async function payPaypal(orderId: string, installmentId?: string) {
  const s = await startPaypalPayment(ctx.d, orderId, installmentId ? { installmentId } : undefined);
  ctx.paypal.approve(s.paypalOrderId);
  return capturePaypalReturn(ctx.d, s.paypalOrderId);
}
const manual = (orderId: string, ref: string) =>
  adminRecordManualPayment(ctx.d, ctx.fx.admin, { orderId, method: "PAGO_MOVIL", reference: ref, bank: "Banesco", amountCents: 18000 * 100, currency: "VES", exchangeRate: 100 });
const captures = () => ctx.paypal.calls.filter((c) => c.fn === "captureOrder").length;
const completed = (orderId: string) => ctx.db.payment.count({ where: { orderId, method: "PAYPAL", status: "COMPLETED" } });

describe("cuota ya pagada por otra vía", () => {
  it("con su Pago Móvil en verificación, PayPal no abre un cobro de la misma cuota", async () => {
    const o = await monthlyEnrolled();
    await manual(o.id, "01345555");
    await expect(startPaypalPayment(ctx.d, o.id, { installmentId: o.installments[1].id })).rejects.toThrow(/lo estamos verificando/);
    await expect(startPaypalPayment(ctx.d, o.id)).rejects.toThrow(/lo estamos verificando/);
  });

  it("orden PayPal abierta antes del Pago Móvil y aprobada después: no se captura", async () => {
    const o = await monthlyEnrolled();
    const s = await startPaypalPayment(ctx.d, o.id, { installmentId: o.installments[1].id });
    await manual(o.id, "01346666");
    ctx.paypal.approve(s.paypalOrderId);
    const before = captures();
    const r = await capturePaypalReturn(ctx.d, s.paypalOrderId);
    expect(r.status).toBe("FAILED");
    expect(captures()).toBe(before);
    expect(await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).toMatchObject({ status: "CANCELLED", providerStatus: "NOT_CAPTURED" });
  });

  it("dos pestañas de la última cuota aprobadas a la vez: una sola captura, sin reembolso", async () => {
    const o = await monthlyEnrolled();
    for (const ins of o.installments.slice(1, 8)) expect((await payPaypal(o.id, ins.id)).status).toBe("COMPLETED");
    const last = o.installments[8];
    const a = await startPaypalPayment(ctx.d, o.id, { installmentId: last.id });
    const b = await startPaypalPayment(ctx.d, o.id, { installmentId: last.id });
    ctx.paypal.approve(a.paypalOrderId);
    ctx.paypal.approve(b.paypalOrderId);
    const before = captures();
    const rs = await Promise.all([capturePaypalReturn(ctx.d, a.paypalOrderId), capturePaypalReturn(ctx.d, b.paypalOrderId)]);
    expect(rs.map((r) => r.status).sort()).toEqual(["COMPLETED", "FAILED"]);
    expect(captures() - before).toBe(1);
    expect(ctx.paypal.refunds).toEqual([]);
    expect(await completed(o.id)).toBe(9);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).balanceCents).toBe(0);
  });

  it("dos pestañas de la cuota 2, la segunda aprobada después: no se cobra ni adelanta la cuota 3", async () => {
    const o = await monthlyEnrolled();
    const ins2 = o.installments[1];
    const a = await startPaypalPayment(ctx.d, o.id, { installmentId: ins2.id });
    const b = await startPaypalPayment(ctx.d, o.id, { installmentId: ins2.id });
    ctx.paypal.approve(b.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, b.paypalOrderId)).status).toBe("COMPLETED");
    ctx.paypal.approve(a.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, a.paypalOrderId)).status).toBe("FAILED");
    expect(await completed(o.id)).toBe(2);
    const ins = await ctx.db.installment.findMany({ where: { orderId: o.id }, orderBy: { sequence: "asc" } });
    expect(ins.map((i) => i.status).slice(0, 3)).toEqual(["PAID", "PAID", expect.not.stringMatching(/^PAID$/)]);
  });

  it("el job de recordatorios no pide pagar la cuota mientras su Pago Móvil está en verificación", async () => {
    const o = await monthlyEnrolled();
    await manual(o.id, "01347777");
    const ins2 = await ctx.db.installment.findUniqueOrThrow({ where: { id: o.installments[1].id } });
    ctx.clock.t = new Date(ins2.dueDate!.getTime() + 60_000);
    await runInstallmentReminders(ctx.d);
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o.id, template: "installment_reminder" } })).toBe(0);
  });

  it("una captura que falló sin respuesta no bloquea para siempre: pasado el plazo, otro intento sí se cobra", async () => {
    const o = await createCheckout(ctx.d, {
      customer: buyer(),
      items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind: "FULL" }],
      paymentMethod: "PAYPAL",
    });
    const a = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(a.paypalOrderId);
    const real = ctx.paypal.captureOrder.bind(ctx.paypal);
    ctx.paypal.captureOrder = async () => {
      throw new Error("PayPal capture: network timeout");
    };
    await expect(capturePaypalReturn(ctx.d, a.paypalOrderId)).rejects.toThrow(/PayPal no respondió/);
    ctx.paypal.captureOrder = real;
    // Mientras la captura cuenta como en curso, no se abre otro cobro.
    await expect(startPaypalPayment(ctx.d, o.id)).rejects.toThrow(/Estamos confirmando con PayPal/);
    ctx.clock.advance(3 * 60_000);
    const b = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(b.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, b.paypalOrderId)).status).toBe("COMPLETED");
    expect(await ctx.db.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).toMatchObject({ status: "CANCELLED", providerStatus: "CAPTURE_UNKNOWN" });
  });

  it("Pago Móvil del médico mientras PayPal captura esa misma cuota (otra pestaña): se rechaza, un solo cobro", async () => {
    const o = await monthlyEnrolled();
    const s = await startPaypalPayment(ctx.d, o.id, { installmentId: o.installments[1].id });
    ctx.paypal.approve(s.paypalOrderId);
    const real = ctx.paypal.captureOrder.bind(ctx.paypal);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inCapture = new Promise<void>((r) => (entered = r));
    ctx.paypal.captureOrder = async (id: string) => {
      entered();
      await gate;
      return real(id);
    };
    const capture = capturePaypalReturn(ctx.d, s.paypalOrderId);
    await inCapture;
    await expect(
      recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "01348888", bank: "Banesco", amountCents: 1_800_000, currency: "VES" }),
    ).rejects.toThrow(/Estamos confirmando con PayPal/);
    release();
    expect((await capture).status).toBe("COMPLETED");
    ctx.paypal.captureOrder = real;
    expect(await ctx.db.payment.count({ where: { orderId: o.id, status: "AWAITING_VERIFICATION" } })).toBe(0);
    const ins = await ctx.db.installment.findMany({ where: { orderId: o.id }, orderBy: { sequence: "asc" } });
    expect(ins.map((i) => i.status).slice(0, 3)).toEqual(["PAID", "PAID", expect.not.stringMatching(/^PAID$/)]);
    // Ya confirmada la captura, la cuota 3 sí admite su Pago Móvil.
    await expect(
      recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "01349999", bank: "Banesco", amountCents: 1_800_000, currency: "VES" }),
    ).resolves.toMatchObject({ status: "AWAITING_VERIFICATION" });
  });

  it("el job de recordatorios tampoco pide pagar mientras PayPal retiene el pago de la cuota (CAPTURE_PENDING)", async () => {
    const o = await monthlyEnrolled();
    const s = await startPaypalPayment(ctx.d, o.id, { installmentId: o.installments[1].id });
    await ctx.db.payment.update({ where: { id: s.paymentId }, data: { providerStatus: "CAPTURE_PENDING" } });
    const ins2 = await ctx.db.installment.findUniqueOrThrow({ where: { id: o.installments[1].id } });
    ctx.clock.t = new Date(ins2.dueDate!.getTime() + 60_000);
    await runInstallmentReminders(ctx.d);
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o.id, template: "installment_reminder" } })).toBe(0);
  });
});
