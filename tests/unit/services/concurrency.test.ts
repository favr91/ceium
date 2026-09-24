// Varios PROCESOS contra el mismo archivo SQLite (p.ej. `npm run dev` + `npm run jobs`): ningún checkout
// debe fallar por contención (P1008 / SQLITE_BUSY) mientras haya cupo, y nunca hay sobreventa.
import { execFile } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout, getOrder } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, startPaypalPayment } from "@/server/payments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("concurrency");
});
afterEach(async () => {
  await ctx.dispose();
});

type Out = { ok: number; soldOut: number; errors: string[] };
function runWorkers(processes: number, perProcess: number): Promise<Out[]> {
  const worker = path.join(__dirname, "helpers", "checkout-race-worker.ts");
  const tsx = path.resolve(__dirname, "../../../node_modules/.bin/tsx");
  return Promise.all(
    Array.from({ length: processes }, (_, w) =>
      new Promise<Out>((resolve, reject) => {
        execFile(tsx, [worker, ctx.url, ctx.fx.course, ctx.fx.courseCohort, String(perProcess), `p${w}`], { cwd: path.resolve(__dirname, "../../..") }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`${err.message}\n${stderr}`));
          resolve(JSON.parse(stdout.trim().split("\n").pop()!));
        });
      }),
    ),
  );
}

describe("checkout concurrente entre procesos (misma BD SQLite)", () => {
  it("3 procesos × 6 checkouts con 50 cupos → los 18 se crean, sin errores de contención", async () => {
    await ctx.db.cohort.update({ where: { id: ctx.fx.courseCohort }, data: { capacity: 50 } });
    const out = await runWorkers(3, 6);
    expect(out.flatMap((o) => o.errors)).toEqual([]);
    expect(out.reduce((a, o) => a + o.ok, 0)).toBe(18);
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(c.seatsHeld).toBe(18);
    expect(await ctx.db.order.count()).toBe(18);
    const numbers = (await ctx.db.order.findMany({ select: { number: true } })).map((o) => o.number);
    expect(new Set(numbers).size).toBe(18);
    // los correos compartidos entre procesos producen UN cliente cada uno
    expect(await ctx.db.customer.count({ where: { email: { startsWith: "shared" } } })).toBe(3);
  }, 120_000);

  it("4 procesos × 5 checkouts con 3 cupos → 3 reservas y 17 SOLD_OUT, ningún error crudo", async () => {
    const out = await runWorkers(4, 5);
    expect(out.flatMap((o) => o.errors)).toEqual([]);
    expect(out.reduce((a, o) => a + o.ok, 0)).toBe(3);
    expect(out.reduce((a, o) => a + o.soldOut, 0)).toBe(17);
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(c.seatsHeld).toBe(3);
  }, 120_000);
});

describe("confirmaciones simultáneas del mismo pedido (sin actualizaciones perdidas)", () => {
  it("dos cuotas aprobadas a la vez desde dos conexiones → amountPaid y cuotas suman ambas", async () => {
    const o = await createCheckout(ctx.d, {
      customer: buyer(),
      items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind: "MONTHLY" }],
      paymentMethod: "PAYPAL",
    });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const p1 = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "A-1", amountCents: 18000, currency: "USD" });
    const p2 = await recordManualPayment(ctx.d, { orderId: o.id, method: "TRANSFERENCIA", reference: "B-2", amountCents: 18000, currency: "USD" });
    // dos conexiones (como dos instancias de la app) con espera real entre reintentos
    const other = ctx.extraClient();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    try {
      await Promise.all([
        adminVerifyPayment({ ...ctx.d, sleep }, { paymentId: p1.id, decision: "approve", adminId: ctx.fx.adminId }),
        adminVerifyPayment({ ...ctx.makeDeps(other), sleep }, { paymentId: p2.id, decision: "approve", adminId: ctx.fx.adminId }),
      ]);
    } finally {
      await other.$disconnect();
    }
    const after = await getOrder(ctx.d, o.id);
    expect([after.amountPaidCents, after.balanceCents]).toEqual([3 * 18000, 6 * 18000]);
    expect(after.installments.map((i) => i.status)).toEqual(["PAID", "PAID", "PAID", ...Array(6).fill("PENDING")]);
  }, 30_000);
});
