// Quinta revisión: tasa de cambio fijada por el cliente, roles en los servicios que mueven dinero o
// certificados, CRUD completo del catálogo (imágenes y opciones), reembolsos PayPal idempotentes (y el
// webhook que llega antes con las opciones del admin), CAPTURE_PENDING y unicidad de referencias manuales.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/auth";
import { cancelOrder, createCheckout } from "@/server/orders";
import { adjustBalance, reassignCohort, waiveInstallment } from "@/server/corrections";
import { revokeCertificate } from "@/server/certificates";
import { reenrollOrder } from "@/server/enrollment";
import { resendEmail } from "@/server/email";
import {
  adminRecordManualPayment,
  adminVerifyPayment,
  capturePaypalReturn,
  handlePaypalWebhook,
  recordManualPayment,
  refundPayment,
  startPaypalPayment,
  syncPaypalOrder,
} from "@/server/payments";
import {
  addProductImage,
  createProduct,
  deleteCollection,
  deletePlan,
  deleteProduct,
  deleteProductChoice,
  deleteProductImage,
  reorderProductImages,
  upsertCollection,
  upsertPrice,
  upsertProductChoice,
} from "@/server/catalog";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("review5");
});
afterEach(async () => {
  await ctx.dispose();
});

const semiCourse = (method: "PAYPAL" | "PAGO_MOVIL" = "PAGO_MOVIL", planKind: "FULL" | "HALF" = "FULL") =>
  createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind }], paymentMethod: method });

async function paidPaypalSemi() {
  const o = await semiCourse("PAYPAL");
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const pay = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
  expect(pay.status).toBe("COMPLETED");
  return { o, s, pay };
}

describe("pago manual: la tasa la fija la configuración, no el cliente", () => {
  it("Bs 100 con tasa 0.174 enviada por el cliente se acredita con la tasa configurada (100 Bs/USD → 1 USD)", async () => {
    const o = await semiCourse("PAGO_MOVIL", "HALF");
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "EXP-1", amountCents: 10_000, currency: "VES", exchangeRate: "0.174" });
    expect(p.amountUsdCents).toBe(100);
    expect(Number(p.exchangeRate)).toBe(100);
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "PAYMENT_SUBMITTED" } });
    expect(ev.data).toMatchObject({ exchangeRate: 100, declaredExchangeRate: 0.174, amountUsdCents: 100 });
    // Aprobado sin corrección: 1 USD no cubre el primer pago (la mitad).
    await adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p.id, decision: "approve" });
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.amountPaidCents).toBe(100);
    expect(after.status).toBe("PENDING_PAYMENT");
  });

  it("el cliente no puede declarar otra moneda que la del método (Bs como USD)", async () => {
    const o = await semiCourse();
    await expect(recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "EXP-2", amountCents: 18_000, currency: "USD" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("el panel sí puede registrar un pago con otra tasa (queda a nombre del usuario)", async () => {
    const o = await semiCourse();
    const p = await adminRecordManualPayment(ctx.d, ctx.fx.staff, { orderId: o.id, method: "EFECTIVO", amountCents: 1_900_000, currency: "VES", exchangeRate: 105.5 });
    expect(p.amountUsdCents).toBe(Math.round(1_900_000 / 105.5));
    const ev = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "PAYMENT_SUBMITTED" } });
    expect([ev.actorType, ev.actorId]).toEqual(["ADMIN", ctx.fx.staff.id]);
  });
});

describe("roles dentro de los servicios del panel", () => {
  it("STAFF no puede reembolsar, ajustar saldo, condonar cuotas ni revocar certificados", async () => {
    const { pay, o } = await paidPaypalSemi();
    await expect(refundPayment(ctx.d, ctx.fx.staff, { paymentId: pay.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adjustBalance(ctx.d, ctx.fx.staff, o.id, 1000, "cargo")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ins = await ctx.db.installment.findFirstOrThrow({ where: { orderId: o.id } });
    await expect(waiveInstallment(ctx.d, ctx.fx.staff, ins.id, "beca")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(revokeCertificate(ctx.d, ctx.fx.staff, "cualquiera", "motivo")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(ctx.paypal.refunds).toHaveLength(0);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).refundedCents).toBe(0);
  });

  it("un SessionUser falso, desactivado o degradado no pasa aunque diga ADMIN", async () => {
    const { pay } = await paidPaypalSemi();
    const ghost: SessionUser = { id: "no-existe", email: "x@x", name: "X", role: "ADMIN" };
    await expect(refundPayment(ctx.d, ghost, { paymentId: pay.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const staffClaimingAdmin: SessionUser = { ...ctx.fx.staff, role: "ADMIN" };
    await expect(refundPayment(ctx.d, staffClaimingAdmin, { paymentId: pay.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await ctx.db.adminUser.update({ where: { id: ctx.fx.adminId }, data: { active: false } });
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(cancelOrder(ctx.d, ctx.fx.admin, pay.orderId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    // @ts-expect-error: sin sesión
    await expect(adminVerifyPayment(ctx.d, null, { paymentId: pay.id, decision: "approve" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(ctx.paypal.refunds).toHaveLength(0);
  });

  it("STAFF sí verifica pagos, cancela, reasigna cohorte, rematricula y reenvía correos", async () => {
    const o = await semiCourse();
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "ST-1", amountCents: 1_800_000, currency: "VES" });
    await adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p.id, decision: "approve" });
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: p.id } })).verifiedById).toBe(ctx.fx.staff.id);
    await reenrollOrder(ctx.d, ctx.fx.staff, o.id);
    const other = await ctx.db.cohort.create({ data: { productId: ctx.fx.course, sedeId: ctx.fx.sedes.bqto, name: "Otra", startDate: new Date("2026-11-01"), endDate: new Date("2026-11-30"), capacity: 5 } });
    await reassignCohort(ctx.d, ctx.fx.staff, o.items[0].id, other.id, "cambio");
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { orderId: o.id } });
    await resendEmail(ctx.d, ctx.fx.staff, mail.id);
    const o2 = await semiCourse();
    await cancelOrder(ctx.d, ctx.fx.staff, o2.id, "duplicado");
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: o2.id } })).status).toBe("CANCELLED");
  });
});

describe("catálogo: alta/baja, imágenes y opciones", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const photo = () => sharp({ create: { width: 2000, height: 1200, channels: 3, background: "#3a7ca5" } }).png().toBuffer().then((b) => new Uint8Array(b));

  it("alta de programa (sin publicar), imágenes subidas a /uploads, orden y baja con su archivo", async () => {
    const p = await createProduct(ctx.d, ctx.fx.admin, { type: "COURSE", category: "WORKSHOP", title: "Taller de Ecografía Transfontanelar", slug: "taller-transfontanelar", moodleCourseId: 127 });
    expect(p.published).toBe(false);
    await expect(createProduct(ctx.d, ctx.fx.staff, { type: "COURSE", category: "WORKSHOP", title: "X", slug: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createProduct(ctx.d, ctx.fx.admin, { type: "DIPLOMA", category: "WORKSHOP", title: "X", slug: "x" })).rejects.toMatchObject({ code: "VALIDATION" });

    // Se optimiza al subir: WebP en cada ancho + JPG para compartir, con nombre descriptivo y su tamaño real.
    const a = await addProductImage(ctx.d, ctx.fx.admin, p.id, { file: { bytes: await photo() }, alt: "Portada" });
    expect(a.url).toMatch(/^\/uploads\/products\/[a-z0-9]+\/taller-transfontanelar-[0-9a-f]{8}-w1600\.webp$/);
    expect([a.width, a.height]).toEqual([1600, 960]);
    const file = path.join(ctx.d.config.publicUploadsDir, a.url.slice("/uploads/".length));
    const files = [320, 640, 960, 1280, 1600].map((w) => file.replace(/-w1600\.webp$/, `-w${w}.webp`)).concat(file.replace(/-w1600\.webp$/, "-og.jpg"));
    for (const f of files) expect(fs.existsSync(f), f).toBe(true);
    await expect(addProductImage(ctx.d, ctx.fx.admin, p.id, { file: { bytes: new TextEncoder().encode("<script>alert(1)</script>") } })).rejects.toMatchObject({ code: "VALIDATION" });
    // Firma de PNG pero archivo roto: no se guarda nada.
    await expect(addProductImage(ctx.d, ctx.fx.admin, p.id, { file: { bytes: PNG } })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fs.readdirSync(path.dirname(file)).length).toBe(files.length);
    const b = await addProductImage(ctx.d, ctx.fx.admin, p.id, { url: "https://cdn.shopify.com/x.jpg" });
    expect(b.position).toBe(a.position + 1);
    await reorderProductImages(ctx.d, ctx.fx.admin, p.id, [b.id, a.id]);
    expect((await ctx.db.productImage.findMany({ where: { productId: p.id }, orderBy: { position: "asc" } })).map((i) => i.id)).toEqual([b.id, a.id]);
    await expect(reorderProductImages(ctx.d, ctx.fx.admin, p.id, [a.id])).rejects.toMatchObject({ code: "VALIDATION" });
    await deleteProductImage(ctx.d, ctx.fx.admin, a.id);
    for (const f of files) expect(fs.existsSync(f), f).toBe(false);

    await deleteProduct(ctx.d, ctx.fx.admin, p.id, "creado por error");
    expect(await ctx.db.product.findUnique({ where: { id: p.id } })).toBeNull();
    const actions = (await ctx.db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["product.create", "image.create", "image.reorder", "image.delete", "product.delete"]));
  });

  it("opciones de compra (Cursos disponibles) con precio; no se borra lo que ya se vendió", async () => {
    const n1 = await upsertProductChoice(ctx.d, ctx.fx.admin, { productId: ctx.fx.course, groupName: "Cursos disponibles", label: "Nivel 1", moodleCourseIds: [127] });
    const all = await upsertProductChoice(ctx.d, ctx.fx.admin, { productId: ctx.fx.course, groupName: "Cursos disponibles", label: "Todo el taller", moodleCourseIds: [127, 128] });
    expect([n1.position, all.position]).toEqual([0, 1]);
    await expect(upsertProductChoice(ctx.d, ctx.fx.admin, { productId: ctx.fx.course, groupName: "Cursos disponibles", label: "Nivel 1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(upsertProductChoice(ctx.d, ctx.fx.admin, { productId: ctx.fx.diploma, groupName: "G", label: "L" })).rejects.toMatchObject({ code: "VALIDATION" });
    await upsertPrice(ctx.d, ctx.fx.admin, { productId: ctx.fx.course, modality: "ONLINE", choiceId: n1.id, priceCents: 6000 });
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", choiceId: n1.id, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    expect(o.items[0].choiceId).toBe(n1.id);
    await expect(deleteProductChoice(ctx.d, ctx.fx.admin, n1.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await deleteProductChoice(ctx.d, ctx.fx.admin, all.id);
    await expect(deleteProduct(ctx.d, ctx.fx.admin, ctx.fx.course)).rejects.toMatchObject({ code: "CONFLICT" });
    const plan = await ctx.db.paymentPlan.findFirstOrThrow({ where: { productId: ctx.fx.course, kind: "FULL" } });
    await expect(deletePlan(ctx.d, ctx.fx.admin, plan.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const c = await upsertCollection(ctx.d, ctx.fx.admin, { slug: "talleres", title: "Talleres", productIds: [ctx.fx.course] });
    await deleteCollection(ctx.d, ctx.fx.admin, c.id);
    expect(await ctx.db.product.findUnique({ where: { id: ctx.fx.course } })).not.toBeNull();
  });
});

describe("reembolsos PayPal idempotentes", () => {
  it("doble envío simultáneo del mismo reembolso parcial: PayPal reembolsa UNA vez", async () => {
    const { pay } = await paidPaypalSemi();
    const client = ctx.extraClient();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const results = await Promise.allSettled([
      refundPayment({ ...ctx.d, sleep }, ctx.fx.admin, { paymentId: pay.id, amountCents: 2500, reason: "Descuento" }),
      refundPayment({ ...ctx.makeDeps(client), sleep }, ctx.fx.admin, { paymentId: pay.id, amountCents: 2500, reason: "Descuento" }),
    ]).finally(() => client.$disconnect());
    // O el segundo retoma el mismo reembolso (duplicate) o se rechaza como doble envío: nunca reembolsa otra vez.
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "CONFLICT" });
    expect(ctx.paypal.refunds).toHaveLength(1);
    const rows = await ctx.db.refund.findMany({ where: { paymentId: pay.id } });
    expect(rows.map((r) => [r.status, r.amountCents])).toEqual([["COMPLETED", 2500]]);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).refundedCents).toBe(2500);
    const reqIds = ctx.paypal.calls.filter((c) => c.fn === "refundCapture").map((c) => (c.args[2] as { requestId: string }).requestId);
    expect(new Set(reqIds)).toEqual(new Set([`refund-${rows[0].id}`]));
    // Un segundo reembolso igual e intencional requiere confirmarlo.
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 2500 })).rejects.toMatchObject({ code: "CONFLICT" });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 2500, confirmRepeat: true });
    expect(ctx.paypal.refunds).toHaveLength(2);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).refundedCents).toBe(5000);
  }, 60_000);

  it("respuesta perdida (red): la fila queda PENDING, reintentar usa el mismo PayPal-Request-Id y no duplica", async () => {
    const { pay } = await paidPaypalSemi();
    ctx.paypal.refundNetworkErrorAfterRefund = true; // PayPal SÍ reembolsó, pero no nos llegó la respuesta
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 3000 })).rejects.toMatchObject({ code: "PAYMENT_PROVIDER" });
    const pending = await ctx.db.refund.findFirstOrThrow({ where: { paymentId: pay.id } });
    expect(pending.status).toBe("PENDING");
    // Otro monto mientras está en curso → no se abre un segundo reembolso.
    await expect(refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 1000 })).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 3000 });
    expect(r.refund.id).toBe(pending.id);
    expect(ctx.paypal.refunds).toHaveLength(1);
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: pay.id } })).refundedCents).toBe(3000);
  });

  it("la misma clave de idempotencia no reembolsa dos veces (también en métodos manuales)", async () => {
    const { pay } = await paidPaypalSemi();
    const a = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 1000, idempotencyKey: "form-1" });
    const b = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, amountCents: 1000, idempotencyKey: "form-1" });
    expect(b.duplicate).toBe(true);
    expect(b.refund.id).toBe(a.refund.id);
    expect(ctx.paypal.refunds).toHaveLength(1);

    const o = await semiCourse();
    const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "M-0009", amountCents: 1_800_000, currency: "VES" });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, amountCents: 500, idempotencyKey: "form-2" });
    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, amountCents: 500, idempotencyKey: "form-2" });
    expect((await ctx.db.payment.findUniqueOrThrow({ where: { id: p.id } })).refundedCents).toBe(500);
  });

  it("webhook REFUNDED antes de la respuesta: se aplican las opciones del admin (certificado, cupo, matrícula)", async () => {
    const { pay, o } = await paidPaypalSemi();
    const item = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
    const customerId = (await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } })).customerId;
    const cert = await ctx.db.certificate.create({ data: { customerId, diplomaId: ctx.fx.diploma, orderItemId: item.id, code: "CEIUM-TEST-0001" } });
    const original = ctx.paypal.refundCapture.bind(ctx.paypal);
    ctx.paypal.refundCapture = async (captureId: string, amountCents?: number, opts?: { requestId?: string; invoiceId?: string }) => {
      const res = (await original(captureId, amountCents, opts)) as { id: string };
      await handlePaypalWebhook(ctx.d, {}, ctx.paypal.refundEvent(captureId, res.id, amountCents!, undefined, opts?.invoiceId));
      return res;
    };
    const r = await refundPayment(ctx.d, ctx.fx.admin, { paymentId: pay.id, reason: "Cortesía", keepCertificate: true, releaseSeat: false, unenroll: false });
    expect(r.duplicate).toBe(true);
    expect(r.fullyRefunded).toBe(true);
    expect(await ctx.db.refund.count()).toBe(1);
    expect((await ctx.db.certificate.findUniqueOrThrow({ where: { id: cert.id } })).status).toBe("ISSUED");
    const res = await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItemId: item.id } });
    expect(res.status).toBe("CONFIRMED");
    expect(ctx.moodle.calls.filter((c) => c.fn === "unenrol")).toHaveLength(0);
    const refundEv = await ctx.db.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: "REFUND" } });
    expect(refundEv.data).toMatchObject({ requestedById: ctx.fx.adminId, options: { keepCertificate: true, releaseSeat: false, unenroll: false } });
  });
});

describe("PayPal: no se abre otro intento mientras PayPal retiene la captura", () => {
  it("startPaypalPayment rechaza con CAPTURE_PENDING y no cancela el pago retenido", async () => {
    const o = await semiCourse("PAYPAL");
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.captureOutOfBand(s.paypalOrderId, "PENDING");
    expect(await syncPaypalOrder(ctx.d, s.paypalOrderId)).toBe("PENDING");
    await expect(startPaypalPayment(ctx.d, o.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const p = await ctx.db.payment.findUniqueOrThrow({ where: { id: s.paymentId } });
    expect([p.status, p.providerStatus]).toEqual(["PENDING", "CAPTURE_PENDING"]);
    expect(await ctx.db.payment.count({ where: { orderId: o.id } })).toBe(1);
  });
});

describe("referencias de pago manual únicas (índice, no solo lectura previa)", () => {
  it("misma referencia en dos pedidos a la vez: solo una pasa; con espacios/guiones también cuenta; tras rechazo se libera", async () => {
    const [o1, o2] = [await semiCourse(), await semiCourse()];
    const client = ctx.extraClient();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const other = { ...ctx.makeDeps(client), sleep };
    const results = await Promise.allSettled([
      recordManualPayment({ ...ctx.d, sleep }, { orderId: o1.id, method: "PAGO_MOVIL", reference: "00123456", amountCents: 1_800_000, currency: "VES" }),
      recordManualPayment(other, { orderId: o2.id, method: "PAGO_MOVIL", reference: "0012 3456", amountCents: 1_800_000, currency: "VES" }),
    ]).finally(() => client.$disconnect());
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "VALIDATION" });
    const ok = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string; referenceKey: string | null }>).value;
    // Forma canónica: sin ceros a la izquierda (cada banco rellena distinto).
    expect(ok.referenceKey).toBe("PAGO_MOVIL:123456");
    // La misma referencia sin los ceros (o con más) en otro pedido tampoco pasa.
    await expect(recordManualPayment(ctx.d, { orderId: o2.id, method: "PAGO_MOVIL", reference: "123456", amountCents: 1_800_000, currency: "VES" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordManualPayment(ctx.d, { orderId: o2.id, method: "PAGO_MOVIL", reference: "0000123456", amountCents: 1_800_000, currency: "VES" })).rejects.toMatchObject({ code: "VALIDATION" });
    // La BD misma lo impide aunque se salte el servicio.
    await expect(ctx.db.payment.create({ data: { orderId: o2.id, method: "PAGO_MOVIL", status: "AWAITING_VERIFICATION", amountCents: 1, amountUsdCents: 1, referenceKey: "PAGO_MOVIL:123456" } })).rejects.toThrow();
    // Otro método con el mismo número no choca.
    await recordManualPayment(ctx.d, { orderId: o2.id, method: "TRANSFERENCIA", reference: "00123456", amountCents: 1_800_000, currency: "VES" });
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: ok.id, decision: "reject", note: "No aparece en el banco" });
    const o3 = await semiCourse();
    await recordManualPayment(ctx.d, { orderId: o3.id, method: "PAGO_MOVIL", reference: "00-123-456", amountCents: 1_800_000, currency: "VES" });
  }, 60_000);
});
