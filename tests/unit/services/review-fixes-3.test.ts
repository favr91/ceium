// Tercera revisión: cupos con dinero en camino (CAPTURE_PENDING, PayPal en curso), pedidos pagados sin
// cupo corregidos por el admin, ajustes de saldo que mueven cuotas y estados, condonación de cuotas.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINUTE, HOUR } from "@/server/deps";
import { cancelOrder, createCheckout, getOrder } from "@/server/orders";
import { adjustBalance, adjustBalanceDetailed, reassignCohort, waiveInstallment } from "@/server/corrections";
import { capturePaypalReturn, onPaypalCaptureCompleted, recordManualPayment, adminVerifyPayment, startPaypalPayment, syncPaypalOrder } from "@/server/payments";
import { getCohortAvailability } from "@/server/seats";
import { runJobs } from "@/server/jobs";
import { sendInstallmentReminder } from "@/server/installments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("review3");
});
afterEach(async () => {
  await ctx.dispose();
});

const semiCourse = (paymentMethod: "PAYPAL" | "PAGO_MOVIL" = "PAYPAL", cohortId?: string, planKind: "FULL" | "HALF" = "FULL") =>
  createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: cohortId ?? ctx.fx.courseCohort, planKind }], paymentMethod });

const cohort = (id: string) => ctx.db.cohort.findUniqueOrThrow({ where: { id } });
const reservationOf = async (orderId: string) => (await getOrder(ctx.d, orderId)).items[0].reservation!;

describe("CAPTURE_PENDING de PayPal sostiene el cupo", () => {
  it("el job de vencimiento no libera la reserva mientras PayPal retiene la captura; la captura tardía matricula", async () => {
    const o = await semiCourse();
    const s = await startPaypalPayment(ctx.d, o.id);
    const captureId = ctx.paypal.captureOutOfBand(s.paypalOrderId, "PENDING");
    expect(await syncPaypalOrder(ctx.d, s.paypalOrderId)).toBe("PENDING");

    ctx.clock.advance(5 * HOUR);
    const out = await runJobs(ctx.d, ["expire"]);
    expect(out.expire).toEqual({ orders: 0, reservations: 0 });
    expect((await reservationOf(o.id)).status).toBe("HELD");
    expect((await cohort(ctx.fx.courseCohort)).seatsHeld).toBe(1);
    // La disponibilidad pública también lo cuenta (aunque su expiresAt ya pasó).
    expect((await getCohortAvailability(ctx.d, ctx.fx.courseCohort)).held).toBe(1);

    // Otros compradores no pueden quitarle el cupo (capacidad 3: caben 2 más, el 3º se agota).
    await semiCourse();
    await semiCourse();
    await expect(semiCourse()).rejects.toMatchObject({ code: "SOLD_OUT" });

    await onPaypalCaptureCompleted(ctx.d, { captureId, paypalOrderId: s.paypalOrderId, amountCents: 18000, currency: "USD", source: "webhook" });
    const after = await getOrder(ctx.d, o.id);
    expect(after.status).toBe("ENROLLED");
    expect(after.items[0].reservation!.status).toBe("CONFIRMED");
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "SEAT_UNAVAILABLE" } })).toBe(0);
  });
});

describe("iniciar PayPal extiende la reserva y el pedido", () => {
  it("pagar al final del plazo renueva ambos vencimientos: el job no vence el pedido mientras el comprador está en PayPal", async () => {
    const o = await semiCourse();
    ctx.clock.advance(29 * MINUTE);
    await startPaypalPayment(ctx.d, o.id);
    ctx.clock.advance(10 * MINUTE); // 39 min desde el checkout: el plazo original (30) ya pasó
    expect((await runJobs(ctx.d, ["expire"])).expire).toEqual({ orders: 0, reservations: 0 });
    const cur = await getOrder(ctx.d, o.id);
    expect(cur.status).toBe("PENDING_PAYMENT");
    expect(cur.items[0].reservation!.status).toBe("HELD");
  });

  it("una reserva HELD ya vencida pero aún no barrida se extiende (no se libera después)", async () => {
    const o = await semiCourse();
    ctx.clock.advance(31 * MINUTE);
    await startPaypalPayment(ctx.d, o.id);
    const r = await reservationOf(o.id);
    expect(r.expiresAt.getTime()).toBe(ctx.clock.now().getTime() + 30 * MINUTE);
    expect((await getOrder(ctx.d, o.id)).expiresAt!.getTime()).toBe(ctx.clock.now().getTime() + 30 * MINUTE);
    expect((await runJobs(ctx.d, ["expire"])).expire).toEqual({ orders: 0, reservations: 0 });
    expect((await cohort(ctx.fx.courseCohort)).seatsHeld).toBe(1);
  });
});

describe("pedido pagado sin cupo: corrección del admin", () => {
  async function paidWithoutSeat() {
    const o = await semiCourse();
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    ctx.clock.advance(2 * HOUR);
    await runJobs(ctx.d, ["expire"]); // el comprador no volvió a tiempo: pedido EXPIRED, cupo liberado
    expect((await getOrder(ctx.d, o.id)).status).toBe("EXPIRED");
    const others = [await semiCourse("PAGO_MOVIL"), await semiCourse("PAGO_MOVIL"), await semiCourse("PAGO_MOVIL")]; // llenan la cohorte
    await capturePaypalReturn(ctx.d, s.paypalOrderId); // cobra tarde
    const paid = await getOrder(ctx.d, o.id);
    expect(paid.status).toBe("PAID");
    expect(paid.items[0].reservation!.status).toBe("RELEASED");
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "SEAT_UNAVAILABLE" } })).toBe(1);
    expect(await ctx.db.enrollment.count({ where: { orderId: o.id } })).toBe(0);
    return { o, others };
  }

  it("reasignar a otra cohorte toma el cupo CONFIRMED, matricula y envía los datos de la nueva cohorte; el job no lo libera", async () => {
    const { o } = await paidWithoutSeat();
    const other = await ctx.db.cohort.create({ data: { productId: ctx.fx.course, sedeId: ctx.fx.sedes.ccs, name: "Cohorte Caracas", startDate: new Date("2026-11-07T12:00:00Z"), endDate: new Date("2026-11-28T12:00:00Z"), capacity: 5 } });
    const r = await reassignCohort(ctx.d, ctx.fx.admin, o.items[0].id, other.id, "Pago tardío sin cupo en Barquisimeto");
    expect(r).toMatchObject({ confirmed: true, seatRestored: true });
    expect(r.enrollment?.status).toBe("ENROLLED");
    const after = await getOrder(ctx.d, o.id);
    expect(after.status).toBe("ENROLLED");
    expect(after.items[0].reservation!).toMatchObject({ status: "CONFIRMED", cohortId: other.id });
    expect(await cohort(other.id)).toMatchObject({ seatsHeld: 0, seatsConfirmed: 1 });
    expect(ctx.moodle.count("enrol")).toBe(1);
    const cohortMail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "cohort_details" } });
    expect(cohortMail.html).toContain("Cohorte Caracas");

    ctx.clock.advance(10 * 24 * HOUR);
    await runJobs(ctx.d, ["expire", "enrollments"]);
    expect((await reservationOf(o.id)).status).toBe("CONFIRMED");
    expect(await cohort(other.id)).toMatchObject({ seatsHeld: 0, seatsConfirmed: 1 });
  });

  it("volver a tomar cupo en la MISMA cohorte cuando se libera uno", async () => {
    const { o, others } = await paidWithoutSeat();
    await expect(reassignCohort(ctx.d, ctx.fx.admin, o.items[0].id, ctx.fx.courseCohort)).rejects.toMatchObject({ code: "SOLD_OUT" });
    await cancelOrder(ctx.d, ctx.fx.admin, others[0].id, "Desistió");
    const r = await reassignCohort(ctx.d, ctx.fx.admin, o.items[0].id, ctx.fx.courseCohort, "Se liberó un cupo");
    expect(r.confirmed).toBe(true);
    expect((await getOrder(ctx.d, o.id)).status).toBe("ENROLLED");
    expect(await cohort(ctx.fx.courseCohort)).toMatchObject({ seatsHeld: 2, seatsConfirmed: 1 });
  });

  it("reasignar un pedido sin pagar deja la reserva HELD con plazo vigente y extiende el pedido", async () => {
    const o = await semiCourse();
    ctx.clock.advance(25 * MINUTE);
    const other = await ctx.db.cohort.create({ data: { productId: ctx.fx.course, sedeId: ctx.fx.sedes.ccs, name: "Cohorte Caracas", startDate: new Date(), endDate: new Date(), capacity: 2 } });
    const r = await reassignCohort(ctx.d, ctx.fx.admin, o.items[0].id, other.id);
    expect(r.confirmed).toBe(false);
    expect(r.reservation.expiresAt.getTime()).toBe(ctx.clock.now().getTime() + 30 * MINUTE);
    expect((await getOrder(ctx.d, o.id)).expiresAt!.getTime()).toBe(ctx.clock.now().getTime() + 30 * MINUTE);
  });

  it("no reasigna pedidos cerrados", async () => {
    const o = await semiCourse();
    ctx.clock.advance(2 * HOUR);
    await runJobs(ctx.d, ["expire"]);
    const other = await ctx.db.cohort.create({ data: { productId: ctx.fx.course, sedeId: ctx.fx.sedes.ccs, name: "C", startDate: new Date(), endDate: new Date(), capacity: 2 } });
    await expect(reassignCohort(ctx.d, ctx.fx.admin, o.items[0].id, other.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("ajustes de saldo y condonación de cuotas", () => {
  const monthlyOnline = () =>
    createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "MONTHLY" }], paymentMethod: "PAYPAL" });
  async function payPaypal(orderId: string) {
    const s = await startPaypalPayment(ctx.d, orderId);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
  }
  const enrolled = async (customerId: string) => (await ctx.db.enrollment.findMany({ where: { customerId, status: "ENROLLED" } })).map((e) => e.moodleCourseId).sort();

  it("condonar una cuota del plan mes a mes la deja WAIVED y matricula su curso de inmediato", async () => {
    const o = await monthlyOnline(); // 9 × 125
    await payPaypal(o.id);
    expect(await enrolled(o.customerId)).toEqual([301]);
    const ins2 = o.installments[1];
    const r = await waiveInstallment(ctx.d, ctx.fx.admin, ins2.id, "Beca del mes 2");
    expect(r.balanceCents).toBe(7 * 12500);
    expect(r.enrollment?.status).toBe("ENROLLED");
    expect(await enrolled(o.customerId)).toEqual([301, 302]);
    const after = await getOrder(ctx.d, o.id);
    expect(after.installments[1].status).toBe("WAIVED");
    expect(after.balanceCents).toBe(7 * 12500);
    // La siguiente cuota a cobrar es la 3 y PayPal cobra exactamente su monto.
    const s = await startPaypalPayment(ctx.d, o.id);
    expect(s.amountCents).toBe(12500);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "INSTALLMENT_WAIVED" } });
    expect(ev.note).toBe("Beca del mes 2");
    await expect(waiveInstallment(ctx.d, ctx.fx.admin, ins2.id, "otra vez")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("condonar por monto salda las cuotas en orden (habilitando sus cursos) y ajusta la parcial; el recordatorio cobra lo que falta", async () => {
    const o = await monthlyOnline();
    await payPaypal(o.id);
    const r = await adjustBalanceDetailed(ctx.d, ctx.fx.admin, o.id, -(12500 + 5000), "Descuento por convenio");
    expect(r.installments.map((i) => [i.sequence, i.afterCents, i.waived])).toEqual([
      [2, 0, true],
      [3, 7500, false],
    ]);
    expect(await enrolled(o.customerId)).toEqual([301, 302]);
    const cur = await getOrder(ctx.d, o.id);
    expect(cur.balanceCents).toBe(9 * 12500 - 12500 - 12500 - 5000);
    // Suma de cuotas no condonadas = total + ajustes
    expect(cur.installments.filter((i) => i.status !== "WAIVED").reduce((a, i) => a + i.amountCents, 0)).toBe(cur.totalCents - 17500);
    expect((await startPaypalPayment(ctx.d, o.id)).amountCents).toBe(7500);
    await sendInstallmentReminder(ctx.d, cur.installments[2].id);
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "installment_reminder" } });
    expect(mail.html).toContain("75.00");
  });

  it("no condona más que el saldo", async () => {
    const o = await monthlyOnline();
    await payPaypal(o.id);
    await expect(adjustBalance(ctx.d, ctx.fx.admin, o.id, -(9 * 12500), "demasiado")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("un PARTIALLY_PAID llevado a saldo 0 por ajuste pasa a PAID", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "HALF" }], paymentMethod: "PAYPAL" });
    ctx.moodle.failEnrol = 100; // Moodle caído: el pedido queda PARTIALLY_PAID (sin matricular)
    await payPaypal(o.id);
    const mid = await getOrder(ctx.d, o.id);
    expect([mid.status, mid.balanceCents]).toEqual(["PARTIALLY_PAID", 5000]);
    expect(await adjustBalance(ctx.d, ctx.fx.admin, o.id, -5000, "Saldo condonado")).toBe(0);
    const after = await getOrder(ctx.d, o.id);
    expect(after.status).toBe("PAID");
    expect(after.installments.map((i) => i.status)).toEqual(["PAID", "WAIVED"]);
    // Moodle vuelve: el job matricula y el pedido pasa a ENROLLED.
    ctx.moodle.failEnrol = 0;
    ctx.clock.advance(HOUR);
    await runJobs(ctx.d, ["enrollments"]);
    expect((await getOrder(ctx.d, o.id)).status).toBe("ENROLLED");
  });

  it("un cargo extra agrega una cuota al final y reabre el cobro", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    await payPaypal(o.id);
    expect(await adjustBalance(ctx.d, ctx.fx.admin, o.id, 1500, "Reposición de material")).toBe(1500);
    const after = await getOrder(ctx.d, o.id);
    expect(after.installments.map((i) => [i.sequence, i.amountCents, i.status, i.courseId])).toEqual([
      [1, 10000, "PAID", null],
      [2, 1500, "PENDING", null],
    ]);
    expect((await startPaypalPayment(ctx.d, o.id)).amountCents).toBe(1500);
  });

  it("una beca completa del pago inicial confirma el cupo y matricula (sin pago)", async () => {
    const o = await semiCourse("PAGO_MOVIL");
    const r = await adjustBalanceDetailed(ctx.d, ctx.fx.admin, o.id, -18000, "Beca completa");
    expect(r).toMatchObject({ firstPaymentSatisfied: true, balanceCents: 0, dueNowCents: 0 });
    const after = await getOrder(ctx.d, o.id);
    expect(after.status).toBe("ENROLLED");
    expect(after.items[0].reservation!.status).toBe("CONFIRMED");
    expect(await cohort(ctx.fx.courseCohort)).toMatchObject({ seatsHeld: 0, seatsConfirmed: 1 });
  });

  it("una beca parcial del pago inicial baja el primer pago; el comprobante por el resto confirma", async () => {
    const o = await semiCourse("PAGO_MOVIL", undefined, "HALF"); // 180: 90 + 90
    const r = await adjustBalanceDetailed(ctx.d, ctx.fx.admin, o.id, -3000, "Beca parcial");
    expect(r).toMatchObject({ firstPaymentSatisfied: false, dueNowCents: 6000, balanceCents: 15000 });
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "REF-1", amountCents: 600_000, currency: "VES" });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    const after = await getOrder(ctx.d, o.id);
    expect(after.status).toBe("ENROLLED");
    expect(after.balanceCents).toBe(9000);
    expect(after.installments.map((i) => [i.amountCents, i.status])).toEqual([
      [6000, "PAID"],
      [9000, "PENDING"],
    ]);
  });
});
