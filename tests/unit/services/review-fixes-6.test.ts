// Sexta revisión: un pedido con dinero cobrado que no alcanza el primer pago (PENDING_PAYMENT con
// amountPaidCents > 0) no pierde su cupo, queda marcado (ATTENTION + cola del panel) y el saldo de un pedido
// reembolsado o cancelado es 0.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/auth";
import { cancelOrder, createCheckout, expireStaleOrders, listUnderpaidOrders } from "@/server/orders";
import { expireStaleReservations, getCohortAvailability } from "@/server/seats";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, refundPayment, startPaypalPayment } from "@/server/payments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("review6");
});
afterEach(async () => {
  await ctx.dispose();
});

const HOUR = 60 * 60 * 1000;

const semiCourse = (n: number, method: "PAYPAL" | "PAGO_MOVIL" = "PAGO_MOVIL") =>
  createCheckout(ctx.d, { customer: buyer(n), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: method });

/** Pago móvil aprobado por la mitad del primer pago (tasa de la configuración: 100 Bs/USD). */
async function underpaid(n = 1) {
  const o = await semiCourse(n);
  const half = Math.floor(o.dueNowCents / 2);
  const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: `UP-${n}`, amountCents: half * 100, currency: "VES" });
  await adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p.id, decision: "approve" });
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
  expect(order.status).toBe("PENDING_PAYMENT");
  expect(order.amountPaidCents).toBe(half);
  return { o, half };
}

describe("pago insuficiente aprobado: el cupo no se libera ni se revende", () => {
  it("tras vencer la reserva, ni el job ni la limpieza al reservar liberan el cupo; la disponibilidad lo cuenta", async () => {
    const { o } = await underpaid(1);
    ctx.clock.advance(80 * HOUR);
    expect(await expireStaleReservations(ctx.d)).toBe(0);
    expect(await expireStaleOrders(ctx.d)).toBe(0);
    const res = await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItem: { orderId: o.id } } });
    expect(res.status).toBe("HELD");
    const av = await getCohortAvailability(ctx.d, ctx.fx.courseCohort);
    expect(av.held).toBe(1);
    // Capacidad 3: dos compras más llenan la cohorte; la cuarta no puede quitarle el cupo al pedido con dinero.
    await semiCourse(2);
    await semiCourse(3);
    await expect(semiCourse(4)).rejects.toMatchObject({ code: "SOLD_OUT" });
    const cohort = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(cohort.seatsHeld + cohort.seatsConfirmed).toBe(3);
  });

  it("cuando el cliente paga la diferencia, confirma su cupo aunque la cohorte esté llena", async () => {
    const { o, half } = await underpaid(1);
    ctx.clock.advance(80 * HOUR);
    await expireStaleReservations(ctx.d);
    await semiCourse(2);
    await semiCourse(3);
    const rest = o.dueNowCents - half;
    const p2 = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "UP-REST", amountCents: rest * 100, currency: "VES" });
    await adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p2.id, decision: "approve" });
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(["PAID", "ENROLLED"]).toContain(order.status);
    const res = await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItem: { orderId: o.id } } });
    expect(res.status).toBe("CONFIRMED");
  });
});

describe("pago insuficiente: queda visible para el staff", () => {
  it("ATTENTION al aprobarlo, otro (uno solo) al vencer el plazo, y aparece en la cola del panel", async () => {
    const { o, half } = await underpaid(1);
    const att = () => ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "ATTENTION" }, orderBy: { createdAt: "asc" } });
    expect((await att()).length).toBe(1);
    expect((await att())[0].note).toMatch(/Pago insuficiente/);

    let queue = await listUnderpaidOrders(ctx.d, ctx.fx.staff);
    expect(queue.map((r) => r.id)).toEqual([o.id]);
    expect(queue[0]).toMatchObject({ amountPaidCents: half, missingCents: o.dueNowCents - half, overdue: false, status: "PENDING_PAYMENT" });

    ctx.clock.advance(80 * HOUR);
    await expireStaleOrders(ctx.d);
    await expireStaleOrders(ctx.d);
    const events = await att();
    expect(events.length).toBe(2);
    expect(events[1].note).toMatch(/Venció el plazo de pago con un pago parcial/);
    queue = await listUnderpaidOrders(ctx.d, ctx.fx.staff);
    expect(queue[0].overdue).toBe(true);

    await expect(listUnderpaidOrders(ctx.d, null as unknown as SessionUser)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("un pedido sin dinero cobrado sigue venciendo y liberando su cupo", async () => {
    const o = await semiCourse(1);
    ctx.clock.advance(80 * HOUR);
    expect(await expireStaleOrders(ctx.d)).toBe(1);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("EXPIRED");
    const res = await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItem: { orderId: o.id } } });
    expect(res.status).toBe("RELEASED");
  });
});

describe("saldo de pedidos cerrados", () => {
  it("un reembolso total deja el pedido REFUNDED con balanceCents = 0", async () => {
    const o = await semiCourse(1, "PAYPAL");
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: s.paymentId });
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(order.status).toBe("REFUNDED");
    expect(order.balanceCents).toBe(0);
  });

  it("un pedido cancelado queda con balanceCents = 0", async () => {
    const o = await semiCourse(1);
    await cancelOrder(ctx.d, ctx.fx.staff, o.id, "duplicado");
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(order.status).toBe("CANCELLED");
    expect(order.balanceCents).toBe(0);
  });
});
