// Crítico x4: con PayPal desactivado en Configuración, los enlaces de pago que ya tiene el médico (página del pedido,
// recordatorio de cuota enviado antes de desactivarlo) no abren un cobro nuevo en PayPal. Lo ya aprobado en PayPal se
// sigue capturando (no se pierde un pago que el médico ya autorizó).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout, getOrder } from "@/server/orders";
import { capturePaypalReturn, startPaypalPayment } from "@/server/payments";
import { SETTING_KEYS } from "@/server/settings";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x4-critic-paypal-disabled");
});
afterEach(async () => {
  await ctx.dispose();
});

const setPaypal = (enabled: boolean) => ctx.db.setting.update({ where: { key: SETTING_KEYS.paypal }, data: { value: { enabled } as never } });

async function monthlyOrder() {
  return createCheckout(ctx.d, {
    customer: buyer(),
    items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind: "MONTHLY" }],
    paymentMethod: "PAYPAL",
  });
}

describe("PayPal desactivado en Configuración", () => {
  it("el enlace de la cuota (y el del pedido) no crea orden en PayPal ni intento de pago", async () => {
    const o = await monthlyOrder();
    const first = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(first.paypalOrderId);
    await capturePaypalReturn(ctx.d, first.paypalOrderId);
    const ins = (await getOrder(ctx.d, o.id)).installments;
    expect(ins[0].status).toBe("PAID");

    await setPaypal(false);
    const before = await ctx.db.payment.count({ where: { orderId: o.id } });
    await expect(startPaypalPayment(ctx.d, o.id, { installmentId: ins[1].id })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(startPaypalPayment(ctx.d, o.id)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await ctx.db.payment.count({ where: { orderId: o.id } })).toBe(before);

    await setPaypal(true);
    const s = await startPaypalPayment(ctx.d, o.id, { installmentId: ins[1].id });
    expect(s.amountCents).toBe(ins[1].amountCents);
  });

  it("una orden ya aprobada en PayPal antes de desactivarlo se sigue capturando", async () => {
    const o = await monthlyOrder();
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await setPaypal(false);
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId)).status).toBe("COMPLETED");
    expect((await getOrder(ctx.d, o.id)).installments[0].status).toBe("PAID");
  });
});
