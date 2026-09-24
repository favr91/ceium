// x2 crítico 25: Moodle tarda en crear la cuenta al aprobar un pago; MIENTRAS tanto el admin pulsa «Rematricular»
// (force) en otra pestaña, que reclama la misma fila de matrícula y la completa primero. Antes, la llamada que llegaba
// segunda (su UPDATE no cambiaba ninguna fila) enviaba igual un segundo «Ya estás inscrito» del mismo curso. Ahora solo
// avisa de los cursos que ella matriculó — salvo que haya creado la cuenta: su contraseña temporal no se guarda y el
// médico no la recibiría por ningún otro correo.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminRecordManualPayment, adminVerifyPayment } from "@/server/payments";
import { reenrollOrder } from "@/server/enrollment";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-25");
});
afterEach(async () => {
  await ctx.dispose();
});

async function awaitingOrder(email: string, ref: string) {
  const o = await createCheckout(ctx.d, { customer: { ...buyer(), email }, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const pm = await adminRecordManualPayment(ctx.d, ctx.fx.admin, { orderId: o.id, method: "PAGO_MOVIL", reference: ref, bank: "Banesco", amountCents: o.dueNowCents * 100, currency: "VES", exchangeRate: 100 });
  return { order: o, paymentId: pm.id };
}

/** La PRIMERA llamada a findOrCreateUser espera a `release()`; `createdFirst`: Moodle ya creó la cuenta y lo que tarda es la respuesta. */
function slowCreate(createdFirst: boolean) {
  const real = ctx.moodle.findOrCreateUser.bind(ctx.moodle);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inFlight = new Promise<void>((r) => (started = r));
  let armed = true;
  ctx.moodle.findOrCreateUser = async (email, names, hooks) => {
    if (!armed) return real(email, names, hooks);
    armed = false;
    if (createdFirst) {
      const r = await real(email, names, hooks);
      started();
      await gate;
      return r;
    }
    started();
    await gate;
    return real(email, names, hooks);
  };
  return { release, inFlight };
}

const accessMails = (orderId: string) => ctx.db.emailOutbox.findMany({ where: { orderId, template: "platform_access" }, orderBy: { createdAt: "asc" } });

describe("«Rematricular» mientras la matrícula de la aprobación espera a Moodle", () => {
  it("la cuenta la crea «Rematricular»: un solo correo de acceso (con la contraseña), una matrícula", async () => {
    const a = await awaitingOrder("medico.rematricula1@example.com", "01341111");
    const slow = slowCreate(false);
    const approve = adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: a.paymentId, decision: "approve" });
    await slow.inFlight;
    expect((await reenrollOrder(ctx.d, ctx.fx.admin, a.order.id)).status).toBe("ENROLLED");
    slow.release();
    await approve;

    const mails = await accessMails(a.order.id);
    expect(mails.map((m) => m.dedupeKey)).toEqual([`platform_access:${a.order.id}`]);
    expect(mails[0].secretRef).not.toBeNull();
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: a.order.id } })).status).toBe("ENROLLED");
    const uid = (await ctx.db.customer.findFirstOrThrow({ where: { email: "medico.rematricula1@example.com" } })).moodleUserId!;
    expect([...(ctx.moodle.enrolments.get(uid) ?? [])]).toEqual([201]);
  });

  it("la cuenta la creó la aprobación (respuesta lenta): su contraseña temporal igual llega al médico", async () => {
    const a = await awaitingOrder("medico.rematricula2@example.com", "01342222");
    const slow = slowCreate(true);
    const approve = adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: a.paymentId, decision: "approve" });
    await slow.inFlight;
    expect((await reenrollOrder(ctx.d, ctx.fx.admin, a.order.id)).status).toBe("ENROLLED");
    slow.release();
    await approve;

    const mails = await accessMails(a.order.id);
    // «Rematricular» encontró la cuenta (sin contraseña que dar); la aprobación la creó y es la única que la conoce.
    expect(mails.filter((m) => m.secretRef != null)).toHaveLength(1);
    expect(mails.length).toBeLessThanOrEqual(2);
  });
});
