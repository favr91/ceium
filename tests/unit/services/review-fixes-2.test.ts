// Segunda revisión: errores permanentes de Moodle, nombre del cliente sin autenticación, reembolsos
// (certificado) y capturas PayPal tardías / en exceso / en otra moneda.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoodleError } from "@/server/moodle";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, onPaypalCaptureCompleted, refundPayment, startPaypalPayment } from "@/server/payments";
import { checkDiplomaCompletion, verifyCertificate } from "@/server/certificates";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("review2");
});
afterEach(async () => {
  await ctx.dispose();
});

async function paidCourse(customer = buyer()) {
  const o = await createCheckout(ctx.d, { customer, items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  return { o, s };
}

describe("Moodle: errores permanentes", () => {
  it("un rechazo no reintentable (invalidparameter) pasa a FAILED de inmediato, sin backoff, con ATTENTION", async () => {
    let calls = 0;
    ctx.moodle.findOrCreateUser = async () => {
      calls++;
      throw new MoodleError({ kind: "moodle", wsfunction: "core_user_create_users", exception: "invalid_parameter_exception", errorcode: "invalidparameter", message: "Invalid parameter value detected" });
    };
    const { o } = await paidCourse();
    expect(calls).toBe(1);
    const rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows.map((r) => [r.status, r.attempts, r.nextAttemptAt])).toEqual([["FAILED", 1, null]]);
    expect(rows[0].lastError).toContain("invalidparameter");
    const att = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "ATTENTION" } });
    expect(att.note).toContain("Reintentar no lo resuelve");
  });

  it("errores transitorios (sin retryable=false) siguen con backoff", async () => {
    ctx.moodle.failEnrol = 10;
    const { o } = await paidCourse();
    const rows = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(rows.map((r) => r.status)).toEqual(["PENDING"]);
    expect(rows[0].nextAttemptAt).not.toBeNull();
  });
});

describe("checkout sin autenticación no renombra al cliente", () => {
  it("un checkout con un correo existente no cambia el nombre registrado (Moodle/certificado)", async () => {
    const b = buyer();
    const { o } = await paidCourse(b);
    const before = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    const other = await createCheckout(ctx.d, { customer: { ...b, firstName: "Intruso", lastName: "Malicioso" }, items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "HALF" }], paymentMethod: "PAYPAL" });
    const after = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    expect([after.firstName, after.lastName]).toEqual([before.firstName, before.lastName]);
    expect([other.buyerFirstName, other.buyerLastName]).toEqual(["Intruso", "Malicioso"]);
    // Aunque ese pedido se pague, el nombre registrado se conserva y el panel recibe el aviso.
    const s = await startPaypalPayment(ctx.d, other.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const final = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    expect(final.firstName).toBe(before.firstName);
    expect((await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: other.id, type: "ATTENTION" } })).note).toContain("difiere del registrado");
  });

  it("un checkout abandonado previo no fija el nombre: la primera compra PAGADA lo define", async () => {
    const b = buyer();
    await createCheckout(ctx.d, { customer: { ...b, firstName: "Otro", lastName: "Nombre" }, items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const { o } = await paidCourse(b);
    const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    expect([c.firstName, c.lastName]).toEqual([b.firstName, b.lastName]);
    const user = [...ctx.moodle.users.values()].find((u) => u.email === b.email.toLowerCase())!;
    expect(user.firstname).toBe(b.firstName);
  });
});

describe("reembolsos y certificados", () => {
  it("reembolso total de un diplomado con certificado emitido → certificado REVOCADO (verificación pública lo refleja)", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(cust.moodleUserId!, id);
    const cert = await checkDiplomaCompletion(ctx.d, o.customerId, ctx.fx.diploma);
    expect(cert.issued).toBe(true);

    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: s.paymentId, reason: "Retiro" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("REFUNDED");
    const v = await verifyCertificate(ctx.d, cert.code!);
    expect([v!.status, v!.revokeReason]).toEqual(["REVOKED", "Pedido reembolsado por completo"]);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "CERTIFICATE_REVOKED" } })).toBe(1);
  });

  it("reembolso parcial de cortesía con certificado emitido → descuento sin deuda: el certificado sigue vigente y sin aviso de saldo", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(cust.moodleUserId!, id);
    const cert = await checkDiplomaCompletion(ctx.d, o.customerId, ctx.fx.diploma);
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: s.paymentId, amountCents: 5000, reason: "Descuento" });
    expect((await verifyCertificate(ctx.d, cert.code!))!.status).toBe("ISSUED");
    // x2 crítico 8: sobre un pedido pagado completo lo devuelto es un descuento posterior, no deuda.
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).balanceCents).toBe(0);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "ATTENTION", note: { contains: cert.code! } } })).toBe(0);
  });
});

describe("PayPal: capturas tardías, en exceso y en otra moneda", () => {
  it("dos pestañas aprobadas: la captura del intento reemplazado se aplica, se avisa y el excedente se reembolsa solo", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const a = await startPaypalPayment(ctx.d, o.id);
    const b = await startPaypalPayment(ctx.d, o.id); // A queda CANCELLED
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: a.paymentId } })).status).toBe("CANCELLED");
    ctx.paypal.approve(a.paypalOrderId);
    ctx.paypal.approve(b.paypalOrderId);
    await capturePaypalReturn(ctx.d, b.paypalOrderId);
    await capturePaypalReturn(ctx.d, a.paypalOrderId);

    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([order.status, order.amountPaidCents, order.balanceCents]).toEqual(["ENROLLED", 10000, 0]);
    expect(ctx.paypal.refunds).toHaveLength(1);
    const pa = await ctx.db.payment.findUniqueOrThrow({ where: { id: a.paymentId } });
    expect(ctx.paypal.refunds[0].captureId).toBe(pa.paypalCaptureId);
    expect([pa.status, pa.refundedCents]).toEqual(["REFUNDED", 10000]);
    const notes = (await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "ATTENTION" } })).map((e) => e.note).join("\n");
    expect(notes).toContain("había sido reemplazado");
    expect(notes).toContain("Pago PayPal en exceso");
  });

  it("captura en una moneda distinta de USD: no se imputa, queda FAILED/CURRENCY_MISMATCH con ATTENTION", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    const r = await onPaypalCaptureCompleted(ctx.d, { captureId: "CAP-EUR", paypalOrderId: s.paypalOrderId, amountCents: 10000, currency: "EUR", source: "webhook" });
    expect(r.currencyMismatch).toBe(true);
    const p = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    expect([p.status, p.providerStatus]).toEqual(["FAILED", "CURRENCY_MISMATCH"]);
    const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([order.status, order.amountPaidCents]).toEqual(["PENDING_PAYMENT", 0]);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "ATTENTION" } })).toBe(1);
  });
});
