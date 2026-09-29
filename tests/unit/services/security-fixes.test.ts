// Correcciones de la revisión de seguridad: congelamiento por el monto (ReDoS), acaparamiento de cupos, límites del
// pago manual, aprobación con monto inflado, contracargos de PayPal, HTML de descripciones, imágenes de otro
// programa, comprobantes (contenido real, sin metadatos), mensajes firmados, datos parciales y configuración.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskCedula, maskPhone } from "@/components/checkout/mask";
import { parseAmountCents } from "@/components/checkout/manual-payment-fields";
import { addProductImage, createProduct, updateProduct } from "@/server/catalog";
import { productionConfigProblems } from "@/server/config-check";
import { errorParams, verifiedMessage } from "@/server/flash";
import { BodyTooLargeError, readTextLimited } from "@/server/http-body";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, capturePaypalReturn, handlePaypalWebhook, recordManualPayment, startPaypalPayment, storeProofFile } from "@/server/payments";
import { clientIp } from "@/server/client-ip";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("security-fixes");
});
afterEach(async () => {
  await ctx.dispose();
});

const onlineCourse = (email?: string) =>
  createCheckout(ctx.d, { customer: email ? { ...buyer(), email } : buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });

describe("entradas del pago manual", () => {
  it("un monto de millones de espacios ya no congela el servidor (y los montos normales siguen igual)", () => {
    const t = Date.now();
    expect(parseAmountCents("1" + " ".repeat(5_000_000) + "1")).toBeNaN();
    expect(Date.now() - t).toBeLessThan(200);
    expect(parseAmountCents("Bs. 33.564,60")).toBe(3356460);
    expect(parseAmountCents("150 USD")).toBe(15000);
  });

  it("el cliente no declara efectivo, los datos del pagador tienen largo máximo y hay a lo sumo 3 comprobantes en verificación", async () => {
    const o = await onlineCourse();
    const base = { orderId: o.id, method: "PAGO_MOVIL" as const, amountCents: 500_000, currency: "VES" as const, exchangeRate: 100 };
    await expect(recordManualPayment(ctx.d, { ...base, method: "EFECTIVO", currency: "USD", amountCents: 100 })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("personal de la sede") });
    await expect(recordManualPayment(ctx.d, { ...base, reference: "11112222", bank: "B".repeat(200) })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("banco") });
    for (const ref of ["10000001", "10000002", "10000003"]) await recordManualPayment(ctx.d, { ...base, reference: ref });
    await expect(recordManualPayment(ctx.d, { ...base, reference: "10000004" })).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringContaining("en verificación") });
  });
});

describe("acaparamiento de cupos y pedidos ajenos", () => {
  it("un correo tiene a lo sumo 3 pedidos sin pagar; el «mismo checkout» solo se reutiliza en los 2 minutos siguientes", async () => {
    const email = "acaparador@example.com";
    const who = { ...buyer(), email };
    const semi = () =>
      createCheckout(ctx.d, { customer: who, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL", reusePendingTwin: true });
    const a = await semi();
    expect((await semi()).id).toBe(a.id); // doble clic: el mismo pedido
    ctx.clock.advance(3 * 60_000);
    const b = await semi(); // más tarde: pedido nuevo (no entrega el de antes)
    expect(b.id).not.toBe(a.id);
    const c = await onlineCourse(email);
    // Cuarto pedido sin pagar del mismo correo: reemplaza al más viejo (se cancela y libera su cupo).
    const d4 = await onlineCourse(email);
    const status = async (id: string) => (await ctx.db.order.findUniqueOrThrow({ where: { id } })).status;
    expect([await status(a.id), await status(b.id), await status(c.id), await status(d4.id)]).toEqual(["CANCELLED", "PENDING_PAYMENT", "PENDING_PAYMENT", "PENDING_PAYMENT"]);
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItem: { orderId: a.id } } })).status).toBe("RELEASED");
    // Con pagos en curso en todos, no se reemplaza ninguno: se pide esperar.
    for (const [i, id] of [b.id, c.id, d4.id].entries()) await recordManualPayment(ctx.d, { orderId: id, method: "PAGO_MOVIL", reference: `3000000${i}`, amountCents: 100_000, currency: "VES", exchangeRate: 100 });
    await expect(onlineCourse(email)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("pagos en curso") });
  });
});

describe("aprobación y contracargos", () => {
  it("el personal puede bajar el equivalente en USD pero no subirlo; un administrador sí", async () => {
    const mk = async (ref: string) => {
      const o = await onlineCourse();
      return recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: ref, amountCents: 500_000, currency: "VES", exchangeRate: 100 });
    };
    const p1 = await mk("20000001");
    await expect(adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p1.id, decision: "approve", amountUsdCents: p1.amountUsdCents + 5000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await adminVerifyPayment(ctx.d, ctx.fx.staff, { paymentId: p1.id, decision: "approve", amountUsdCents: p1.amountUsdCents - 100 });
    const p2 = await mk("20000002");
    await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p2.id, decision: "approve", amountUsdCents: p2.amountUsdCents + 5000 });
  });

  it("contracargo de PayPal (PAYMENT.CAPTURE.REVERSED): se descuenta como reembolso y queda un aviso", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, o.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const pay = await ctx.db.payment.findFirstOrThrow({ where: { orderId: o.id, status: "COMPLETED" } });
    const evt = JSON.parse(ctx.paypal.refundEvent(pay.paypalCaptureId!, "REV-1", pay.amountUsdCents));
    evt.event_type = "PAYMENT.CAPTURE.REVERSED";
    await handlePaypalWebhook(ctx.d, {}, JSON.stringify(evt));
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe("REFUNDED");
    const events = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "ATTENTION" } });
    expect(events.some((e) => /contracargo/i.test(e.note ?? ""))).toBe(true);
  });
});

describe("catálogo y comprobantes", () => {
  it("la descripción se guarda sin scripts ni atributos peligrosos; no se enlaza una imagen subida a otro programa", async () => {
    const p = await createProduct(ctx.d, ctx.fx.admin, { type: "COURSE", category: "WORKSHOP", title: "Taller X", slug: "taller-x" });
    await updateProduct(ctx.d, ctx.fx.admin, p.id, { descriptionHtml: '<p>Hola <img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a></p>' });
    const saved = (await ctx.db.product.findUniqueOrThrow({ where: { id: p.id } })).descriptionHtml;
    expect(saved).not.toMatch(/onerror|<script|javascript:|<img/i);
    expect(saved).toContain("<p>Hola");
    await expect(addProductImage(ctx.d, ctx.fx.admin, p.id, { url: "/uploads/products/otroprograma/foto-abcd1234-w1600.webp" })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("otro programa") });
  });

  it("el comprobante se valida por contenido y la foto pierde los metadatos (GPS); se guarda solo legible por el servidor", async () => {
    const o = await onlineCourse();
    await expect(storeProofFile(ctx.d, o.id, "captura.jpg", new Uint8Array(Buffer.from("<html><script>alert(1)</script></html>")))).rejects.toMatchObject({ code: "VALIDATION" });
    const withGps = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#ccc" } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: "Telefono" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "10/1 4/1 0/1" } } })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();
    const stored = await storeProofFile(ctx.d, o.id, "foto.jpg", new Uint8Array(withGps));
    const file = path.resolve(stored);
    expect((await sharp(fs.readFileSync(file)).metadata()).exif).toBeUndefined();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    void TINY_JPEG;
  });
});

describe("utilidades", () => {
  it("mensajes en la URL: solo se muestran los firmados por el servidor", () => {
    const p = errorParams("La referencia ya fue registrada.");
    expect(verifiedMessage(p.motivo, p.firma)).toBe("La referencia ya fue registrada.");
    expect(verifiedMessage("Paga por Zelle a estafador@x.com", p.firma)).toBeNull();
    expect(verifiedMessage("Paga por Zelle a estafador@x.com", null)).toBeNull();
  });

  it("cédula y teléfono parciales en páginas públicas", () => {
    expect(maskCedula("V-17845120")).toBe("V-•••••120");
    expect(maskPhone("0414-5087731")).toBe("0414-•••••31");
    expect(maskCedula(null)).toBeNull();
  });

  it("IP del cliente: la que agrega el proxy, no la que escribe el visitante; sin proxy, desconocida", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.9" }))).toBe("10.0.0.9");
    expect(clientIp(new Headers({ "x-real-ip": "200.1.2.3", "x-forwarded-for": "6.6.6.6" }))).toBe("200.1.2.3");
    expect(clientIp(new Headers())).toBeNull();
    expect(clientIp(new Headers({ "x-forwarded-for": "::1" }))).toBeNull(); // la que pone Next sin proxy
    expect(clientIp(new Headers({ "x-forwarded-for": "190.1.2.3, 127.0.0.1" }))).toBeNull();
  });

  it("cuerpos con tope de tamaño aunque no declaren Content-Length", async () => {
    const big = new Request("http://x/", { method: "POST", body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(200_000)); c.close(); } }), duplex: "half" } as RequestInit);
    await expect(readTextLimited(big, 128 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(await readTextLimited(new Request("http://x/", { method: "POST", body: '{"a":1}' }), 1024)).toBe('{"a":1}');
  });

  it("configuración de producción: secretos de ejemplo, PayPal o Moodle simulados y correo sin configurar", () => {
    const r = productionConfigProblems({ NODE_ENV: "production", APP_URL: "https://ceium.net", SESSION_SECRET: "x".repeat(40), PAYPAL_BASE_URL: "http://localhost:4020", PAYPAL_WEBHOOK_ID: "WH123" } as unknown as NodeJS.ProcessEnv);
    expect(r.errors.join(" ")).toMatch(/simulador local/);
    expect(r.warnings.join(" ")).toMatch(/correo no está configurado/);
    expect(productionConfigProblems({ NODE_ENV: "production", APP_URL: "http://ceium.net" } as unknown as NodeJS.ProcessEnv).errors.join(" ")).toMatch(/https/);
    expect(productionConfigProblems({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toEqual({ errors: [], warnings: [] });
  });
});
