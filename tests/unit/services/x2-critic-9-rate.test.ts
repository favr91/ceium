// x2 (crítico 9): la tasa BCV cambia entre el monto que se le indicó al médico (correo del pedido, con la tasa de
// ese momento) y el registro de su comprobante. Pagar EXACTAMENTE lo indicado debe cubrir el primer pago; un pago
// de verdad corto sigue corto; nunca se usa una tasa anterior al pedido, fuera del plazo de verificación, ni una
// tasa mal cargada un instante. La tasa siempre sale de la configuración (historial auditado), nunca del cliente.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, recordManualPayment } from "@/server/payments";
import { updateSetting } from "@/server/admin-settings";
import { SETTING_KEYS } from "@/server/settings";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-9-rate");
});
afterEach(async () => {
  await ctx.dispose();
});

const HOUR = 3_600_000;
const setRate = (vesPerUsd: number) => updateSetting(ctx.d, ctx.fx.admin, SETTING_KEYS.exchangeRate, { vesPerUsd, source: "BCV" });
let n = 0;
async function order() {
  return createCheckout(ctx.d, { customer: buyer(++n), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
}
const pay = (orderId: string, amountCents: number, paidAt: Date, exchangeRate?: number) =>
  recordManualPayment(ctx.d, { orderId, method: "PAGO_MOVIL", reference: `0134${Date.now().toString().slice(-6)}${n}${Math.floor(Math.random() * 1000)}`, bank: "Banesco", amountCents, currency: "VES", paidAt, ...(exchangeRate != null ? { exchangeRate } : {}) });

describe("pago en bolívares con la tasa del momento en que se indicó el monto", () => {
  it("la tasa sube después del pedido: pagar los Bs. indicados cubre el primer pago y queda en el historial", async () => {
    await setRate(100);
    const o = await order(); // correo: Bs. 18.000,00 a 100
    expect(o.dueNowCents).toBe(18_000);
    const paidAt = ctx.clock.now();
    ctx.clock.advance(1 * HOUR);
    await setRate(101);
    ctx.clock.advance(2 * HOUR);
    const p = await pay(o.id, 1_800_000, paidAt, 150); // la tasa que escriba el cliente no cuenta
    expect(p.amountUsdCents).toBe(18_000);
    expect(Number(p.exchangeRate)).toBe(100);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "PAYMENT_SUBMITTED" } });
    expect(ev.data).toMatchObject({ exchangeRate: 100, configuredExchangeRate: 101, declaredExchangeRate: 150 });
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "NOTE", note: { contains: "Bs. 100 por USD" } } })).toBe(1);

    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("ENROLLED");
    expect(after.amountPaidCents).toBe(18_000);
  });

  it("un pago de verdad corto sigue corto (no se busca una tasa que lo «cubra»)", async () => {
    await setRate(100);
    const o = await order();
    const paidAt = ctx.clock.now();
    ctx.clock.advance(1 * HOUR);
    await setRate(101);
    const p = await pay(o.id, 1_790_000, paidAt); // Bs. 17.900 < 18.000 indicados
    expect(Number(p.exchangeRate)).toBe(101);
    expect(p.amountUsdCents).toBe(Math.round(1_790_000 / 101));
  });

  it("sin cambio de tasa todo sigue igual; con el pago cubierto a la tasa actual no se toca", async () => {
    await setRate(100);
    const o = await order();
    ctx.clock.advance(1 * HOUR);
    await setRate(99); // la tasa baja: a la actual ya cubre
    const p = await pay(o.id, 1_800_000, ctx.clock.now());
    expect(Number(p.exchangeRate)).toBe(99);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "NOTE" } })).toBe(0);
  });

  it("fecha declarada fuera del plazo de verificación (más de 72 h) → tasa actual", async () => {
    await setRate(100);
    const o = await order();
    const placed = ctx.clock.now();
    ctx.clock.advance(30 * HOUR);
    await setRate(101); // al día siguiente
    ctx.clock.advance(4 * 24 * HOUR);
    const p = await pay(o.id, 1_800_000, placed); // declara el día del pedido, hace 5 días
    expect(Number(p.exchangeRate)).toBe(101);
    expect(p.amountUsdCents).toBeLessThan(18_000);
  });

  it("una tasa anterior al pedido no se usa, aunque sea del mismo día", async () => {
    await setRate(100);
    ctx.clock.advance(1 * HOUR);
    await setRate(101);
    ctx.clock.advance(1 * HOUR);
    const o = await order(); // el correo ya dijo Bs. a 101
    const p = await pay(o.id, 1_800_000, ctx.clock.now()); // paga a 100 (tasa de la mañana, antes del pedido)
    expect(Number(p.exchangeRate)).toBe(101);
  });

  it("una tasa mal cargada un instante (10 en vez de 100) no infla un pago", async () => {
    await setRate(100);
    const o = await order();
    const paidAt = ctx.clock.now();
    ctx.clock.advance(1 * HOUR);
    await setRate(10);
    ctx.clock.advance(60_000);
    await setRate(101);
    const short = await pay(o.id, 1_700_000, paidAt); // corto a 100 y a 101; a 10 serían 1.700 USD
    expect(Number(short.exchangeRate)).toBe(101);
    expect(short.amountUsdCents).toBe(Math.round(1_700_000 / 101));
  });
});
