// x2 (crítico 6):
//  1. Reembolso con «Desmatricular» A MITAD de una matrícula cuya respuesta se pierde (Moodle ejecuta
//     enrol_manual_enrol_users y responde 5xx/timeout): el reembolso desmatricula ANTES de que Moodle ejecute la
//     matrícula, así que al terminar el intento hay que deshacerla; con timeout, el job lo repite.
//  2. Reembolso PARCIAL que saca al médico del programa (libera el cupo / lo desmatricula): el pedido se cierra y
//     el job de cuotas no le cobra el resto.
//  3. Referencias bancarias: la misma con ceros a la izquierda no pasa el índice único y el panel la marca.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, canonicalReference, recordManualPayment, refundPayment, sameBankMovement, storeProofFile } from "@/server/payments";
import { retryFailedUnenrollments, UNENROLLMENT_RECHECK } from "@/server/enrollment";
import { runInstallmentReminders } from "@/server/installments";
import { getOrderDetail } from "@/server/admin-order-views";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-6");
});
afterEach(async () => {
  await ctx.dispose();
});

async function pagoMovil(reference: string, n?: number) {
  const o = await createCheckout(ctx.d, { customer: buyer(n), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const proof = await storeProofFile(ctx.d, o.id, "captura.jpg", TINY_JPEG);
  const pm = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference, bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: proof });
  return { o, pm };
}
const COURSE_MOODLE_ID = 201; // curso del fixture (helpers/setup.ts)
const enrolledIn = (userId: number | null | undefined) => [...(ctx.moodle.enrolments.get(userId ?? -1) ?? [])];

describe("reembolso a mitad de una matrícula con la respuesta perdida", () => {
  for (const kind of ["http", "timeout"] as const) {
    it(`(${kind}) el médico reembolsado no queda matriculado en Moodle`, async () => {
      const { o, pm } = await pagoMovil(`0134${kind === "http" ? "1111" : "2222"}`);
      const real = ctx.moodle.enrol.bind(ctx.moodle);
      let first = true;
      ctx.moodle.enrol = async (userId: number, courseIds: number[]) => {
        if (!first) return real(userId, courseIds);
        first = false;
        // Mientras Moodle procesa: otro admin reembolsa con «Desmatricular»…
        await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, reason: "Desiste", unenroll: true, releaseSeat: true, idempotencyKey: `r-${kind}` });
        // …y luego Moodle ejecuta la matrícula y la respuesta se pierde.
        await real(userId, courseIds);
        throw Object.assign(new Error(`Moodle enrol_manual_enrol_users: ${kind}`), { retryable: true, kind });
      };
      await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });

      const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id }, include: { customer: true } });
      expect(order.status).toBe("REFUNDED");
      const uid = order.customer.moodleUserId;
      expect(enrolledIn(uid)).toEqual([]);
      // No se vuelve a matricular a quien ya no tiene derecho (sin reintentos en línea tras el reembolso).
      expect(ctx.moodle.count("enrol")).toBe(1);
      expect(await ctx.db.enrollment.findMany({ where: { customerId: order.customerId }, select: { status: true } })).toEqual([{ status: "UNENROLLED" }]);

      const recheck = await ctx.db.orderEvent.count({ where: { orderId: o.id, type: UNENROLLMENT_RECHECK } });
      expect(recheck).toBe(kind === "timeout" ? 1 : 0);
      if (kind === "timeout") {
        // Moodle ejecuta tarde la llamada que no respondió: el job repite la desmatrícula.
        await real(uid!, [COURSE_MOODLE_ID]);
        ctx.clock.advance(60_000);
        expect((await retryFailedUnenrollments(ctx.d)).unenrolled).toBe(1);
        expect(enrolledIn(uid)).toEqual([]);
        // Y una sola vez: ya quedó resuelto.
        ctx.clock.advance(60_000);
        expect((await retryFailedUnenrollments(ctx.d)).orders).toBe(0);
      }
    });
  }

  it("si Moodle falla al deshacerla, el job la reintenta aunque la fila ya diga UNENROLLED", async () => {
    const { o, pm } = await pagoMovil("01343333");
    const real = ctx.moodle.enrol.bind(ctx.moodle);
    const realUnenrol = ctx.moodle.unenrol.bind(ctx.moodle);
    let first = true;
    let failUnenrol = 0;
    ctx.moodle.unenrol = async (userId: number, courseIds: number[]) => {
      if (failUnenrol > 0) {
        failUnenrol--;
        throw new Error("Moodle enrol_manual_unenrol_users: timeout");
      }
      return realUnenrol(userId, courseIds);
    };
    ctx.moodle.enrol = async (userId: number, courseIds: number[]) => {
      if (!first) return real(userId, courseIds);
      first = false;
      await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, reason: "Desiste", unenroll: true, releaseSeat: true, idempotencyKey: "r-undo" });
      await real(userId, courseIds);
      failUnenrol = 1; // el deshacer falla
      throw Object.assign(new Error("Moodle enrol_manual_enrol_users: HTTP 503"), { retryable: true, kind: "http" });
    };
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    const uid = (await ctx.db.customer.findFirstOrThrow({ where: { orders: { some: { id: o.id } } } })).moodleUserId;
    expect(enrolledIn(uid)).toEqual([COURSE_MOODLE_ID]);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: "ATTENTION" } })).toBeGreaterThan(0);
    ctx.clock.advance(60_000);
    await retryFailedUnenrollments(ctx.d);
    expect(enrolledIn(uid)).toEqual([]);
  });
});

describe("reembolso parcial con retiro del programa", () => {
  it("liberar cupo + desmatricular en un reembolso parcial cierra el pedido: saldo 0 y sin recordatorio de cobro", async () => {
    const { o, pm } = await pagoMovil("01024444");
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ENROLLED");
    const r = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, amountCents: 16_200, reason: "Retiro con 10 % de gastos", unenroll: true, releaseSeat: true, idempotencyKey: "partial" });
    expect(r.fullyRefunded).toBe(false);
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after).toMatchObject({ status: "REFUNDED", balanceCents: 0, amountPaidCents: 1_800 });
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe("RELEASED");
    for (let i = 0; i < 3; i++) {
      ctx.clock.advance(8 * 24 * 3_600_000);
      await runInstallmentReminders(ctx.d);
    }
    expect(await ctx.db.emailOutbox.count({ where: { orderId: o.id, template: "installment_reminder" } })).toBe(0);
    // Lo retenido se puede devolver después (reembolso del resto): el pedido sigue cerrado.
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, amountCents: 1_800, reason: "Se devuelve el resto", unenroll: false, releaseSeat: false, idempotencyKey: "rest" });
    expect(await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: "REFUNDED", amountPaidCents: 0 });
  });

  it("un reembolso parcial SIN retiro (cortesía) deja el pedido inscrito", async () => {
    const { o, pm } = await pagoMovil("01025555");
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, amountCents: 1_000, reason: "Cortesía", unenroll: false, releaseSeat: false, idempotencyKey: "courtesy" });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("ENROLLED");
  });
});

describe("referencias bancarias con otro relleno de ceros", () => {
  it("forma canónica y mismo movimiento", () => {
    expect(canonicalReference("0000123456")).toBe("123456");
    expect(canonicalReference(" 00-12.34 56 ")).toBe("123456");
    expect(canonicalReference("ab-0012")).toBe("AB0012");
    expect(sameBankMovement("000030524807", "30524807")).toBe(true);
    expect(sameBankMovement("123456789012", "789012")).toBe(true); // el banco muestra solo los últimos dígitos
    expect(sameBankMovement("123456789012", "9012")).toBe(false); // muy corta para afirmarlo
    expect(sameBankMovement("30524807", "30524808")).toBe(false);
  });

  it("la misma referencia con ceros delante en otro pedido: rechazada; con solo los últimos dígitos: el panel la marca", async () => {
    const a = await pagoMovil("30524807", 1);
    await expect(pagoMovil("000030524807", 2)).rejects.toMatchObject({ code: "VALIDATION" });
    const c = await pagoMovil("9030524807", 3); // otro número que termina igual: pasa, pero el panel avisa
    const view = await getOrderDetail(ctx.d, ctx.fx.admin, c.o.id);
    const card = view.payments.find((p) => p.id === c.pm.id)!;
    expect(card.duplicates.map((x) => x.orderId)).toEqual([a.o.id]);
  });
});
