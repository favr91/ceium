// Crítico x3 (riesgo abierto): la protección contra doble envío (reusePendingTwin) solo estaba probada en SQLite,
// donde toda escritura serializa la BD. En Postgres (READ COMMITTED) dos sesiones distintas con el mismo correo
// podían leer «no hay pedido gemelo» a la vez, porque nada bloqueaba la fila del cliente antes de buscarlo.
// Contrato: dentro de la transacción del checkout se ESCRIBE la fila del cliente existente (UPDATE real con
// updatedAt, que en Postgres toma el candado de fila hasta el commit) ANTES de consultar sus pedidos pendientes.
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createCheckout } from "@/server/orders";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x3twinlock");
});
afterEach(async () => {
  await ctx.dispose();
});

it("cliente existente: UPDATE (candado) de su fila antes de buscar el pedido gemelo, y el UPDATE escribe de verdad", async () => {
  const b = buyer();
  const input = { customer: b, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL" as const, cohortId: ctx.fx.courseCohort, planKind: "FULL" as const }], paymentMethod: "PAYPAL" as const, reusePendingTwin: true };
  const first = await createCheckout(ctx.d, input);
  const before = await ctx.db.customer.findUniqueOrThrow({ where: { id: first.customerId }, select: { updatedAt: true } });

  const log: { model?: string; op: string; args: unknown }[] = [];
  const traced = ctx.db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          log.push({ model, op: operation, args });
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
  ctx.clock.advance(5_000);
  const again = await createCheckout(ctx.makeDeps(traced), input);
  expect(again.id).toBe(first.id);

  const lockAt = log.findIndex((e) => e.model === "Customer" && (e.op === "update" || e.op === "updateMany"));
  const twinAt = log.findIndex((e) => e.model === "Order" && e.op === "findMany");
  expect(lockAt, JSON.stringify(log.map((e) => `${e.model}.${e.op}`))).toBeGreaterThanOrEqual(0);
  expect(twinAt).toBeGreaterThan(lockAt);
  expect((log[lockAt].args as { data: Record<string, unknown> }).data).toHaveProperty("updatedAt");
  const after = await ctx.db.customer.findUniqueOrThrow({ where: { id: first.customerId }, select: { updatedAt: true } });
  expect(after.updatedAt.getTime()).not.toBe(before.updatedAt.getTime());
  expect(after.updatedAt.getTime()).toBe(ctx.clock.now().getTime());
  expect(await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort }, select: { seatsHeld: true } })).toEqual({ seatsHeld: 1 });
}, 60_000);
