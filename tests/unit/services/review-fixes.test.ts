// Regresiones de la revisión de la base: conexión única compartida, adjuntos/secretos del outbox,
// certificados recuperables y con saldo 0, carrera de reembolsos, conciliación PayPal, auditoría,
// unicidad de precios y cursos por opción.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MINUTE, withTx } from "@/server/deps";
import { createOutboxMailer, type Mailer, type MailMessage } from "@/server/email/mailer";
import { resendEmail, retryFailedEmails, sendEmail, TEMP_PASSWORD_PLACEHOLDER } from "@/server/email";
import * as T from "@/server/email/templates";
import { createCheckout, expireStaleOrders } from "@/server/orders";
import {
  adminVerifyPayment,
  capturePaypalReturn,
  handlePaypalWebhook,
  recordManualPayment,
  refundPayment,
  startPaypalPayment,
} from "@/server/payments";
import { checkDiplomaCompletion, revokeCertificate, runCertificateSweep } from "@/server/certificates";
import { runJobs } from "@/server/jobs";
import { priceScopeKey } from "@/server/pricing";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

/** Mailer que registra lo que realmente se entrega (y puede fallar las próximas N veces). */
class CapturingMailer implements Mailer {
  readonly kind = "capture";
  sent: MailMessage[] = [];
  failNext = 0;
  constructor(private inner?: Mailer) {}
  async send(msg: MailMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("SMTP 421 servicio no disponible");
    }
    this.sent.push(msg);
    return this.inner ? this.inner.send(msg) : { messageId: msg.id };
  }
}

let ctx: TestContext;
let mailer: CapturingMailer;
beforeEach(async () => {
  mailer = new CapturingMailer();
  ctx = await setupContext("review", { mailer });
});
afterEach(async () => {
  await ctx.dispose();
});

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BD: una sola conexión compartida", () => {
  it("una escritura suelta concurrente NO cae dentro de una transacción ajena que luego falla", async () => {
    const tx = withTx(ctx.d, async (t) => {
      await t.setting.create({ data: { key: "tx.row", value: 1 } });
      await realSleep(300);
      throw new Error("boom");
    });
    await realSleep(50); // la transacción ya está abierta
    const outside = ctx.db.setting.create({ data: { key: "outside.row", value: 2 } });
    await expect(tx).rejects.toThrow("boom");
    await outside;
    expect(await ctx.db.setting.findUnique({ where: { key: "outside.row" } })).not.toBeNull();
    expect(await ctx.db.setting.findUnique({ where: { key: "tx.row" } })).toBeNull();
  });

  it("carrera por el último cupo: el SOLD_OUT del perdedor no borra el correo del ganador", async () => {
    await ctx.db.cohort.update({ where: { id: ctx.fx.courseCohort }, data: { capacity: 1 } });
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        createCheckout(ctx.d, { customer: buyer(900 + i), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof createCheckout>>>[];
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["SOLD_OUT", "SOLD_OUT"]);
    const winner = ok[0].value;
    const mail = await ctx.db.emailOutbox.findMany({ where: { orderId: winner.id, template: "order_confirmation" } });
    expect(mail).toHaveLength(1);
    expect(mail[0].status).toBe("SENT");
    expect(await ctx.db.orderEvent.count({ where: { orderId: winner.id, type: "EMAIL_SENT" } })).toBe(1);
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect([c.seatsHeld, c.seatsConfirmed]).toEqual([1, 0]);
  });

  it("db.$transaction([...]) (lote) se rechaza con un mensaje claro", () => {
    expect(() => ctx.db.$transaction([])).toThrow(/transacción interactiva/);
  });
});

async function paidOnlineCourse(email?: number) {
  const o = await createCheckout(ctx.d, { customer: buyer(email), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  return { order: o, start: s };
}

describe("correo: contraseña temporal y adjuntos", () => {
  it("la contraseña viaja en el correo pero no queda en la BD ni en el .eml", async () => {
    const eml = createOutboxMailer(ctx.mailDir);
    const withEml = new CapturingMailer(eml);
    const d = { ...ctx.d, mailer: withEml };
    const o = await createCheckout(d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(d, s.paypalOrderId);

    const delivered = withEml.sent.find((m) => m.subject.includes("datos de acceso"))!;
    const pw = delivered.text.match(/Contraseña temporal: (\S+)/)![1];
    expect(pw).toMatch(/^Tmp#/);
    expect(delivered.html).toContain(T.esc(pw));
    const row = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id, template: "platform_access" } });
    expect(row.text).toContain(TEMP_PASSWORD_PLACEHOLDER);
    expect(`${row.subject}${row.html}${row.text}`).not.toContain(pw);
    const file = fs.readFileSync(row.emlPath!, "utf8");
    expect(file).not.toContain(pw);
    expect(file).not.toContain(TEMP_PASSWORD_PLACEHOLDER);
  });

  it("si el primer envío falla, el reintento emite una contraseña NUEVA en Moodle (la original no existe)", async () => {
    mailer.failNext = 3; // confirmación, acceso, … fallan
    const { order } = await paidOnlineCourse();
    const row = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: order.id, template: "platform_access" } });
    expect(row.status).toBe("FAILED");
    expect(ctx.moodle.passwordResets).toHaveLength(0);

    await retryFailedEmails(ctx.d);
    const cust = await ctx.db.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    expect(ctx.moodle.passwordResets.map((r) => r.userId)).toEqual([cust.moodleUserId]);
    const delivered = mailer.sent.find((m) => m.id === row.id)!;
    expect(delivered.text).toContain(`Contraseña temporal: ${ctx.moodle.passwordResets[0].password}`);
    expect((await ctx.db.emailOutbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SENT");
  });

  it("reenviar desde el panel: nueva contraseña, adjuntos conservados y el historial registra al admin", async () => {
    const { order } = await paidOnlineCourse();
    const access = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: order.id, template: "platform_access" } });
    const r = await resendEmail(ctx.d, access.id, ctx.fx.adminId);
    expect(r.status).toBe("SENT");
    expect(ctx.moodle.passwordResets).toHaveLength(1);
    expect(mailer.sent.at(-1)!.text).toContain(ctx.moodle.passwordResets[0].password);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: order.id, type: "EMAIL_SENT", actorType: "ADMIN" } });
    expect(ev.actorId).toBe(ctx.fx.adminId);

    // adjuntos: se guardan y viajan en reintentos y reenvíos
    const pdf = path.join(ctx.certDir, "x.pdf");
    fs.mkdirSync(ctx.certDir, { recursive: true });
    fs.writeFileSync(pdf, "%PDF-1.4 prueba");
    mailer.failNext = 1;
    const first = await sendEmail(ctx.d, { template: "certificate_issued", to: "a@example.com", rendered: { subject: "Cert", html: "<p>x</p>", text: "x" }, attachments: [{ filename: "C.pdf", path: pdf, contentType: "application/pdf" }] });
    expect(first.status).toBe("FAILED");
    await retryFailedEmails(ctx.d);
    expect(mailer.sent.at(-1)!.attachments).toEqual([{ filename: "C.pdf", path: pdf, contentType: "application/pdf" }]);
    await resendEmail(ctx.d, first.id, ctx.fx.adminId);
    expect(mailer.sent.at(-1)!.attachments?.[0].filename).toBe("C.pdf");
  });
});

async function diplomaOrder(planKind: "FULL" | "HALF") {
  const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(c.moodleUserId!, id);
  return { order: o, customer: c };
}

describe("certificados", () => {
  it("con saldo pendiente NO se emite aunque complete todo; al pagar el saldo el barrido lo emite", async () => {
    const { order, customer } = await diplomaOrder("HALF");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).balanceCents).toBe(47500);
    const r = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r).toMatchObject({ issued: false, completed: 9, total: 9, blockedByBalance: true });
    expect(r.reason).toMatch(/saldo pendiente \(\$475\.00\)/);
    expect(await ctx.db.certificate.count()).toBe(0);

    const s2 = await startPaypalPayment(ctx.d, order.id);
    expect(s2.amountCents).toBe(47500);
    ctx.paypal.approve(s2.paypalOrderId);
    await capturePaypalReturn(ctx.d, s2.paypalOrderId);
    const sweep = await runCertificateSweep(ctx.d);
    expect(sweep.issued).toBe(1);
  });

  it("el saldo 0 es obligatorio: ningún ajuste lo desactiva (certificates.policy se ignora)", async () => {
    await ctx.db.setting.create({ data: { key: "certificates.policy", value: { requireFullPayment: false } } });
    const { customer } = await diplomaOrder("HALF");
    const r = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r).toMatchObject({ issued: false, completed: 9, blockedByBalance: true });
    expect(await ctx.db.certificate.count()).toBe(0);
  });

  it("una finalización de una matrícula dada de baja (UNENROLLED) no cuenta", async () => {
    const { customer } = await diplomaOrder("FULL");
    // curso 1 completado en una matrícula que luego se dio de baja (p.ej. reembolso de otro pedido)
    await ctx.db.enrollment.update({
      where: { customerId_moodleCourseId: { customerId: customer.id, moodleCourseId: ctx.fx.diplomaMoodleIds[0] } },
      data: { status: "UNENROLLED", completedAt: ctx.clock.now() },
    });
    const r = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r).toMatchObject({ issued: false, completed: 8, total: 9, pendingCourseIds: [ctx.fx.diplomaMoodleIds[0]] });
    expect(await ctx.db.certificate.count()).toBe(0);
    // al volver a matricularse, la finalización vigente sí cuenta
    await ctx.db.enrollment.update({
      where: { customerId_moodleCourseId: { customerId: customer.id, moodleCourseId: ctx.fx.diplomaMoodleIds[0] } },
      data: { status: "ENROLLED" },
    });
    expect((await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma)).issued).toBe(true);
  });

  it("si el PDF falla, el certificado no queda 'emitido y olvidado': el barrido genera el PDF y envía el correo", async () => {
    const { customer, order } = await diplomaOrder("FULL");
    // certificatesDir apunta a un ARCHIVO → mkdir/escritura fallan
    const blocker = path.join(path.dirname(ctx.certDir), "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const broken = { ...ctx.d, config: { ...ctx.d.config, certificatesDir: path.join(blocker, "sub") } };
    const r = await checkDiplomaCompletion(broken, customer.id, ctx.fx.diploma);
    expect(r).toMatchObject({ issued: true, delivery: { pdf: false, emailed: false } });
    let cert = await ctx.db.certificate.findFirstOrThrow();
    expect([cert.pdfPath, cert.emailedAt]).toEqual([null, null]);
    expect(await ctx.db.orderEvent.count({ where: { orderId: order.id, type: "ATTENTION" } })).toBe(1);
    expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } })).toBe(0);
    // el barrido con el disco sano completa la entrega
    const sweep = await runCertificateSweep(ctx.d);
    expect(sweep.redelivered).toBe(1);
    cert = await ctx.db.certificate.findFirstOrThrow();
    expect(fs.existsSync(cert.pdfPath!)).toBe(true);
    expect(cert.emailedAt).not.toBeNull();
    const sent = mailer.sent.find((m) => m.subject.toLowerCase().includes("certificado"))!;
    expect(sent.attachments?.[0]).toMatchObject({ filename: `Certificado-${cert.code}.pdf` });
    expect(await ctx.db.orderEvent.count({ where: { orderId: order.id, type: "CERTIFICATE_ISSUED" } })).toBe(1);
  });

  it("si el correo del certificado falla, el reintento lleva el PDF adjunto", async () => {
    const { customer } = await diplomaOrder("FULL");
    mailer.failNext = 1;
    await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    const row = await ctx.db.emailOutbox.findFirstOrThrow({ where: { template: "certificate_issued" } });
    expect(row.status).toBe("FAILED");
    await runJobs(ctx.d, ["emails", "certificates"]);
    const sent = mailer.sent.find((m) => m.id === row.id)!;
    expect(sent.attachments?.[0].filename).toMatch(/^Certificado-CEIUM-.*\.pdf$/);
    expect(fs.existsSync(sent.attachments![0].path!)).toBe(true);
    expect((await ctx.db.certificate.findFirstOrThrow()).emailedAt).not.toBeNull();
  });

  it("revocar deja auditoría (admin, motivo, fecha) en el historial del pedido", async () => {
    const { customer, order } = await diplomaOrder("FULL");
    const r = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    await revokeCertificate(ctx.d, r.certificateId!, "Plagio en el trabajo final", ctx.fx.adminId);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: order.id, type: "CERTIFICATE_REVOKED" } });
    expect([ev.actorType, ev.actorId, ev.note]).toEqual(["ADMIN", ctx.fx.adminId, "Plagio en el trabajo final"]);
    await expect(revokeCertificate(ctx.d, r.certificateId!, "otra vez", ctx.fx.adminId)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("reembolsos: carrera con el webhook", () => {
  it("si el webhook REFUNDED se aplica antes que el panel, el admin NO ve error y hay un solo reembolso", async () => {
    const { order } = await paidOnlineCourse();
    const pay = await ctx.db.payment.findFirstOrThrow({ where: { orderId: order.id, status: "COMPLETED" } });
    const original = ctx.paypal.refundCapture.bind(ctx.paypal);
    ctx.paypal.refundCapture = async (captureId: string, amountCents?: number) => {
      const res = await original(captureId, amountCents);
      // PayPal notifica antes de que nuestra llamada termine
      await handlePaypalWebhook(ctx.d, {}, ctx.paypal.refundEvent(captureId, res.id, pay.amountUsdCents));
      return res;
    };
    const r = await refundPayment(ctx.d, { paymentId: pay.id, adminId: ctx.fx.adminId, reason: "Retiro" });
    expect(r.duplicate).toBe(true);
    expect(await ctx.db.refund.count()).toBe(1);
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("REFUNDED");
    expect(await ctx.db.orderEvent.count({ where: { orderId: order.id, type: "NOTE", actorType: "ADMIN" } })).toBe(1);
    expect(await ctx.db.emailOutbox.count({ where: { orderId: order.id, template: "refund_issued" } })).toBe(1);
  });
});

describe("PayPal: aprobado pero sin retorno", () => {
  async function approvedNoReturn() {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId); // el comprador cierra la pestaña: no hay retorno ni webhook
    return { order: o, start: s };
  }

  it("el job captura antes de vencer el pedido: matrícula y cupo confirmado", async () => {
    const { order } = await approvedNoReturn();
    ctx.clock.advance(31 * MINUTE); // la reserva ya venció
    const out = (await runJobs(ctx.d)) as { paypal: { captured: number }; expire: { orders: number } };
    expect(out.paypal.captured).toBe(1);
    expect(out.expire.orders).toBe(0);
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: { include: { reservation: true } } } });
    expect(after.status).toBe("ENROLLED");
    expect(after.items[0].reservation!.status).toBe("CONFIRMED");
  });

  it("webhook CHECKOUT.ORDER.APPROVED captura de inmediato (idempotente con el retorno)", async () => {
    const { order, start } = await approvedNoReturn();
    const body = JSON.stringify({ id: "WH-APPROVED-1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: start.paypalOrderId, status: "APPROVED" } });
    const r = await handlePaypalWebhook(ctx.d, {}, body);
    expect(r).toMatchObject({ ok: true });
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ENROLLED");
    expect((await capturePaypalReturn(ctx.d, start.paypalOrderId)).status).toBe("COMPLETED");
    expect(await ctx.db.payment.count({ where: { orderId: order.id, status: "COMPLETED" } })).toBe(1);
  });

  it("captura retenida (CAPTURE_PENDING): visible en el historial y el pedido no vence; al completarse se aplica", async () => {
    const { order, start } = await approvedNoReturn();
    ctx.paypal.captureOutOfBand(start.paypalOrderId, "PENDING");
    ctx.clock.advance(5 * MINUTE);
    const out = (await runJobs(ctx.d, ["paypal"])) as { paypal: { pending: number } };
    expect(out.paypal.pending).toBe(1);
    expect(await ctx.db.orderEvent.count({ where: { orderId: order.id, type: "PAYMENT_PENDING_REVIEW" } })).toBe(1);
    ctx.clock.advance(2 * 60 * MINUTE);
    expect(await expireStaleOrders(ctx.d)).toBe(0);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
    // PayPal libera la captura
    ctx.paypal.orders.get(start.paypalOrderId)!.captureStatus = "COMPLETED";
    await runJobs(ctx.d, ["paypal"]);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("ENROLLED");
  });
});

describe("auditoría de verificación manual", () => {
  it("la corrección del equivalente en USD queda como antes/después", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "R-1", amountCents: 990_000, currency: "VES", exchangeRate: 100 });
    await adminVerifyPayment(ctx.d, { paymentId: p.id, decision: "approve", adminId: ctx.fx.adminId, amountUsdCents: 10000 });
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "PAYMENT_VERIFIED" } });
    expect(ev.data).toMatchObject({ amountUsdCentsBefore: 9900, amountUsdCentsAfter: 10000, corrected: true });
    expect(ev.note).toContain("99.00 → 100.00");
  });
});

describe("catálogo", () => {
  it("no se pueden duplicar precios ONLINE (NULL en sede/opción)", async () => {
    await expect(
      ctx.db.priceEntry.create({ data: { productId: ctx.fx.course, modality: "ONLINE", scopeKey: priceScopeKey({ modality: "ONLINE", sedeId: null }), priceCents: 1 } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("una opción ('Nivel 1') matricula solo en su curso; 'Todo el taller' en ambos", async () => {
    const p = await ctx.db.product.create({ data: { type: "COURSE", category: "WORKSHOP", slug: "taller-tf", title: "Taller Transfontanelar", moodleCourseId: 104, published: true, offersOnline: true, offersSemipresencial: false } });
    const n1 = await ctx.db.productChoice.create({ data: { productId: p.id, groupName: "Cursos disponibles", label: "Nivel 1", position: 0, moodleCourseIds: [127] } });
    const all = await ctx.db.productChoice.create({ data: { productId: p.id, groupName: "Cursos disponibles", label: "Todo el taller", position: 2, moodleCourseIds: [127, 128] } });
    for (const c of [n1, all]) await ctx.db.priceEntry.create({ data: { productId: p.id, modality: "ONLINE", choiceId: c.id, scopeKey: priceScopeKey({ modality: "ONLINE", choiceId: c.id }), priceCents: 20000 } });
    await ctx.db.paymentPlan.create({ data: { productId: p.id, kind: "FULL", label: "Pago único", discountPct: 0, installments: 1 } });

    const buy = async (choiceId: string, i: number) => {
      const o = await createCheckout(ctx.d, { customer: buyer(800 + i), items: [{ productId: p.id, modality: "ONLINE", choiceId, planKind: "FULL" }], paymentMethod: "PAYPAL" });
      const s = await startPaypalPayment(ctx.d, o.id);
      ctx.paypal.approve(s.paypalOrderId);
      await capturePaypalReturn(ctx.d, s.paypalOrderId);
      const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
      return ctx.moodle.enrolments.get(c.moodleUserId!);
    };
    expect(await buy(n1.id, 1)).toEqual(new Set([127]));
    expect(await buy(all.id, 2)).toEqual(new Set([127, 128]));
  });
});
