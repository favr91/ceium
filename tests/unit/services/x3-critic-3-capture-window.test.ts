// x3 (crítico 3): la reserva PayPal vence justo cuando el comprador vuelve de PayPal. Mientras la app captura (llamada
// de red), el barrido de reservas / el vencimiento de pedidos / otro comprador (liberación perezosa) soltaban la
// reserva HELD vencida y revendían el cupo → la captura se cobraba igual y el pedido quedaba PAGADO sin cupo
// (SEAT_UNAVAILABLE). secureSeatBeforeCapture ahora aparta la reserva y el pedido durante la ventana de captura.
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCheckout, expireStaleOrders } from "@/server/orders";
import { expireStaleReservations } from "@/server/seats";
import { capturePaypalReturn, startPaypalPayment } from "@/server/payments";
import { isDomainError } from "@/server/errors";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

const MIN = 60_000;
let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x3-critic-3-capture-window");
});
afterEach(async () => {
  await ctx.dispose();
});

async function fillCohort(except: number) {
  // Deja la cohorte (capacidad 3) con `except` cupos libres, ocupados por pedidos manuales vivos (72 h).
  const cap = (await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } })).capacity;
  for (let i = 0; i < cap - 1 - except; i++) {
    await createCheckout(ctx.d, { customer: buyer(7100 + i), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  }
}

for (const intruder of ["barrido de reservas", "vencimiento de pedidos", "otro comprador"] as const) {
  it(`reserva vencida al volver de PayPal + ${intruder} durante la captura: el cupo no se revende y el pago queda con cupo`, async () => {
    await fillCohort(0);
    const a = await createCheckout(ctx.d, { customer: buyer(7200), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const ppId = (await startPaypalPayment(ctx.d, a.id)).paypalOrderId;
    ctx.paypal.approve(ppId);
    ctx.clock.advance(31 * MIN); // la reserva (30 min) y el pedido ya vencieron, sin barrer

    let intruderResult: string | null = null;
    const real = ctx.paypal.captureOrder.bind(ctx.paypal);
    ctx.paypal.captureOrder = async (id: string) => {
      // En plena captura (red) entra el intruso.
      if (intruder === "barrido de reservas") intruderResult = `liberadas ${await expireStaleReservations(ctx.d)}`;
      else if (intruder === "vencimiento de pedidos") intruderResult = `vencidos ${await expireStaleOrders(ctx.d)}`;
      else {
        try {
          await createCheckout(ctx.d, { customer: buyer(7300), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
          intruderResult = "compró";
        } catch (e) {
          if (!isDomainError(e, "SOLD_OUT")) throw e;
          intruderResult = "sin cupo";
        }
      }
      return real(id);
    };
    const r = await capturePaypalReturn(ctx.d, ppId);
    expect(r.status).toBe("COMPLETED");
    expect(intruderResult).toMatch(/liberadas 0|vencidos 0|sin cupo/);

    const o = await ctx.db.order.findUniqueOrThrow({ where: { id: a.id }, include: { reservations: true, events: true } });
    expect(["PAID", "ENROLLED"]).toContain(o.status);
    expect(o.reservations.map((x) => x.status)).toEqual(["CONFIRMED"]);
    expect(o.events.map((e) => e.type)).not.toContain("SEAT_UNAVAILABLE");
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
    expect(c.seatsConfirmed).toBe(await ctx.db.seatReservation.count({ where: { cohortId: c.id, status: "CONFIRMED" } }));
    expect(c.seatsHeld).toBe(await ctx.db.seatReservation.count({ where: { cohortId: c.id, status: "HELD" } }));
  });
}
