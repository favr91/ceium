// x2 critic 23/24: el MISMO cliente paga dos pedidos de la MISMA cohorte (o del mismo curso online).
//  - critic 23: antes nada lo marcaba (dos cobros y dos cupos en silencio) → ATTENTION en ambos pedidos.
//  - critic 24: la segunda orden PayPal seguía capturándose (el médico quedaba cobrado dos veces hasta que el staff
//    reembolsara). Ahora, si el cliente ya pagó (cupo CONFIRMED / pedido online pagado) o tiene el pago de otro pedido
//    en verificación o retenido por PayPal, la orden aprobada NO se captura (secureSeatBeforeCapture →
//    alreadyPaidElsewhere): PAYMENT_NOT_CAPTURED en el pedido nuevo y ATTENTION en el que ya pagó.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, refundPayment, startPaypalPayment } from "@/server/payments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-23-duplicate");
});
afterEach(async () => {
  await ctx.dispose();
});

type Item = { productId: string; modality: "SEMIPRESENCIAL" | "ONLINE"; cohortId?: string; planKind: "FULL" };
const attention = async (orderId: string) => (await ctx.db.orderEvent.findMany({ where: { orderId, type: "ATTENTION" }, orderBy: { createdAt: "asc" } })).map((e) => e.note ?? "");
const notCaptured = async (orderId: string) => (await ctx.db.orderEvent.findMany({ where: { orderId, type: "PAYMENT_NOT_CAPTURED" } })).map((e) => e.note ?? "");
const semi = (): Item[] => [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }];
const online = (): Item[] => [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }];
const confirmedSeats = (customerId: string) => ctx.db.seatReservation.count({ where: { cohortId: ctx.fx.courseCohort, status: "CONFIRMED", order: { customerId } } });
const captures = () => ctx.paypal.calls.filter((c) => c.fn === "captureOrder").length;

async function paypalTry(customer: ReturnType<typeof buyer>, items: Item[] = semi()) {
  const o = await createCheckout(ctx.d, { customer, items: items as never, paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  const r = await capturePaypalReturn(ctx.d, s.paypalOrderId);
  return { o, s, r };
}
async function paypalPaid(customer: ReturnType<typeof buyer>, items: Item[] = semi()) {
  const { o, r } = await paypalTry(customer, items);
  expect(r.status).toBe("COMPLETED");
  return o;
}

describe("compra duplicada del mismo cliente", () => {
  it("pago móvil en verificación + recompra con PayPal de la misma cohorte → PayPal NO se captura; aprobar el comprobante deja un cupo", async () => {
    const who = buyer();
    const a = await createCheckout(ctx.d, { customer: who, items: semi() as never, paymentMethod: "PAGO_MOVIL" });
    const pm = await recordManualPayment(ctx.d, { orderId: a.id, method: "PAGO_MOVIL", reference: "01341111", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: null });
    const before = captures();
    const { o: b, s, r } = await paypalTry({ ...who, email: who.email.toUpperCase() });
    expect(b.customerId).toBe(a.customerId);
    expect(r).toMatchObject({ status: "FAILED", notCaptured: "DUPLICATE" });
    expect(captures()).toBe(before); // ni se llamó a PayPal
    expect(await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } })).toMatchObject({ status: "CANCELLED", providerStatus: "NOT_CAPTURED" });
    expect((await notCaptured(b.id))[0]).toContain(`pedido #${a.number}`);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: b.id } })).amountPaidCents).toBe(0);
    expect((await attention(a.id)).at(-1)).toContain(`pedido #${b.number}`);

    // Retorno recargado / webhook repetido: sigue sin capturar.
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId, "webhook")).status).toBe("FAILED");
    expect(captures()).toBe(before);

    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    expect(await confirmedSeats(a.customerId)).toBe(1);
  });

  it("PayPal dos veces la misma cohorte → la segunda no se cobra; un solo cupo", async () => {
    const who = buyer();
    const first = await paypalPaid(who);
    const { o: second, r } = await paypalTry(who);
    expect(r).toMatchObject({ status: "FAILED", notCaptured: "DUPLICATE" });
    expect(await confirmedSeats(first.customerId)).toBe(1);
    expect((await notCaptured(second.id))[0]).toContain("tiene cupo pagado");
    expect((await attention(first.id)).at(-1)).toContain(`#${second.number}`);
  });

  it("mismo curso online dos veces → la segunda no se cobra; otro cliente, otra modalidad o tras reembolso → sí", async () => {
    const who = buyer();
    const first = await paypalPaid(who, online());
    expect((await paypalTry(who, online())).r).toMatchObject({ status: "FAILED", notCaptured: "DUPLICATE" });

    const other = await paypalPaid(buyer());
    expect(await attention(other.id)).toEqual([]);
    const semiSame = await paypalPaid(who); // misma persona, otra modalidad
    expect(await attention(semiSame.id)).toEqual([]);

    // Tras reembolsar el primero, volver a comprarlo online se cobra normalmente.
    const pay = await ctx.db.payment.findFirstOrThrow({ where: { orderId: first.id, status: "COMPLETED" } });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, reason: "Baja", unenroll: true, releaseSeat: true, idempotencyKey: "k-refund" });
    await paypalPaid(who, online());
  });

  it("si el otro pedido se paga DESPUÉS (comprobante aprobado con PayPal ya cobrado en otro pedido) → ambos avisados", async () => {
    const who = buyer();
    const a = await createCheckout(ctx.d, { customer: who, items: semi() as never, paymentMethod: "PAGO_MOVIL" });
    const b = await paypalPaid(who); // A aún sin pago registrado: B se cobra
    const pm = await recordManualPayment(ctx.d, { orderId: a.id, method: "PAGO_MOVIL", reference: "01342222", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: null });
    expect((await attention(a.id)).join("\n")).toContain(`#${b.number}`);
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    expect((await attention(a.id)).at(-1)).toContain(`cupo pagado en la cohorte`);
    expect((await attention(b.id)).at(-1)).toContain(`#${a.number}`);
  });
});
