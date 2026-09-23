import { execFile } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { withTx, MINUTE, HOUR } from "@/server/deps";
import { isDomainError } from "@/server/errors";
import { createCheckout } from "@/server/orders";
import { confirmReservation, expireStaleReservations, getCohortAvailability, releaseReservation, reserveSeat } from "@/server/seats";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("seats");
});
afterEach(async () => {
  await ctx.dispose();
});

async function cohort(id = ctx.fx.courseCohort) {
  return ctx.db.cohort.findUniqueOrThrow({ where: { id } });
}

/** Pedido "vacío" para colgar reservas en tests de bajo nivel. */
async function bareOrder(db: PrismaClient, n: number) {
  const c = await db.customer.create({ data: { email: `bare${n}@x.com`, firstName: "A", lastName: "B" } });
  return db.order.create({ data: { number: 5000 + n, token: `tok-${n}`, customerId: c.id, subtotalCents: 1, totalCents: 1, dueNowCents: 1 } });
}

describe("seats: reserva atómica", () => {
  it("50 compradores compitiendo por 3 cupos (misma conexión) → exactamente 3 pedidos, sin sobreventa", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        createCheckout(ctx.d, {
          customer: buyer(100 + i),
          items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }],
          paymentMethod: "PAYPAL",
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(47);
    for (const f of failed) expect(isDomainError(f.reason, "SOLD_OUT")).toBe(true);

    const c = await cohort();
    expect(c.seatsHeld + c.seatsConfirmed).toBe(3);
    expect(await ctx.db.seatReservation.count({ where: { cohortId: c.id, status: "HELD" } })).toBe(3);
    // Nada huérfano: los 47 rechazos no dejaron pedidos ni clientes a medias.
    expect(await ctx.db.order.count()).toBe(3);
    const numbers = (await ctx.db.order.findMany({ select: { number: true } })).map((o) => o.number).sort();
    expect(new Set(numbers).size).toBe(3);
  });

  it("50 compradores repartidos en 5 PROCESOS distintos (5 instancias de la app) → exactamente 3 reservas", async () => {
    const orders = await Promise.all(Array.from({ length: 50 }, (_, i) => bareOrder(ctx.db, i)));
    const worker = path.join(__dirname, "helpers", "race-worker.ts");
    const tsx = path.resolve(__dirname, "../../../node_modules/.bin/tsx");
    const runs = Array.from({ length: 5 }, (_, w) =>
      new Promise<{ ok: number; soldOut: number; errors: string[] }>((resolve, reject) => {
        const ids = orders.filter((_, i) => i % 5 === w).map((o) => o.id);
        execFile(tsx, [worker, ctx.url, ctx.fx.courseCohort, ...ids], { cwd: path.resolve(__dirname, "../../..") }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`${err.message}\n${stderr}`));
          resolve(JSON.parse(stdout.trim().split("\n").pop()!));
        });
      }),
    );
    const out = await Promise.all(runs);
    expect(out.flatMap((o) => o.errors)).toEqual([]);
    expect(out.reduce((a, o) => a + o.ok, 0)).toBe(3);
    expect(out.reduce((a, o) => a + o.soldOut, 0)).toBe(47);
    const c = await cohort();
    expect(c.seatsHeld).toBe(3);
    expect(await ctx.db.seatReservation.count({ where: { cohortId: c.id } })).toBe(3);
  }, 120_000);

  it("las reservas vencidas no cuentan: se liberan al reservar y el cupo se reutiliza", async () => {
    const orders = await Promise.all([0, 1, 2, 3].map((i) => bareOrder(ctx.db, i)));
    for (const o of orders.slice(0, 3)) await withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: o.id, ttlMs: 30 * MINUTE, now: ctx.clock.now() }));
    await expect(withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: orders[3].id, ttlMs: 30 * MINUTE, now: ctx.clock.now() }))).rejects.toMatchObject({ code: "SOLD_OUT" });
    ctx.clock.advance(31 * MINUTE);
    expect((await getCohortAvailability(ctx.d, ctx.fx.courseCohort)).available).toBe(3);
    const r = await withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: orders[3].id, ttlMs: 30 * MINUTE, now: ctx.clock.now() }));
    expect(r.status).toBe("HELD");
    const c = await cohort();
    expect(c.seatsHeld).toBe(1);
    expect(await ctx.db.seatReservation.count({ where: { status: "RELEASED", releasedReason: "EXPIRED" } })).toBe(3);
  });

  it("confirm mueve HELD→CONFIRMED; release devuelve el cupo; ambos idempotentes", async () => {
    const o = await bareOrder(ctx.db, 1);
    const r = await withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: o.id, ttlMs: HOUR, now: ctx.clock.now() }));
    expect(await withTx(ctx.d, (tx) => confirmReservation(tx, r.id, ctx.clock.now()))).toEqual({ ok: true, reacquired: false });
    expect(await withTx(ctx.d, (tx) => confirmReservation(tx, r.id, ctx.clock.now()))).toEqual({ ok: true, reacquired: false });
    let c = await cohort();
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([0, 1]);
    expect(await withTx(ctx.d, (tx) => releaseReservation(tx, r.id, "REFUNDED", ctx.clock.now()))).toBe(true);
    expect(await withTx(ctx.d, (tx) => releaseReservation(tx, r.id, "REFUNDED", ctx.clock.now()))).toBe(false);
    c = await cohort();
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([0, 0]);
  });

  it("pago tardío: reserva vencida se vuelve a tomar si hay cupo, y falla si la cohorte se llenó", async () => {
    const orders = await Promise.all([0, 1, 2, 3].map((i) => bareOrder(ctx.db, i)));
    const late = await withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: orders[0].id, ttlMs: 30 * MINUTE, now: ctx.clock.now() }));
    ctx.clock.advance(HOUR);
    expect(await expireStaleReservations(ctx.d)).toBe(1);
    const back = await withTx(ctx.d, (tx) => confirmReservation(tx, late.id, ctx.clock.now()));
    expect(back).toEqual({ ok: true, reacquired: true });
    for (const o of orders.slice(1, 3)) await withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: o.id, ttlMs: HOUR, now: ctx.clock.now() }));
    // cohorte llena (1 confirmado + 2 retenidos). Liberar el confirmado y ocupar su lugar con otro:
    await withTx(ctx.d, (tx) => releaseReservation(tx, late.id, "REFUNDED", ctx.clock.now()));
    await withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: orders[3].id, ttlMs: HOUR, now: ctx.clock.now() }));
    const again = await withTx(ctx.d, (tx) => confirmReservation(tx, late.id, ctx.clock.now()));
    expect(again).toEqual({ ok: false, reason: "NO_CAPACITY" });
    const c = await cohort();
    expect(c.seatsHeld + c.seatsConfirmed).toBe(3);
  });

  it("cohorte cerrada o con plazo vencido no se puede reservar", async () => {
    const o = await bareOrder(ctx.db, 1);
    await ctx.db.cohort.update({ where: { id: ctx.fx.courseCohort }, data: { status: "CLOSED" } });
    await expect(withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: o.id, ttlMs: HOUR, now: ctx.clock.now() }))).rejects.toMatchObject({ code: "COHORT_UNAVAILABLE" });
    await ctx.db.cohort.update({ where: { id: ctx.fx.courseCohort }, data: { status: "OPEN", enrollmentDeadline: new Date(ctx.clock.now().getTime() - 1000) } });
    await expect(withTx(ctx.d, (tx) => reserveSeat(tx, { cohortId: ctx.fx.courseCohort, orderId: o.id, ttlMs: HOUR, now: ctx.clock.now() }))).rejects.toMatchObject({ code: "COHORT_UNAVAILABLE" });
    expect((await cohort()).seatsHeld).toBe(0);
  });
});
