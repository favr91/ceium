import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR, MINUTE } from "@/server/deps";
import { createCheckout, expireStaleOrders } from "@/server/orders";
import {
  adminVerifyPayment,
  capturePaypalReturn,
  handlePaypalWebhook,
  recordManualPayment,
  refundPayment,
  startPaypalPayment,
  storeProofFile,
} from "@/server/payments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("payments");
});
afterEach(async () => {
  await ctx.dispose();
});

const templates = async (orderId: string) => (await ctx.db.emailOutbox.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } })).map((e) => e.template);
const order = (id: string) => ctx.db.order.findUniqueOrThrow({ where: { id }, include: { items: { include: { reservation: true } } } });
const cohort = (id: string) => ctx.db.cohort.findUniqueOrThrow({ where: { id } });

async function semiCourseOrder(method: "PAYPAL" | "PAGO_MOVIL" = "PAGO_MOVIL", planKind: "FULL" | "HALF" = "FULL") {
  return createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind }], paymentMethod: method });
}

describe("pago manual (pago móvil / transferencia)", () => {
  it("comprobante → verificación → admin aprueba → cupo confirmado + matrícula Moodle + correos", async () => {
    const o = await semiCourseOrder("PAGO_MOVIL");
    const proof = await storeProofFile(ctx.d, o.id, "captura.jpg", new Uint8Array([1, 2, 3]));
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "00123456", bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: proof });
    expect(fs.existsSync(proof)).toBe(true);
    expect(p.status).toBe("AWAITING_VERIFICATION");
    expect(p.amountUsdCents).toBe(18000);
    expect((await order(o.id)).status).toBe("AWAITING_VERIFICATION");
    // referencia duplicada
    await expect(recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "00123456", amountCents: 100, currency: "VES", exchangeRate: 100 })).rejects.toMatchObject({ code: "VALIDATION" });
    // la reserva de un pedido en verificación NO vence
    ctx.clock.advance(100 * HOUR);
    await expireStaleOrders(ctx.d);
    expect((await order(o.id)).items[0].reservation!.status).toBe("HELD");

    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    const after = await order(o.id);
    expect(after.status).toBe("ENROLLED");
    expect([after.amountPaidCents, after.balanceCents]).toEqual([18000, 0]);
    expect(after.items[0].reservation!.status).toBe("CONFIRMED");
    const c = await cohort(ctx.fx.courseCohort);
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([0, 1]);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    expect(ctx.moodle.enrolments.get(cust.moodleUserId!)).toEqual(new Set([201]));
    expect(await templates(o.id)).toEqual(["order_confirmation", "payment_under_verification", "payment_approved", "platform_access", "cohort_details"]);
    const access = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "platform_access" } });
    // La contraseña temporal NO se guarda: la bandeja conserva un marcador (el valor solo viaja en el correo).
    expect(access.text).toContain("Contraseña temporal: [[CEIUM_TEMP_PASSWORD]]");
    expect(`${access.html}${access.text}`).not.toMatch(/Tmp#/);
    expect(access.secretRef).toEqual({ kind: "moodle_temp_password", moodleUserId: cust.moodleUserId });
    const payEv = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "PAYMENT_VERIFIED" } });
    expect([payEv.actorType, payEv.actorId]).toEqual(["ADMIN", ctx.fx.adminId]);
    // doble verificación no permitida
    await expect(adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("admin rechaza → pedido REJECTED, cupo liberado, correo con motivo; no hay matrícula", async () => {
    const o = await semiCourseOrder("PAGO_MOVIL");
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "TRANSFERENCIA", reference: "TRX-9", amountCents: 1_800_000, currency: "VES" });
    await expect(adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "reject" })).rejects.toMatchObject({ code: "VALIDATION" });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "reject", note: "La referencia no aparece en el banco" });
    const after = await order(o.id);
    expect(after.status).toBe("REJECTED");
    expect(after.items[0].reservation!.status).toBe("RELEASED");
    expect((await cohort(ctx.fx.courseCohort)).seatsHeld).toBe(0);
    expect(ctx.moodle.count("enrol")).toBe(0);
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "payment_rejected" } });
    expect(mail.html).toContain("La referencia no aparece en el banco");
  });

  it("plan mitad: primer pago matricula (PARTIALLY_PAID→ENROLLED) y el saldo sigue visible; segundo pago lo cancela", async () => {
    const o = await semiCourseOrder("PAGO_MOVIL", "HALF");
    const p1 = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "A00001", amountCents: 900_000, currency: "VES" }); // tasa del setting: 100
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p1.id, decision: "approve" });
    let after = await order(o.id);
    expect(after.status).toBe("ENROLLED");
    expect(after.balanceCents).toBe(9000);
    const events = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "STATUS_CHANGE" }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toStatus)).toEqual(["AWAITING_VERIFICATION", "PARTIALLY_PAID", "ENROLLED"]);
    const p2 = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "A00002", amountCents: 900_000, currency: "VES" });
    expect((await order(o.id)).status).toBe("ENROLLED"); // un pago de cuota no hace retroceder el estado
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p2.id, decision: "approve" });
    after = await order(o.id);
    expect([after.amountPaidCents, after.balanceCents]).toEqual([18000, 0]);
    const inst = await ctx.db.installment.findMany({ where: { orderId: o.id }, orderBy: { sequence: "asc" } });
    expect(inst.map((i) => i.status)).toEqual(["PAID", "PAID"]);
    expect(ctx.moodle.count("enrol")).toBe(1);
  });

  it("pago insuficiente para el primer pago → vuelve a PENDING_PAYMENT sin matricular", async () => {
    const o = await semiCourseOrder("PAGO_MOVIL");
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "B00001", amountCents: 500_000, currency: "VES", exchangeRate: 100 });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    const after = await order(o.id);
    expect(after.status).toBe("PENDING_PAYMENT");
    expect(after.amountPaidCents).toBe(5000);
    expect(ctx.moodle.count("enrol")).toBe(0);
  });
});

describe("PayPal", () => {
  it("webhook y return URL llegan A LA VEZ → un solo pago aplicado, una sola matrícula, un solo correo", async () => {
    const o = await semiCourseOrder("PAYPAL");
    const start = await startPaypalPayment(ctx.d, o.id);
    expect(start.amountCents).toBe(18000);
    expect(ctx.paypal.calls[0].args[0]).toMatchObject({ amountCents: 18000, currency: "USD", orderId: o.id, returnUrl: expect.stringContaining(`/pedido/${o.token}`) });
    ctx.paypal.approve(start.paypalOrderId);
    const body = ctx.paypal.captureCompletedEvent(start.paypalOrderId);
    ctx.paypal.orders.get(start.paypalOrderId)!.status = "APPROVED"; // aún capturable por el return URL
    const [ret, wh, whAgain] = await Promise.all([
      capturePaypalReturn(ctx.d, start.paypalOrderId),
      handlePaypalWebhook(ctx.d, {}, body),
      handlePaypalWebhook(ctx.d, {}, body), // PayPal reenvía el mismo evento
    ]);
    expect(ret.status).toBe("COMPLETED");
    expect(wh.ok && whAgain.ok).toBe(true);
    const after = await order(o.id);
    expect(after.status).toBe("ENROLLED");
    expect(after.amountPaidCents).toBe(18000);
    expect(await ctx.db.payment.count({ where: { orderId: o.id, status: "COMPLETED" } })).toBe(1);
    expect(ctx.moodle.count("enrol")).toBe(1);
    expect(await ctx.db.enrollment.count({ where: { orderId: o.id } })).toBe(1);
    expect((await cohort(ctx.fx.courseCohort)).seatsConfirmed).toBe(1);
    expect((await templates(o.id)).filter((t) => t === "order_confirmation")).toHaveLength(1);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "PAYMENT_RECEIVED" } })).toBe(1);
  });

  it("webhook primero y luego return URL (ORDER_ALREADY_CAPTURED) → idempotente", async () => {
    const o = await semiCourseOrder("PAYPAL");
    const start = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(start.paypalOrderId);
    await handlePaypalWebhook(ctx.d, {}, ctx.paypal.captureCompletedEvent(start.paypalOrderId));
    expect((await order(o.id)).status).toBe("ENROLLED");
    expect((await capturePaypalReturn(ctx.d, start.paypalOrderId)).status).toBe("COMPLETED");
    expect(await ctx.db.payment.count({ where: { orderId: o.id, status: "COMPLETED" } })).toBe(1);
    expect(ctx.moodle.count("enrol")).toBe(1);
  });

  it("firma inválida → UNAUTHORIZED y nada cambia", async () => {
    const o = await semiCourseOrder("PAYPAL");
    const start = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.signatureValid = false;
    await expect(handlePaypalWebhook(ctx.d, {}, ctx.paypal.captureCompletedEvent(start.paypalOrderId))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await order(o.id)).status).toBe("PENDING_PAYMENT");
    expect(await ctx.db.webhookEvent.count()).toBe(0);
  });

  it("captura rechazada → pago FAILED, pedido sigue pendiente y se puede reintentar", async () => {
    const o = await semiCourseOrder("PAYPAL");
    const s1 = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s1.paypalOrderId);
    ctx.paypal.declineNextCapture = true;
    expect((await capturePaypalReturn(ctx.d, s1.paypalOrderId)).status).toBe("FAILED");
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: s1.paymentId } })).status).toBe("FAILED");
    expect((await order(o.id)).status).toBe("PENDING_PAYMENT");
    const s2 = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s2.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, s2.paypalOrderId)).status).toBe("COMPLETED");
    expect((await order(o.id)).status).toBe("ENROLLED");
  });

  it("pago capturado tras vencer la reserva: retoma el cupo si hay; si no, marca para atención y no matricula", async () => {
    const o = await semiCourseOrder("PAYPAL");
    const start = await startPaypalPayment(ctx.d, o.id);
    ctx.clock.advance(40 * MINUTE);
    await expireStaleOrders(ctx.d);
    expect((await order(o.id)).status).toBe("EXPIRED");
    // la cohorte se llena con otros 3
    for (let i = 0; i < 3; i++) await semiCourseOrder("PAYPAL");
    ctx.paypal.approve(start.paypalOrderId);
    await handlePaypalWebhook(ctx.d, {}, ctx.paypal.captureCompletedEvent(start.paypalOrderId));
    const after = await order(o.id);
    expect(after.status).toBe("PAID");
    expect(ctx.moodle.count("enrol")).toBe(0);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "SEAT_UNAVAILABLE" } })).toBe(1);
    const c = await cohort(ctx.fx.courseCohort);
    expect(c.seatsHeld + c.seatsConfirmed).toBeLessThanOrEqual(c.capacity);
  });

  it("reembolso PayPal total → API de PayPal, REFUNDED, cupo liberado, desmatriculado, correo; el webhook REFUNDED posterior no duplica", async () => {
    const o = await semiCourseOrder("PAYPAL");
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    const r = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, reason: "Retiro antes de iniciar" });
    expect(r.fullyRefunded).toBe(true);
    expect(ctx.paypal.refunds).toHaveLength(1);
    expect(ctx.paypal.refunds[0].amountCents).toBe(18000); // total, con monto explícito
    expect(ctx.paypal.refunds[0].requestId).toBe(`refund-${r.refund.id}`); // PayPal-Request-Id estable por fila
    const after = await order(o.id);
    expect(after.status).toBe("REFUNDED");
    expect(after.items[0].reservation!.status).toBe("RELEASED");
    expect((await cohort(ctx.fx.courseCohort)).seatsConfirmed).toBe(0);
    expect(ctx.moodle.count("unenrol")).toBe(1);
    expect((await ctx.db.enrollment.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("UNENROLLED");
    expect(await templates(o.id)).toContain("refund_issued");
    const res = await handlePaypalWebhook(ctx.d, {}, ctx.paypal.refundEvent(pay.paypalCaptureId!, ctx.paypal.refunds[0].id, 18000));
    expect(res.ok).toBe(true);
    expect(await ctx.db.refund.count()).toBe(1);
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("reembolso parcial: no cambia estado ni matrícula salvo que se pida; reembolso iniciado desde PayPal se registra por webhook", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 2500, reason: "Descuento posterior" });
    let after = await order(o.id);
    expect(after.status).toBe("ENROLLED");
    expect([after.amountPaidCents, after.balanceCents]).toEqual([7500, 2500]);
    expect(ctx.paypal.refunds[0].amountCents).toBe(2500);
    expect(ctx.moodle.count("unenrol")).toBe(0);
    // el resto se reembolsa desde el panel de PayPal → llega solo el webhook
    await handlePaypalWebhook(ctx.d, {}, ctx.paypal.refundEvent(pay.paypalCaptureId!, "REF-EXTERNAL-1", 7500));
    after = await order(o.id);
    expect(after.status).toBe("REFUNDED");
    expect(ctx.moodle.count("unenrol")).toBe(1);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe("REFUNDED");
  });

  it("reembolso de pago manual se registra sin llamar a PayPal", async () => {
    const o = await semiCourseOrder("PAGO_MOVIL");
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "M00001", amountCents: 1_800_000, currency: "VES" });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    const r = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, reason: "Devolución por pago móvil", unenroll: false });
    expect(r.refund.manual).toBe(true);
    expect(ctx.paypal.calls.filter((c) => c.fn === "refundCapture")).toHaveLength(0);
    expect((await order(o.id)).status).toBe("REFUNDED");
    expect(ctx.moodle.count("unenrol")).toBe(0);
    expect((await cohort(ctx.fx.courseCohort)).seatsConfirmed).toBe(0);
  });
});
