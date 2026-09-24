// Pieza x1 (defectos del revisor de la base):
//  1. startPaypalPayment extendía la reserva HELD +30 min en CADA llamada, sin aprobar nunca en PayPal:
//     cualquiera con el enlace del pedido podía retener los últimos cupos para siempre. Ahora cada orden
//     PayPal extiende a lo sumo una vez y nunca más allá de un tope absoluto desde placedAt.
//  2. Si core_user_create_users creó la cuenta pero la respuesta se perdió, el reintento la encontraba
//     (created=false) y el correo de acceso salía SIN contraseña. Ahora, si la cuenta la creamos nosotros y
//     nunca entregamos credenciales, se fija una contraseña temporal nueva y se envía.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOUR, MINUTE } from "@/server/deps";
import { createCheckout, getOrder } from "@/server/orders";
import { capturePaypalReturn, PAYPAL_HOLD_CAP_TTLS, startPaypalPayment } from "@/server/payments";
import { enrollOrder, MOODLE_CREATE_REQUESTED, MOODLE_CREATE_UNCONFIRMED, retryDueEnrollments } from "@/server/enrollment";
import { runJobs } from "@/server/jobs";
import type { Mailer, MailMessage } from "@/server/email/mailer";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

class CapturingMailer implements Mailer {
  readonly kind = "capture";
  sent: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.sent.push(msg);
    return { messageId: msg.id };
  }
}

let ctx: TestContext;
let mailer: CapturingMailer;
beforeEach(async () => {
  mailer = new CapturingMailer();
  ctx = await setupContext("x1-hold-creds", { mailer });
});
afterEach(async () => {
  await ctx.dispose();
});

const TTL = 30 * MINUTE;
const CAP = PAYPAL_HOLD_CAP_TTLS * TTL;

const diplomaSemi = (planKind: "FULL" | "HALF" | "MONTHLY" = "FULL", paymentMethod: "PAYPAL" | "PAGO_MOVIL" = "PAYPAL", email?: string) =>
  createCheckout(ctx.d, { customer: { ...buyer(), ...(email ? { email } : {}) }, items: [{ productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.diplomaCohort, planKind }], paymentMethod });
const cohort = () => ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.diplomaCohort } });
const reservation = async (orderId: string) => (await getOrder(ctx.d, orderId)).items[0].reservation!;

describe("retención del cupo al iniciar PayPal: tope por orden PayPal y absoluto desde placedAt", () => {
  it("pulsar «Pagar con PayPal» cada 25 min sin aprobar nunca no retiene el cupo más de 3 × TTL; luego se libera", async () => {
    const o = await diplomaSemi();
    const placed = o.placedAt.getTime();
    let paypalOrders = 0;
    for (let i = 0; i < 6; i++) {
      const now = ctx.clock.now().getTime();
      if (now - placed < CAP) {
        await startPaypalPayment(ctx.d, o.id);
        paypalOrders++;
        const r = await reservation(o.id);
        expect(r.status).toBe("HELD");
        expect(r.expiresAt.getTime()).toBe(Math.min(now + TTL, placed + CAP));
        expect(r.expiresAt.getTime()).toBeLessThanOrEqual(placed + CAP);
        expect((await getOrder(ctx.d, o.id)).expiresAt!.getTime()).toBeLessThanOrEqual(placed + CAP);
      } else {
        await expect(startPaypalPayment(ctx.d, o.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
      }
      ctx.clock.advance(25 * MINUTE);
    }
    // 0, 25, 50, 75 → 4 órdenes PayPal; a los 100 y 125 min ya no se puede extender.
    expect(paypalOrders).toBe(4);
    // Cada extensión corresponde a UNA orden PayPal nueva (nunca más extensiones que órdenes).
    const ext = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "SEAT_HOLD_EXTENDED" } });
    expect(ext.length).toBeGreaterThan(0);
    expect(ext.length).toBeLessThanOrEqual(ctx.paypal.calls.filter((c) => c.fn === "createOrder").length);

    // El barrido libera el cupo y vence el pedido: nadie lo retiene "para siempre".
    const out = await runJobs(ctx.d, ["expire"]);
    expect(out.expire).toMatchObject({ orders: 1 });
    expect((await reservation(o.id)).status).toBe("RELEASED");
    expect((await cohort()).seatsHeld).toBe(0);
    expect((await getOrder(ctx.d, o.id)).status).toBe("EXPIRED");
  });

  it("una reserva ya LIBERADA no se vuelve a tomar pasado el tope (el cupo sigue libre para otros)", async () => {
    const o = await diplomaSemi();
    ctx.clock.advance(CAP + MINUTE);
    // Reserva vencida y barrida, pedido aún sin barrer (carrera con el job): no se re-toma cupo.
    await ctx.db.seatReservation.updateMany({ where: { orderId: o.id }, data: { status: "RELEASED", releasedAt: ctx.clock.now(), releasedReason: "EXPIRED" } });
    await ctx.db.cohort.update({ where: { id: ctx.fx.diplomaCohort }, data: { seatsHeld: 0 } });
    await expect(startPaypalPayment(ctx.d, o.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await cohort()).seatsHeld).toBe(0);
    expect(ctx.paypal.calls.filter((c) => c.fn === "createOrder")).toHaveLength(0);
  });

  it("dentro del tope, aprobar y capturar sigue funcionando: el cupo pasa a ocupado y se matricula", async () => {
    const o = await diplomaSemi();
    ctx.clock.advance(70 * MINUTE);
    const s = await startPaypalPayment(ctx.d, o.id);
    expect((await reservation(o.id)).expiresAt.getTime()).toBe(o.placedAt.getTime() + CAP); // 70 + 30 > 90 → tope
    ctx.paypal.approve(s.paypalOrderId);
    ctx.clock.advance(10 * MINUTE);
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId)).status).toBe("COMPLETED");
    const c = await cohort();
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([0, 1]);
    expect((await getOrder(ctx.d, o.id)).status).toBe("ENROLLED");
  });

  it("un pedido hecho con pago manual (72 h) conserva su plazo al pasar a PayPal, pero no lo supera", async () => {
    const o = await diplomaSemi("FULL", "PAGO_MOVIL");
    const placed = o.placedAt.getTime();
    ctx.clock.advance(71 * HOUR + 50 * MINUTE);
    await startPaypalPayment(ctx.d, o.id);
    expect((await reservation(o.id)).expiresAt.getTime()).toBe(placed + 72 * HOUR);
    ctx.clock.advance(11 * MINUTE);
    await expect(startPaypalPayment(ctx.d, o.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("Moodle creó la cuenta pero la respuesta se perdió", () => {
  async function paidDiploma(planKind: "FULL" | "MONTHLY" = "FULL") {
    const o = await diplomaSemi(planKind);
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    return o;
  }
  const accessMails = (orderId: string) => ctx.db.emailOutbox.findMany({ where: { orderId, template: "platform_access" }, orderBy: { createdAt: "asc" } });

  it("el reintento fija una contraseña temporal NUEVA y el correo de acceso la lleva (una sola vez)", async () => {
    ctx.moodle.loseCreateResponse = 1;
    const o = await paidDiploma("FULL");
    // Primer intento: la cuenta existe en Moodle, pero no lo sabemos → reintento programado, sin correo de acceso.
    expect(ctx.moodle.users.size).toBe(1);
    expect((await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } })).moodleUserId).toBeNull();
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: MOODLE_CREATE_REQUESTED } })).toBe(1);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: MOODLE_CREATE_UNCONFIRMED } })).toBe(1);
    expect(await accessMails(o.id)).toHaveLength(0);
    expect((await getOrder(ctx.d, o.id)).status).toBe("PAID");

    ctx.clock.advance(61_000);
    await retryDueEnrollments(ctx.d);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    expect(cust.moodleUserId).toBe([...ctx.moodle.users.values()][0].id);
    expect(ctx.moodle.passwordResets.map((r) => r.userId)).toEqual([cust.moodleUserId]);
    expect([...(ctx.moodle.enrolments.get(cust.moodleUserId!) ?? [])].sort()).toEqual(ctx.fx.diplomaMoodleIds);
    expect((await getOrder(ctx.d, o.id)).status).toBe("ENROLLED");

    const mails = await accessMails(o.id);
    expect(mails).toHaveLength(1);
    expect(mails[0].secretRef).toMatchObject({ kind: "moodle_temp_password", moodleUserId: cust.moodleUserId });
    const delivered = mailer.sent.find((m) => m.id === mails[0].id)!;
    expect(delivered.text).toContain(`Contraseña temporal: ${ctx.moodle.passwordResets[0].password}`);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "MOODLE_USER" } });
    expect(ev.data).toMatchObject({ created: false, credentialsReset: true });

    // Más reintentos / otra compra del mismo médico: no se vuelve a tocar su contraseña.
    ctx.clock.advance(HOUR);
    await retryDueEnrollments(ctx.d);
    await enrollOrder(ctx.d, o.id);
    expect(ctx.moodle.passwordResets).toHaveLength(1);
  });

  it("si Moodle no responde al fijar la contraseña, no se vincula la cuenta y el siguiente intento lo repite", async () => {
    ctx.moodle.loseCreateResponse = 1;
    ctx.moodle.failReset = 1;
    const o = await paidDiploma("FULL");
    ctx.clock.advance(61_000);
    await retryDueEnrollments(ctx.d); // reset falla → sin vínculo, sin correo
    expect((await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } })).moodleUserId).toBeNull();
    expect(await accessMails(o.id)).toHaveLength(0);
    ctx.clock.advance(3 * 61_000);
    await retryDueEnrollments(ctx.d);
    expect(ctx.moodle.passwordResets).toHaveLength(1);
    const mails = await accessMails(o.id);
    expect(mails).toHaveLength(1);
    expect(mailer.sent.find((m) => m.id === mails[0].id)!.text).toContain(`Contraseña temporal: ${ctx.moodle.passwordResets[0].password}`);
  });

  it("mes a mes: el reintento matricula SOLO el curso 1 y envía la contraseña nueva", async () => {
    ctx.moodle.loseCreateResponse = 1;
    const o = await paidDiploma("MONTHLY");
    ctx.clock.advance(61_000);
    await retryDueEnrollments(ctx.d);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
    expect([...(ctx.moodle.enrolments.get(cust.moodleUserId!) ?? [])]).toEqual([ctx.fx.diplomaMoodleIds[0]]);
    expect(ctx.moodle.passwordResets).toHaveLength(1);
    const [mail] = await accessMails(o.id);
    expect(mailer.sent.find((m) => m.id === mail.id)!.text).toContain(ctx.moodle.passwordResets[0].password);
  });

  it("una cuenta que YA existía en Moodle (alta manual previa) no recibe contraseña nueva", async () => {
    ctx.moodle.users.set("pre@example.com", { id: 77, email: "pre@example.com", firstname: "Ana", lastname: "Pérez" });
    const o = await diplomaSemi("FULL", "PAYPAL", "pre@example.com");
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    expect(ctx.moodle.passwordResets).toHaveLength(0);
    expect(await ctx.db.orderEvent.count({ where: { orderId: o.id, type: MOODLE_CREATE_REQUESTED } })).toBe(0);
    const [mail] = await accessMails(o.id);
    expect(mail.secretRef).toBeNull();
    expect(mail.text).not.toContain("Contraseña temporal");
  });

  it("un alta EN CURSO de otra llamada no dispara el reseteo (esa llamada enviará su contraseña)", async () => {
    const email = "enc@example.com";
    const o = await diplomaSemi("FULL", "PAYPAL", email);
    // Simula otra llamada que acaba de pedir el alta (marcador reciente, sin confirmar aún) y la cuenta ya existe.
    await ctx.db.orderEvent.create({ data: { orderId: o.id, type: MOODLE_CREATE_REQUESTED, note: "alta en curso", createdAt: ctx.clock.now() } });
    ctx.moodle.users.set(email, { id: 88, email, firstname: "x", lastname: "y" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    expect(ctx.moodle.passwordResets).toHaveLength(0);
  });

  it("en modo moodle-email (Moodle envía sus credenciales) nunca se resetea", async () => {
    ctx.moodle.sendsOwnCredentials = true;
    ctx.moodle.loseCreateResponse = 1;
    const o = await paidDiploma("FULL");
    ctx.clock.advance(61_000);
    await retryDueEnrollments(ctx.d);
    expect(ctx.moodle.passwordResets).toHaveLength(0);
    expect((await getOrder(ctx.d, o.id)).status).toBe("ENROLLED");
  });
});

describe("aprobación de PayPal que llega tarde: se asegura el cupo ANTES de capturar", () => {
  const fillCohort = async (capacity: number) => ctx.db.cohort.update({ where: { id: ctx.fx.diplomaCohort }, data: { capacity } });

  it("reserva vencida y cohorte llena: no se captura (no se cobra), no hay sobreventa ni correos", async () => {
    await fillCohort(1);
    const a = await diplomaSemi("FULL", "PAYPAL", "tarde.a@example.com");
    const s = await startPaypalPayment(ctx.d, a.id);
    ctx.clock.advance(TTL + MINUTE);
    await runJobs(ctx.d, ["expire"]);
    expect((await getOrder(ctx.d, a.id)).status).toBe("EXPIRED");
    // Otro médico toma y paga el último cupo.
    const b = await diplomaSemi("FULL", "PAYPAL", "tarde.b@example.com");
    const sb = await startPaypalPayment(ctx.d, b.id);
    ctx.paypal.approve(sb.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, sb.paypalOrderId)).status).toBe("COMPLETED");

    ctx.paypal.approve(s.paypalOrderId);
    const sent = mailer.sent.length;
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId)).status).toBe("FAILED");
    // Otra vez (webhook CHECKOUT.ORDER.APPROVED / conciliación): tampoco.
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId, "webhook")).status).toBe("FAILED");
    expect(ctx.paypal.calls.filter((c) => c.fn === "captureOrder" && JSON.stringify(c.args ?? c).includes(s.paypalOrderId))).toHaveLength(0);
    const pay = await ctx.db.payment.findUniqueOrThrow({ where: { paypalOrderId: s.paypalOrderId } });
    expect(pay).toMatchObject({ status: "CANCELLED", providerStatus: "NOT_CAPTURED" });
    expect(await ctx.db.orderEvent.count({ where: { orderId: a.id, type: "PAYMENT_NOT_CAPTURED" } })).toBe(1);
    expect(await getOrder(ctx.d, a.id)).toMatchObject({ status: "EXPIRED", amountPaidCents: 0 });
    const c = await cohort();
    expect([c.capacity, c.seatsHeld, c.seatsConfirmed]).toEqual([1, 0, 1]);
    expect(mailer.sent.length).toBe(sent);
  });

  it("reserva vencida con cupo libre: se retoma el cupo antes de capturar y se matricula", async () => {
    await fillCohort(1);
    const a = await diplomaSemi();
    const s = await startPaypalPayment(ctx.d, a.id);
    ctx.clock.advance(TTL + MINUTE);
    await runJobs(ctx.d, ["expire"]);
    expect((await cohort()).seatsHeld).toBe(0);
    ctx.paypal.approve(s.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId)).status).toBe("COMPLETED");
    expect(await ctx.db.orderEvent.count({ where: { orderId: a.id, type: "SEAT_REACQUIRED" } })).toBe(1);
    const c = await cohort();
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([0, 1]);
    expect((await getOrder(ctx.d, a.id)).status).toBe("ENROLLED");
  });

  it("pedido cancelado: la aprobación tardía no se captura", async () => {
    const a = await diplomaSemi();
    const s = await startPaypalPayment(ctx.d, a.id);
    await ctx.db.order.update({ where: { id: a.id }, data: { status: "CANCELLED" } });
    ctx.paypal.approve(s.paypalOrderId);
    expect((await capturePaypalReturn(ctx.d, s.paypalOrderId)).status).toBe("FAILED");
    expect(await ctx.db.payment.findUniqueOrThrow({ where: { paypalOrderId: s.paypalOrderId } })).toMatchObject({ status: "CANCELLED", providerStatus: "NOT_CAPTURED" });
    expect((await getOrder(ctx.d, a.id)).amountPaidCents).toBe(0);
  });
});
