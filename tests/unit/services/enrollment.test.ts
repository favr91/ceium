import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, startPaypalPayment } from "@/server/payments";
import { enrollOrder, reenrollOrder, retryDueEnrollments } from "@/server/enrollment";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("enrollment");
});
afterEach(async () => {
  await ctx.dispose();
});

// Plan "mitad": el primer pago matricula TODOS los cursos del diplomado (el mes a mes, curso a curso,
// está en monthly-plan.test.ts).
async function paidDiploma(email?: string) {
  const b = buyer();
  const o = await createCheckout(ctx.d, { customer: email ? { ...b, email } : b, items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "HALF" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  return o;
}

describe("enrollment", () => {
  it("diplomado: matricula en los 9 cursos con el primer pago (paga la mitad) en una sola llamada", async () => {
    const o = await paidDiploma();
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("ENROLLED");
    expect(after.amountPaidCents).toBe(47500);
    expect(after.balanceCents).toBe(95000 - 47500);
    const rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows.map((r) => r.moodleCourseId).sort()).toEqual(ctx.fx.diplomaMoodleIds);
    expect(rows.every((r) => r.status === "ENROLLED")).toBe(true);
    expect(ctx.moodle.count("enrol")).toBe(1);
    expect(ctx.moodle.calls.find((c) => c.fn === "enrol")!.args[1]).toEqual(ctx.fx.diplomaMoodleIds);
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "platform_access" } });
    expect(mail.text).toContain("Curso 9 del Diplomado");
  });

  it("idempotente: llamadas repetidas y concurrentes no vuelven a matricular", async () => {
    const o = await paidDiploma();
    await Promise.all([enrollOrder(ctx.d, o.id), enrollOrder(ctx.d, o.id), enrollOrder(ctx.d, o.id)]);
    expect(ctx.moodle.count("enrol")).toBe(1);
    expect(await ctx.db.enrollment.count()).toBe(9);
    expect(await ctx.db.emailOutbox.count({ where: { template: "platform_access" } })).toBe(1);
  });

  it("cuenta Moodle existente: se vincula y el correo NO incluye contraseña", async () => {
    await ctx.moodle.findOrCreateUser("existente@example.com", { firstname: "Ya", lastname: "Existe" });
    const o = await paidDiploma("existente@example.com");
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "platform_access" } });
    expect(mail.text).not.toContain("Contraseña temporal");
    expect(mail.text).toContain("¿Olvidó");
  });

  it("Moodle caído: backoff persistido, credenciales enviadas igual, y el job reintenta hasta matricular", async () => {
    ctx.moodle.failEnrol = 2 + 2; // 2 intentos inline (1 + 1 reintento) fallan, y el 1.er reintento del job también (2 inline)
    const o = await paidDiploma();
    let rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows.every((r) => r.status === "PENDING" && r.attempts === 1 && r.lastError?.includes("timeout"))).toBe(true);
    expect(rows[0].nextAttemptAt!.getTime() - ctx.clock.now().getTime()).toBe(60_000);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PARTIALLY_PAID"); // mitad: queda saldo
    const cred = await ctx.db.emailOutbox.findFirstOrThrow({ where: { template: "platform_access" } });
    expect(cred.text).toContain("Contraseña temporal");
    expect(cred.text).toContain("se activarán en breve");

    expect(await retryDueEnrollments(ctx.d)).toEqual({ orders: 0, enrolled: 0 }); // aún no toca
    ctx.clock.advance(61_000);
    expect(await retryDueEnrollments(ctx.d)).toEqual({ orders: 1, enrolled: 0 });
    rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].nextAttemptAt!.getTime() - ctx.clock.now().getTime()).toBe(120_000); // backoff exponencial
    ctx.clock.advance(121_000);
    expect(await retryDueEnrollments(ctx.d)).toEqual({ orders: 1, enrolled: 1 });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ENROLLED");
    const access = await ctx.db.emailOutbox.findMany({ where: { template: "platform_access" } });
    expect(access).toHaveLength(2); // credenciales + confirmación de acceso
  });

  it("tras maxAttempts queda FAILED (visible) y el admin puede rematricular", async () => {
    ctx.moodle.failEnrol = 100;
    const o = await paidDiploma();
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(3600_000);
      await retryDueEnrollments(ctx.d);
    }
    const rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows.every((r) => r.status === "FAILED" && r.attempts === 3)).toBe(true);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "ENROLLMENT_FAILED" } })).toBeGreaterThanOrEqual(3);
    ctx.moodle.failEnrol = 0;
    const r = await reenrollOrder(ctx.d, ctx.fx.admin, o.id);
    expect(r.status).toBe("ENROLLED");
  });

  it("no matricula pedidos sin pago confirmado", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    expect((await enrollOrder(ctx.d, o.id)).status).toBe("SKIPPED");
    expect(ctx.moodle.count("enrol")).toBe(0);
  });
});
