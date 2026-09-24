// x4: «Recordar» desde el panel — el admin envía el recordatorio de la SIGUIENTE cuota (correo con el enlace directo
// de pago PayPal y manual de esa cuota) sin esperar a la fecha del job; queda en la cronología con quién lo envió.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, startPaypalPayment } from "@/server/payments";
import { adminSendInstallmentReminder } from "@/server/installments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x4-reminder");
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
}
const reminders = (orderId: string) => ctx.db.emailOutbox.findMany({ where: { orderId, template: "installment_reminder" }, orderBy: { createdAt: "asc" } });

describe("recordatorio de cuota desde el panel", () => {
  it("envía el correo de la siguiente cuota con sus enlaces de pago y deja el evento con el admin", async () => {
    const o = await monthlyOrder();
    await payPaypal(o.id);
    const ins2 = o.installments[1];
    const r = await adminSendInstallmentReminder(ctx.d, ctx.fx.admin, ins2.id);
    expect(r.sequence).toBe(2);
    const [mail] = await reminders(o.id);
    expect(mail.html).toContain(`/pedido/${o.token}/cuota/${ins2.id}/paypal`);
    expect(mail.html).toContain(`cuota=${ins2.id}`);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "INSTALLMENT_REMINDER" } });
    expect([ev.actorType, ev.actorId]).toEqual(["ADMIN", ctx.fx.admin.id]);
    // Repetirlo envía otro (reenvío explícito del admin), no se deduplica contra el anterior.
    await adminSendInstallmentReminder(ctx.d, ctx.fx.admin, ins2.id);
    expect(await reminders(o.id)).toHaveLength(2);
  });

  it("solo la siguiente cuota, y solo con el primer pago confirmado", async () => {
    const o = await monthlyOrder();
    await expect(adminSendInstallmentReminder(ctx.d, ctx.fx.admin, o.installments[1].id)).rejects.toThrow(/no tiene cuotas por cobrar/);
    await payPaypal(o.id);
    await expect(adminSendInstallmentReminder(ctx.d, ctx.fx.admin, o.installments[2].id)).rejects.toThrow(/siguiente cuota por pagar \(la 2\)/);
    await expect(adminSendInstallmentReminder(ctx.d, ctx.fx.admin, o.installments[0].id)).rejects.toThrow(/siguiente cuota/);
    expect(await reminders(o.id)).toHaveLength(0);
  });
});
