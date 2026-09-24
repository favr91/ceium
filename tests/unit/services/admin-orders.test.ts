// Panel · pedidos: lectura con permisos (listado, ficha, comprobante privado) y el rastro de cupos liberados
// (SEAT_RELEASED con quién lo originó) al rechazar, reembolsar, cancelar y vencer.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR } from "@/server/deps";
import { getAdminOrder, listAdminOrders, readPaymentProof } from "@/server/admin-orders";
import { cancelOrder, createCheckout, expireStaleOrders } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, recordManualPayment, refundPayment, startPaypalPayment, storeProofFile } from "@/server/payments";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("admin-orders");
});
afterEach(async () => {
  await ctx.dispose();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function manualOrderWithProof(reference = "01020304") {
  const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const proofFile = await storeProofFile(ctx.d, o.id, "comprobante.png", PNG);
  const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference, bank: "Banesco", amountCents: 1_800_000, currency: "VES", proofFile });
  return { o, p };
}

const seatEvents = (orderId: string) => ctx.db.orderEvent.findMany({ where: { orderId, type: "SEAT_RELEASED" } });
const cohort = () => ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort }, select: { seatsHeld: true, seatsConfirmed: true } });

describe("lectura del panel", () => {
  it("lista con conteo por estado, filtro y búsqueda; ADMIN y STAFF pueden verlo, sin sesión o desactivado no", async () => {
    const { o } = await manualOrderWithProof();
    const all = await listAdminOrders(ctx.d, ctx.fx.admin);
    expect(all.rows.map((r) => r.id)).toEqual([o.id]);
    expect(all.counts).toEqual({ AWAITING_VERIFICATION: 1 });
    expect(all.rows[0]).toMatchObject({ number: o.number, status: "AWAITING_VERIFICATION", awaitingVerification: 1 });
    expect((await listAdminOrders(ctx.d, ctx.fx.staff, { status: "AWAITING_VERIFICATION" })).rows).toHaveLength(1);
    expect((await listAdminOrders(ctx.d, ctx.fx.admin, { status: "ENROLLED" })).rows).toHaveLength(0);
    expect((await listAdminOrders(ctx.d, ctx.fx.admin, { q: `#${o.number}` })).rows).toHaveLength(1);
    expect((await listAdminOrders(ctx.d, ctx.fx.admin, { q: "01020304" })).rows).toHaveLength(1);
    expect((await listAdminOrders(ctx.d, ctx.fx.admin, { q: "nadie@example.com" })).rows).toHaveLength(0);

    await expect(listAdminOrders(ctx.d, null as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await ctx.db.adminUser.update({ where: { id: ctx.fx.staff.id }, data: { active: false } });
    await expect(getAdminOrder(ctx.d, ctx.fx.staff, o.id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("ficha: pagos con comprobante, historial con actor, correos y matrículas tras aprobar", async () => {
    const { o, p } = await manualOrderWithProof();
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve", note: "Verificado en Banesco" });
    const v = await getAdminOrder(ctx.d, ctx.fx.staff, o.id);
    expect(v.status).toBe("ENROLLED");
    expect(v.payments[0]).toMatchObject({ id: p.id, status: "COMPLETED", hasProof: true, proofKind: "image", verifiedBy: { name: "Admin" } });
    expect(v.events.find((e) => e.type === "PAYMENT_VERIFIED")).toMatchObject({ actorType: "ADMIN", actor: { email: "admin@ceium.net" }, note: "Verificado en Banesco" });
    expect(v.emails.map((m) => m.template)).toEqual(expect.arrayContaining(["order_confirmation", "payment_under_verification", "payment_approved", "platform_access", "cohort_details"]));
    expect(v.enrollments.map((e) => [e.moodleCourseId, e.status])).toEqual([[201, "ENROLLED"]]);
    expect(v.items[0].reservation?.status).toBe("CONFIRMED");
    await expect(getAdminOrder(ctx.d, ctx.fx.admin, "no-existe")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("comprobante: bytes y tipo para el panel; nunca fuera de PRIVATE_FILES_DIR/proofs", async () => {
    const { o, p } = await manualOrderWithProof();
    const proof = await readPaymentProof(ctx.d, ctx.fx.staff, p.id);
    expect(proof).toMatchObject({ orderId: o.id, contentType: "image/png" });
    expect(new Uint8Array(proof.bytes)).toEqual(PNG);

    await expect(readPaymentProof(ctx.d, null as never, p.id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // Una ruta manipulada (fuera de proofs/) no se sirve.
    await ctx.db.payment.update({ where: { id: p.id }, data: { proofFile: path.join(ctx.d.config.privateFilesDir, "proofs", "..", "..", "secreto.png") } });
    await expect(readPaymentProof(ctx.d, ctx.fx.admin, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ctx.db.payment.update({ where: { id: p.id }, data: { proofFile: "/etc/passwd" } });
    await expect(readPaymentProof(ctx.d, ctx.fx.admin, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ctx.db.payment.update({ where: { id: p.id }, data: { proofFile: null } });
    await expect(readPaymentProof(ctx.d, ctx.fx.admin, p.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("rastro de cupos liberados", () => {
  it("rechazo: SEAT_RELEASED por el admin, cupo devuelto", async () => {
    const { o, p } = await manualOrderWithProof();
    expect(await cohort()).toEqual({ seatsHeld: 1, seatsConfirmed: 0 });
    await adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p.id, decision: "reject", note: "Referencia inexistente" });
    expect(await cohort()).toEqual({ seatsHeld: 0, seatsConfirmed: 0 });
    const ev = await seatEvents(o.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorType: "ADMIN", actorId: ctx.fx.staff.id });
    expect(ev[0].data).toMatchObject({ cohortId: ctx.fx.courseCohort, previousStatus: "HELD", reason: "REJECTED" });
    expect(ev[0].note).toContain("Cohorte Octubre 2026");
  });

  it("reembolso PayPal con liberar cupo: SEAT_RELEASED por el admin; sin liberar cupo: ninguno", async () => {
    for (const releaseSeat of [true, false]) {
      const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
      const { paypalOrderId } = await startPaypalPayment(ctx.d, o.id);
      ctx.paypal.approve(paypalOrderId);
      await capturePaypalReturn(ctx.d, paypalOrderId);
      const pay = await ctx.db.payment.findFirstOrThrow({ where: { orderId: o.id, status: "COMPLETED" } });
      await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, reason: "Baja", unenroll: true, releaseSeat, idempotencyKey: `k-${releaseSeat}` });
      const ev = await seatEvents(o.id);
      if (releaseSeat) {
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ actorType: "ADMIN", actorId: ctx.fx.adminId });
        expect(ev[0].data).toMatchObject({ previousStatus: "CONFIRMED", reason: "REFUNDED" });
      } else {
        expect(ev).toHaveLength(0);
      }
    }
    // Uno liberado, otro conservado por decisión del admin.
    expect(await cohort()).toEqual({ seatsHeld: 0, seatsConfirmed: 1 });
  });

  it("cancelación (admin) y vencimiento (sistema) también quedan en el historial", async () => {
    const mk = () => createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
    const a = await mk();
    const b = await mk();
    await cancelOrder(ctx.d, ctx.fx.staff, a.id, "Duplicado");
    expect((await seatEvents(a.id))[0]).toMatchObject({ actorType: "ADMIN", actorId: ctx.fx.staff.id });
    ctx.clock.advance(73 * HOUR);
    await expireStaleOrders(ctx.d);
    const ev = await seatEvents(b.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorType: "SYSTEM", actorId: null });
    expect(ev[0].data).toMatchObject({ reason: "EXPIRED" });
  });
});
