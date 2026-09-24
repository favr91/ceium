import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR, withTx } from "@/server/deps";
import { quote } from "@/server/quote";
import { canTransition, cancelOrder, createCheckout, expireStaleOrders, ORDER_TRANSITIONS, transitionOrder } from "@/server/orders";
import { adjustBalance, reassignCohort } from "@/server/corrections";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("orders");
});
afterEach(async () => {
  await ctx.dispose();
});

describe("pricing.quote", () => {
  it("diplomado semipresencial Barquisimeto: FULL 10% / HALF 5% / MONTHLY 9 cursos × $180", async () => {
    const base = { productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL" as const, sedeId: ctx.fx.sedes.bqto };
    const full = await quote(ctx.db, { ...base, planKind: "FULL" }, ctx.clock.now());
    expect([full.listCents, full.discountCents, full.totalCents, full.dueNowCents]).toEqual([142000, 14200, 127800, 127800]);
    expect(full.installments).toHaveLength(1);
    const half = await quote(ctx.db, { ...base, planKind: "HALF" }, ctx.clock.now());
    expect([half.totalCents, half.dueNowCents]).toEqual([134900, 67450]);
    expect(half.installments.map((i) => i.amountCents)).toEqual([67450, 67450]);
    expect(half.planLabel).toBe("Paga la midad (5% de descuento)");
    const monthly = await quote(ctx.db, { ...base, planKind: "MONTHLY" }, ctx.clock.now());
    expect(monthly.dueNowCents).toBe(18000);
    // SPEC: una cuota por curso del diplomado (9), cada una al precio publicado de "Paga mes a mes".
    expect(monthly.installments).toHaveLength(9);
    expect(monthly.installments.every((i) => i.amountCents === 18000)).toBe(true);
    expect(monthly.totalCents).toBe(9 * 18000);
    expect([monthly.listCents, monthly.discountCents]).toEqual([9 * 18000, 0]);
    // cuota k ↔ curso k del diplomado, en orden
    expect(monthly.installments.map((i) => i.course?.productId)).toEqual(ctx.fx.diplomaCourses);
    expect(monthly.installments.map((i) => i.course?.moodleCourseId)).toEqual(ctx.fx.diplomaMoodleIds);
    expect(monthly.installments[1].dueDate.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("online ignora la sede; errores claros para combinaciones inválidas", async () => {
    const q = await quote(ctx.db, { productId: ctx.fx.course, modality: "ONLINE", sedeId: ctx.fx.sedes.ccs, planKind: "FULL" });
    expect([q.sedeId, q.totalCents]).toEqual([null, 10000]);
    await expect(quote(ctx.db, { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", sedeId: ctx.fx.sedes.mcbo, planKind: "FULL" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(quote(ctx.db, { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", planKind: "FULL" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(quote(ctx.db, { productId: ctx.fx.course, modality: "ONLINE", planKind: "MONTHLY" })).rejects.toMatchObject({ code: "VALIDATION" });
    await ctx.db.product.update({ where: { id: ctx.fx.course }, data: { published: false } });
    await expect(quote(ctx.db, { productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("orders.createCheckout", () => {
  it("crea cliente, pedido, ítem, cuotas, reserva y evento; normaliza el email; numeración desde 1001", async () => {
    const o = await createCheckout(ctx.d, {
      customer: { ...buyer(1), email: "  Ana.Perez@Gmail.COM " },
      items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind: "HALF" }],
      paymentMethod: "PAGO_MOVIL",
    });
    expect(o.number).toBe(1001);
    expect(o.customer.email).toBe("ana.perez@gmail.com");
    expect(o.status).toBe("PENDING_PAYMENT");
    expect([o.totalCents, o.dueNowCents, o.balanceCents, o.amountPaidCents]).toEqual([134900, 67450, 134900, 0]);
    expect(o.items[0].sedeId).toBe(ctx.fx.sedes.bqto);
    expect(o.items[0].reservation?.status).toBe("HELD");
    expect(o.expiresAt!.getTime() - ctx.clock.now().getTime()).toBe(72 * HOUR);
    expect(o.installments.map((i) => i.amountCents)).toEqual([67450, 67450]);
    const ev = await ctx.db.orderEvent.findMany({ where: { orderId: o.id } });
    expect(ev.map((e) => e.type)).toContain("CREATED");
    // correo con datos de pago móvil y monto en Bs.
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "order_confirmation" } });
    expect(mail.subject).toBe("Recibimos tu pedido #1001");
    expect(mail.html).toContain("Banesco (0134)");
    expect(mail.text).toContain("Bs. 67.450,00");
    const o2 = await createCheckout(ctx.d, { customer: buyer(2), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    expect(o2.number).toBe(1002);
    expect(o2.expiresAt!.getTime() - ctx.clock.now().getTime()).toBe(30 * 60_000);
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o2.id } })).toBe(0); // PayPal: se confirma al pagar
  });

  it("rechaza cohorte de otro programa, sede incoherente, método deshabilitado, email inválido", async () => {
    const item = { productId: ctx.fx.course, modality: "SEMIPRESENCIAL" as const, cohortId: ctx.fx.diplomaCohort, planKind: "FULL" as const };
    await expect(createCheckout(ctx.d, { customer: buyer(), items: [item], paymentMethod: "PAYPAL" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createCheckout(ctx.d, { customer: buyer(), items: [{ ...item, cohortId: ctx.fx.courseCohort, sedeId: ctx.fx.sedes.ccs }], paymentMethod: "PAYPAL" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createCheckout(ctx.d, { customer: buyer(), items: [{ ...item, cohortId: ctx.fx.courseCohort }], paymentMethod: "ZELLE" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createCheckout(ctx.d, { customer: { ...buyer(), email: "no-es-email" }, items: [{ ...item, cohortId: ctx.fx.courseCohort }], paymentMethod: "PAYPAL" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await ctx.db.order.count()).toBe(0);
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } })).seatsHeld).toBe(0);
  });
});

describe("máquina de estados", () => {
  it("solo transiciones legales; cada una deja OrderEvent con actor y antes/después", async () => {
    expect(canTransition("PENDING_PAYMENT", "ENROLLED")).toBe(false);
    expect(canTransition("REFUNDED", "PAID")).toBe(false);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    await expect(withTx(ctx.d, (tx) => transitionOrder(tx, o.id, "ENROLLED", { actor: { type: "SYSTEM" } }))).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await withTx(ctx.d, (tx) => transitionOrder(tx, o.id, "AWAITING_VERIFICATION", { actor: { type: "ADMIN", id: ctx.fx.adminId }, note: "prueba" }));
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "STATUS_CHANGE" } });
    expect(ev).toMatchObject({ fromStatus: "PENDING_PAYMENT", toStatus: "AWAITING_VERIFICATION", actorType: "ADMIN", actorId: ctx.fx.adminId, note: "prueba" });
  });

  it("expireStaleOrders vence pedidos sin pago y libera el cupo; no toca los que esperan verificación", async () => {
    const a = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const b = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
    await withTx(ctx.d, (tx) => transitionOrder(tx, b.id, "AWAITING_VERIFICATION", { actor: { type: "CUSTOMER" } }));
    ctx.clock.advance(100 * HOUR);
    expect(await expireStaleOrders(ctx.d)).toBe(1);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("EXPIRED");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("AWAITING_VERIFICATION");
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(c.seatsHeld).toBe(1);
  });

  it("cancelar libera el cupo; ajustes de saldo y reasignación de cohorte quedan auditados", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const other = await ctx.db.cohort.create({ data: { productId: ctx.fx.course, sedeId: ctx.fx.sedes.ccs, name: "Cohorte Caracas", startDate: new Date(), endDate: new Date(), capacity: 1 } });
    await reassignCohort(ctx.d, ctx.fx.admin, o.items[0].id, other.id, "Cambio de sede pedido por el alumno");
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } })).seatsHeld).toBe(0);
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: other.id } })).seatsHeld).toBe(1);
    expect((await ctx.db.orderItem.findUniqueOrThrow({ where: { id: o.items[0].id } })).sedeId).toBe(ctx.fx.sedes.ccs);
    expect(await adjustBalance(ctx.d, ctx.fx.admin, o.id, -2000, "Beca parcial")).toBe(16000);
    await cancelOrder(ctx.d, ctx.fx.admin, o.id, "Duplicado");
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: other.id } })).seatsHeld).toBe(0);
    const types = (await ctx.db.orderEvent.findMany({ where: { orderId: o.id } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["COHORT_REASSIGNED", "BALANCE_ADJUSTED", "STATUS_CHANGE"]));
  });
});
