// Crítico x3 (ronda 2): un certificado revocado por reembolso total no puede dejar al médico sin certificado para
// siempre. Antes: la fila REVOKED (única por cliente+diplomado) hacía que checkDiplomaCompletion y el barrido
// saltaran al médico aunque volviera a comprar, pagara todo y completara los 9 cursos. Ahora: el revocado conserva
// su código (verifica como revocado) y la compra posterior recibe uno NUEVO; una revocación del panel con el
// pedido vigente sigue bloqueando hasta que el panel lo reemita.
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, onPaypalRefundCompleted, recordManualPayment, startPaypalPayment } from "@/server/payments";
import { checkDiplomaCompletion, reissueCertificate, revokeCertificate, runCertificateSweep, verifyCertificate } from "@/server/certificates";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x3critic2");
});
afterEach(async () => {
  await ctx.dispose();
});

async function buyAndPay(b: ReturnType<typeof buyer>) {
  const o = await createCheckout(ctx.d, { customer: b, items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const order = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
  expect(order.status).toBe("ENROLLED");
  const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  return { orderId: o.id, customerId: o.customerId, moodleUserId: c.moodleUserId! };
}
const completeAll = (userId: number) => ctx.fx.diplomaMoodleIds.forEach((id) => ctx.moodle.markCompleted(userId, id));
async function refundAll(orderId: string, refundId: string) {
  const pay = await ctx.db.payment.findFirstOrThrow({ where: { orderId, paypalCaptureId: { not: null } } });
  await onPaypalRefundCompleted(ctx.d, { captureId: pay.paypalCaptureId!, refundId });
  expect((await ctx.db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("REFUNDED");
}
const certs = (customerId: string) => ctx.db.certificate.findMany({ where: { customerId }, orderBy: { issuedAt: "asc" } });
const certMails = () => ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } });

it("reembolso total (revocado) → recompra pagada y completada → certificado NUEVO; el viejo verifica como revocado; sin duplicados", async () => {
  const b = buyer();
  const a = await buyAndPay(b);
  completeAll(a.moodleUserId);
  expect((await runCertificateSweep(ctx.d)).issued).toBe(1);
  const [old] = await certs(a.customerId);
  await refundAll(a.orderId, "REF-X3C2-1");
  expect((await certs(a.customerId)).map((c) => c.status)).toEqual(["REVOKED"]);
  // Sin compra vigente: nada que emitir.
  expect((await runCertificateSweep(ctx.d)).issued).toBe(0);

  const b2 = await buyAndPay(b);
  expect(b2.customerId).toBe(a.customerId);
  completeAll(b2.moodleUserId);
  const r = await runCertificateSweep(ctx.d);
  expect(r.issued).toBe(1);
  expect((await runCertificateSweep(ctx.d)).issued).toBe(0);
  expect(await checkDiplomaCompletion(ctx.d, a.customerId, ctx.fx.diploma)).toMatchObject({ issued: true, alreadyIssued: true, code: r.codes[0] });

  const all = await certs(a.customerId);
  expect(all.map((c) => c.status)).toEqual(["REVOKED", "ISSUED"]);
  expect(all[1].code).not.toBe(old.code);
  const newItem = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: b2.orderId } });
  expect(all[1].orderItemId).toBe(newItem.id);
  expect(all[1].emailedAt).not.toBeNull();
  expect(await certMails()).toBe(2);
  expect((await verifyCertificate(ctx.d, old.code))?.status).toBe("REVOKED");
  expect((await verifyCertificate(ctx.d, all[1].code))?.status).toBe("ISSUED");
  expect(await ctx.db.orderEvent.count({ where: { orderId: b2.orderId, type: "CERTIFICATE_ISSUED" } })).toBe(1);
}, 60_000);

it("compra duplicada: el reembolso de la compra que tenía el certificado no deja sin certificado a la otra compra pagada", async () => {
  const b = buyer();
  const a = await buyAndPay(b);
  // Segunda compra del mismo diplomado con Pago Móvil, aprobada por el staff (la tienda la marca como duplicada).
  const o2 = await createCheckout(ctx.d, { customer: b, items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const due = (await ctx.db.order.findUniqueOrThrow({ where: { id: o2.id } })).balanceCents;
  const pm = await recordManualPayment(ctx.d, { orderId: o2.id, method: "PAGO_MOVIL", reference: "01349999", bank: "Banesco", amountCents: due * 100, currency: "VES", exchangeRate: 100, proofFile: null });
  await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: pm.id, decision: "approve" });
  const b2 = { orderId: o2.id };
  expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe("ENROLLED");
  completeAll(a.moodleUserId);
  await runCertificateSweep(ctx.d);
  const [first] = await certs(a.customerId);
  const itemA = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: a.orderId } });
  expect(first.orderItemId).toBe(itemA.id);
  await refundAll(a.orderId, "REF-X3C2-DUP");
  expect((await ctx.db.order.findUniqueOrThrow({ where: { id: b2.orderId } })).status).toBe("ENROLLED");
  await runCertificateSweep(ctx.d);
  await runCertificateSweep(ctx.d);
  const all = await certs(a.customerId);
  expect(all.map((c) => c.status)).toEqual(["REVOKED", "ISSUED"]);
  const itemB = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: b2.orderId } });
  expect(all[1].orderItemId).toBe(itemB.id);
}, 60_000);

it("revocación del panel con el pedido vigente: el job NO la deshace; el panel la reemite con un código nuevo, una sola vez", async () => {
  const a = await buyAndPay(buyer());
  completeAll(a.moodleUserId);
  await runCertificateSweep(ctx.d);
  const [c1] = await certs(a.customerId);
  await revokeCertificate(ctx.d, ctx.fx.admin, c1.id, "Revocado por error");
  expect((await runCertificateSweep(ctx.d)).issued).toBe(0);
  expect((await checkDiplomaCompletion(ctx.d, a.customerId, ctx.fx.diploma)).issued).toBe(false);
  expect(await certMails()).toBe(1);

  await expect(reissueCertificate(ctx.d, ctx.fx.staff, c1.id, "error")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(reissueCertificate(ctx.d, ctx.fx.admin, c1.id, " ")).rejects.toMatchObject({ code: "VALIDATION" });
  const r = await reissueCertificate(ctx.d, ctx.fx.admin, c1.id, "La revocación fue un error");
  expect(r).toMatchObject({ issued: true, alreadyIssued: false });
  expect(r.code).not.toBe(c1.code);
  await expect(reissueCertificate(ctx.d, ctx.fx.admin, c1.id, "otra vez")).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect((await runCertificateSweep(ctx.d)).issued).toBe(0);
  expect((await certs(a.customerId)).map((c) => c.status)).toEqual(["REVOKED", "ISSUED"]);
  expect(await certMails()).toBe(2);
  expect((await verifyCertificate(ctx.d, c1.code))?.status).toBe("REVOKED");
  const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: a.orderId, type: "CERTIFICATE_ISSUED", note: { contains: "reemitido" } } });
  expect(ev.note).toContain("La revocación fue un error");
}, 60_000);

it("reemisión: sin todos los cursos o con el pedido reembolsado no se emite", async () => {
  const a = await buyAndPay(buyer());
  completeAll(a.moodleUserId);
  await runCertificateSweep(ctx.d);
  const [c1] = await certs(a.customerId);
  await revokeCertificate(ctx.d, ctx.fx.admin, c1.id, "Plagio");
  await refundAll(a.orderId, "REF-X3C2-3");
  await expect(reissueCertificate(ctx.d, ctx.fx.admin, c1.id, "error")).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(await ctx.db.certificate.count({ where: { status: "ISSUED" } })).toBe(0);
}, 60_000);

it("dos emisiones simultáneas del mismo médico tras la recompra: un solo certificado vigente", async () => {
  const b = buyer();
  const a = await buyAndPay(b);
  completeAll(a.moodleUserId);
  await runCertificateSweep(ctx.d);
  await refundAll(a.orderId, "REF-X3C2-4");
  await buyAndPay(b);
  completeAll(a.moodleUserId);
  const other = ctx.makeDeps(ctx.extraClient());
  await Promise.all([runCertificateSweep(ctx.d), runCertificateSweep(other), checkDiplomaCompletion(ctx.d, a.customerId, ctx.fx.diploma), checkDiplomaCompletion(other, a.customerId, ctx.fx.diploma)]).finally(() => other.db.$disconnect());
  expect((await certs(a.customerId)).filter((c) => c.status === "ISSUED")).toHaveLength(1);
  expect(await certMails()).toBe(2);
}, 60_000);
