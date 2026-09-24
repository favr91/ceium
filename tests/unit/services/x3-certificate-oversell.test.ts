// Pieza x3 (servicios): cupo sin sobreventa con 40 checkouts simultáneos mezclando PayPal y pago manual, aviso
// «Sin cupo» del carrito, barrido de reservas vencidas por método, y certificado emitido una sola vez aunque el
// job corra en paralelo (misma conexión y otra conexión = otro proceso), nunca con saldo pendiente.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout, expireStaleOrders } from "@/server/orders";
import { expireStaleReservations } from "@/server/seats";
import { capturePaypalReturn, startPaypalPayment } from "@/server/payments";
import { runCertificateSweep } from "@/server/certificates";
import { resolveCart } from "@/server/cart";
import { isDomainError } from "@/server/errors";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

const MIN = 60_000;
let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x3");
});
afterEach(async () => {
  await ctx.dispose();
});

describe("cupo: 40 checkouts simultáneos por 3 cupos (PayPal + pago móvil)", () => {
  it("exactamente 3 pedidos; 37 SOLD_OUT sin pedido ni cliente; el barrido libera cada reserva al vencer SU plazo", async () => {
    const cohortId = ctx.fx.courseCohort; // capacidad 3
    const attempts = Array.from({ length: 40 }, (_, i) => ({ i, method: (i % 2 ? "PAGO_MOVIL" : "PAYPAL") as "PAYPAL" | "PAGO_MOVIL", b: buyer(9000 + i) }));
    const out = await Promise.all(
      attempts.map(async (a) => {
        try {
          const o = await createCheckout(ctx.d, { customer: a.b, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId, planKind: "FULL" }], paymentMethod: a.method });
          return { ...a, orderId: o.id as string | null, error: null as string | null };
        } catch (e) {
          if (!isDomainError(e, "SOLD_OUT")) throw e;
          return { ...a, orderId: null, error: e.message };
        }
      }),
    );
    const ok = out.filter((o) => o.orderId);
    expect(ok).toHaveLength(3);
    expect(out.filter((o) => o.error)).toHaveLength(37);
    expect(await ctx.db.cohort.findUniqueOrThrow({ where: { id: cohortId }, select: { seatsHeld: true, seatsConfirmed: true } })).toEqual({ seatsHeld: 3, seatsConfirmed: 0 });
    expect(await ctx.db.seatReservation.count({ where: { cohortId } })).toBe(3);
    expect(await ctx.db.order.count()).toBe(3);
    const losers = out.filter((o) => o.error).map((o) => o.b.email.toLowerCase());
    expect(await ctx.db.customer.count({ where: { email: { in: losers } } })).toBe(0);

    // El carrito de cualquiera que la tenga elegida la marca «Sin cupo» y bloquea el checkout.
    const cart = await resolveCart({ db: ctx.db, now: ctx.clock.now }, [{ key: "k", productId: ctx.fx.course, modality: "SEMIPRESENCIAL", sedeId: ctx.fx.sedes.bqto, cohortId, choiceId: null, planKind: "FULL" }]);
    expect(cart.blocked).toBe(true);
    expect(cart.lines[0].error).toMatch(/^Sin cupo\./);

    // Barrido: a los 29 min nada; a los 31 min solo las de PayPal; a las 72 h + 1 min, las manuales.
    const status = async () => Object.fromEntries((await ctx.db.seatReservation.findMany({ where: { cohortId }, include: { order: true } })).map((r) => [r.order.paymentMethod + ":" + r.orderId, r.status]));
    const sweep = async () => {
      await expireStaleOrders(ctx.d);
      await expireStaleReservations(ctx.d);
    };
    ctx.clock.advance(29 * MIN);
    await sweep();
    expect(Object.values(await status()).every((s) => s === "HELD")).toBe(true);
    ctx.clock.advance(2 * MIN);
    await sweep();
    for (const [k, s] of Object.entries(await status())) expect(s, k).toBe(k.startsWith("PAYPAL") ? "RELEASED" : "HELD");
    const paypalWinners = ok.filter((o) => o.method === "PAYPAL").length;
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: cohortId } })).seatsHeld).toBe(3 - paypalWinners);
    ctx.clock.advance(72 * 60 * MIN - 31 * MIN - MIN);
    await sweep();
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: cohortId } })).seatsHeld).toBe(3 - paypalWinners);
    ctx.clock.advance(2 * MIN);
    await sweep();
    await sweep(); // repetir no descuenta de más
    expect(Object.values(await status()).every((s) => s === "RELEASED")).toBe(true);
    expect(await ctx.db.cohort.findUniqueOrThrow({ where: { id: cohortId }, select: { seatsHeld: true, seatsConfirmed: true } })).toEqual({ seatsHeld: 0, seatsConfirmed: 0 });
    expect(await ctx.db.order.count({ where: { status: "EXPIRED" } })).toBe(3);
  }, 60_000);
});

describe("certificado: job en paralelo y saldo pendiente", () => {
  async function enrolled(planKind: "FULL" | "HALF") {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    return { orderId: o.id, customerId: c.id, moodleUserId: c.moodleUserId! };
  }

  it("8/9 → nada; 9/9 → 6 barridos simultáneos (2 conexiones) emiten UN certificado, UN correo, UN evento", async () => {
    const a = await enrolled("FULL");
    for (const id of ctx.fx.diplomaMoodleIds.slice(0, 8)) ctx.moodle.markCompleted(a.moodleUserId, id);
    await Promise.all([runCertificateSweep(ctx.d), runCertificateSweep(ctx.d)]);
    expect(await ctx.db.certificate.count()).toBe(0);
    expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } })).toBe(0);

    ctx.moodle.markCompleted(a.moodleUserId, ctx.fx.diplomaMoodleIds[8]);
    // Otra conexión = otra instancia (proceso) de la app; espera real entre reintentos por el lock de SQLite.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const here = { ...ctx.d, sleep };
    const other = { ...ctx.makeDeps(ctx.extraClient()), sleep };
    const runs = await Promise.all([here, other, here, other, here, other].map((d) => runCertificateSweep(d))).finally(() => other.db.$disconnect());
    expect(runs.reduce((n, r) => n + r.issued, 0)).toBe(1);
    expect(await ctx.db.certificate.count()).toBe(1);
    expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } })).toBe(1);
    expect(await ctx.db.orderEvent.count({ where: { orderId: a.orderId, type: "CERTIFICATE_ISSUED" } })).toBe(1);
    const cert = await ctx.db.certificate.findFirstOrThrow();
    expect(cert.pdfPath).toBeTruthy();
    expect(cert.emailedAt).not.toBeNull();
  }, 60_000);

  it("saldo pendiente (paga la mitad) con 9/9 completos: ningún barrido lo emite", async () => {
    const h = await enrolled("HALF");
    const o = await ctx.db.order.findUniqueOrThrow({ where: { id: h.orderId } });
    expect(o.status).toBe("ENROLLED");
    expect(o.balanceCents).toBeGreaterThan(0);
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(h.moodleUserId, id);
    for (let i = 0; i < 3; i++) await Promise.all([runCertificateSweep(ctx.d), runCertificateSweep(ctx.d)]);
    ctx.clock.advance(400 * 24 * 60 * MIN); // ni con el tiempo
    await runCertificateSweep(ctx.d);
    expect(await ctx.db.certificate.count()).toBe(0);
    expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } })).toBe(0);
  }, 60_000);
});
