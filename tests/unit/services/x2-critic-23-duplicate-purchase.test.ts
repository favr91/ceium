// x2 critic 23: el MISMO cliente paga dos pedidos de la MISMA cohorte (o del mismo curso online). Antes nada lo
// marcaba: dos cobros y dos cupos para una sola cuenta de Moodle sin que el staff se enterara. Ahora, al confirmarse
// el primer pago, ambos pedidos quedan con un ATTENTION que nombra al otro (flagDuplicatePurchase).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, startPaypalPayment } from "@/server/payments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-23-duplicate");
});
afterEach(async () => {
  await ctx.dispose();
});

const attention = async (orderId: string) => (await ctx.db.orderEvent.findMany({ where: { orderId, type: "ATTENTION" }, orderBy: { createdAt: "asc" } })).map((e) => e.note ?? "");
const semi = () => [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL" as const, cohortId: ctx.fx.courseCohort, planKind: "FULL" as const }];
async function paypalPaid(customer: ReturnType<typeof buyer>, items = semi()) {
  const o = await createCheckout(ctx.d, { customer, items, paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  expect((await capturePaypalReturn(ctx.d, s.paypalOrderId)).status).toBe("COMPLETED");
  return o;
}

describe("compra duplicada del mismo cliente", () => {
  it("pago móvil en verificación + recompra con PayPal de la misma cohorte → ambos avisados antes de aprobar; aprobar avisa otra vez", async () => {
    const who = buyer();
    const a = await createCheckout(ctx.d, { customer: who, items: semi(), paymentMethod: "PAGO_MOVIL" });
    const pm = await recordManualPayment(ctx.d, { orderId: a.id, method: "PAGO_MOVIL", reference: "01341111", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: null });
    const b = await paypalPaid({ ...who, email: who.email.toUpperCase() });
    expect(b.customerId).toBe(a.customerId);

    expect(await attention(a.id)).toEqual([expect.stringContaining(`pedido #${b.number}`)]);
    expect((await attention(a.id))[0]).toContain("No apruebes el comprobante");
    expect(await attention(b.id)).toEqual([expect.stringContaining(`pedido #${a.number} con cupo reservado`)]);

    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    const after = await attention(a.id);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain(`cupo pagado en la cohorte`);
    expect(after[1]).toContain(`#${b.number}`);
    expect((await attention(b.id)).at(-1)).toContain(`pedido #${a.number}`);
  });

  it("dos veces el mismo curso online con PayPal → avisado; otro cliente, otra modalidad o un pedido reembolsado → sin aviso", async () => {
    const online = [{ productId: ctx.fx.course, modality: "ONLINE" as const, planKind: "FULL" as const }];
    const who = buyer();
    const first = await paypalPaid(who, online);
    const second = await paypalPaid(who, online);
    expect(await attention(second.id)).toEqual([expect.stringContaining(`pedido #${first.number}`)]);
    expect(await attention(first.id)).toEqual([expect.stringContaining(`pedido #${second.number}`)]);

    // Otro cliente en la misma cohorte y el mismo cliente en la otra modalidad: nada.
    const other = await paypalPaid(buyer());
    expect(await attention(other.id)).toEqual([]);
    const semiSame = await paypalPaid(who);
    expect(await attention(semiSame.id)).toEqual([]);
  });
});
