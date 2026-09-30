// Cliente PayPal (src/server/paypal) contra mocks/paypal: mismas rutas y formas que la API real.
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPaypalMock } from "../../mocks/paypal/server.mjs";
import { PayPalApiError, PayPalClient, centsToValue, valueToCents } from "@/server/paypal";
import type { WebhookEvent } from "@/server/paypal";

type Received = { headers: http.IncomingHttpHeaders; body: string };

let mock: ReturnType<typeof createPaypalMock>;
let base: string;
let receiver: http.Server;
let received: Received[] = [];
let tokenCalls = 0;
let client: PayPalClient;

const countingFetch: typeof fetch = (input, init) => {
  if (String(input).endsWith("/v1/oauth2/token")) tokenCalls++;
  return fetch(input, init);
};

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const orderInput = (over: Partial<Parameters<PayPalClient["createOrder"]>[0]> = {}) => ({
  amountCents: 18000,
  referenceId: "ord_abc123",
  invoiceId: `CEIUM-1001-${Math.random().toString(36).slice(2, 8)}`,
  description: "Curso de Ecografía Básica — Barquisimeto",
  items: [{ name: "Curso de Ecografía Básica", unitAmountCents: 18000, sku: "prod_1" }],
  returnUrl: "http://localhost:3000/checkout/paypal/return?o=ord_abc123",
  cancelUrl: "http://localhost:3000/checkout/paypal/cancel?o=ord_abc123",
  ...over,
});

async function approve(orderId: string, capture?: string) {
  const r = await fetch(`${base}/__mock/approve/${orderId}${capture ? `?capture=${capture}` : ""}`, { redirect: "manual" });
  return r;
}

async function paidCapture(amountCents = 18000) {
  const order = await client.createOrder(orderInput({ amountCents, items: undefined }));
  await approve(order.id);
  return client.captureOrder(order.id);
}

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, r));
  const rport = (receiver.address() as { port: number }).port;
  mock = createPaypalMock({
    clientId: "cid",
    clientSecret: "csecret",
    webhookId: "WH-ID-TEST",
    webhookTarget: `http://localhost:${rport}/api/webhooks/paypal`,
    webhookDelayMs: 5,
  });
  base = (await mock.listen(0)).url;
});

afterAll(async () => {
  await mock.close();
  await new Promise((r) => receiver.close(r));
});

beforeEach(async () => {
  await fetch(`${base}/__mock/reset`, { method: "POST" });
  received = [];
  tokenCalls = 0;
  client = new PayPalClient({ baseUrl: base, clientId: "cid", clientSecret: "csecret", webhookId: "WH-ID-TEST", fetch: countingFetch });
});

describe("dinero", () => {
  it("convierte centavos ↔ value de PayPal", () => {
    expect(centsToValue(18000)).toBe("180.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(valueToCents("180.00")).toBe(18000);
    expect(valueToCents("180.5")).toBe(18050);
    expect(valueToCents("7")).toBe(700);
    expect(() => centsToValue(1.5)).toThrow();
  });
});

describe("OAuth", () => {
  it("cachea el access token entre llamadas", async () => {
    const o = await client.createOrder(orderInput());
    await client.getOrder(o.id);
    await client.getOrder(o.id);
    expect(tokenCalls).toBe(1);
  });

  it("credenciales inválidas → invalid_client", async () => {
    const bad = new PayPalClient({ baseUrl: base, clientId: "cid", clientSecret: "nope" });
    const err = await bad.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(401);
    expect(err.errorName).toBe("invalid_client");
  });

  it("la respuesta del token tiene la forma real", async () => {
    const r = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from("cid:csecret").toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const b = await r.json();
    expect(b).toMatchObject({ token_type: "Bearer", expires_in: 32400 });
    expect(b.access_token).toMatch(/^A21AA/);
    expect(typeof b.app_id).toBe("string");
  });

  it("sin Bearer → 401 AUTHENTICATION_FAILURE", async () => {
    const r = await fetch(`${base}/v2/checkout/orders/XYZ`);
    expect(r.status).toBe(401);
    expect((await r.json()).name).toBe("AUTHENTICATION_FAILURE");
  });

  it("si el token es revocado reintenta con uno nuevo de forma transparente", async () => {
    const o = await client.createOrder(orderInput());
    await fetch(`${base}/__mock/revoke-tokens`, { method: "POST" });
    const got = await client.getOrder(o.id);
    expect(got.id).toBe(o.id);
    expect(tokenCalls).toBe(2);
  });
});

describe("Orders v2", () => {
  it("createOrder envía intent CAPTURE + experience_context y devuelve payer-action", async () => {
    const o = await client.createOrder(orderInput());
    expect(o.id).toMatch(/^[A-Z0-9]{17}$/);
    expect(o.status).toBe("PAYER_ACTION_REQUIRED");
    expect(o.approveUrl).toBe(`${base}/checkoutnow?token=${o.id}`);
    const pu = o.raw.purchase_units![0];
    expect(pu.reference_id).toBe("ord_abc123");
    expect(pu.custom_id).toBe("ord_abc123");
    expect(pu.amount).toMatchObject({ currency_code: "USD", value: "180.00", breakdown: { item_total: { currency_code: "USD", value: "180.00" } } });
    expect(o.raw.intent).toBe("CAPTURE");
    const body = PayPalClient.buildCreateOrderBody(orderInput());
    expect(body.payment_source?.paypal.experience_context).toMatchObject({
      return_url: expect.stringContaining("/checkout/paypal/return"),
      cancel_url: expect.stringContaining("/checkout/paypal/cancel"),
      shipping_preference: "NO_SHIPPING",
      user_action: "PAY_NOW",
      locale: "es-VE",
    });
  });

  it("acepta application_context legado y Prefer minimal (rel approve, status CREATED)", async () => {
    const token = await client.getAccessToken();
    const r = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: "USD", value: "90.00" } }],
        application_context: { return_url: "http://x.test/ok", cancel_url: "http://x.test/ko" },
      }),
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(Object.keys(b).sort()).toEqual(["id", "links", "status"]);
    expect(b.status).toBe("CREATED");
    expect(b.links.map((l: { rel: string }) => l.rel)).toEqual(["self", "approve", "update", "capture"]);
    const loc = (await approve(b.id)).headers.get("location")!;
    expect(loc).toMatch(new RegExp(`^http://x.test/ok\\?token=${b.id}&PayerID=[A-Z0-9]{13}$`));
  });

  it("PayPal-Request-Id hace idempotente la creación", async () => {
    const a = await client.createOrder(orderInput({ requestId: "req-1" }));
    const b = await client.createOrder(orderInput({ requestId: "req-1" }));
    expect(b.id).toBe(a.id);
  });

  it("valida el cuerpo con errores INVALID_REQUEST / UNPROCESSABLE_ENTITY reales", async () => {
    const token = await client.getAccessToken();
    const post = (body: unknown) =>
      fetch(`${base}/v2/checkout/orders`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let r = await post({ purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] });
    let b = await r.json();
    expect(r.status).toBe(400);
    expect(b).toMatchObject({ name: "INVALID_REQUEST", details: [{ field: "/intent", issue: "MISSING_REQUIRED_PARAMETER", location: "body" }] });
    expect(b.debug_id).toBeTruthy();
    r = await post({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: 12 } }] });
    b = await r.json();
    expect(b.details[0].issue).toBe("INVALID_PARAMETER_SYNTAX");
    r = await post({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00", breakdown: { item_total: { currency_code: "USD", value: "9.00" } } } }] });
    b = await r.json();
    expect(r.status).toBe(422);
    expect(b).toMatchObject({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AMOUNT_MISMATCH" }] });
    expect(() => PayPalClient.buildCreateOrderBody(orderInput({ amountCents: 100 }))).toThrow(/suma de ítems/);
  });

  it("orden inexistente → RESOURCE_NOT_FOUND", async () => {
    const err = await client.getOrder("NOPE0000000000000").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(404);
    expect(err.errorName).toBe("RESOURCE_NOT_FOUND");
    expect(err.issue).toBe("INVALID_RESOURCE_ID");
  });

  it("capturar sin aprobación → 422 ORDER_NOT_APPROVED", async () => {
    const o = await client.createOrder(orderInput());
    const err = await client.captureOrder(o.id).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(422);
    expect(err.issue).toBe("ORDER_NOT_APPROVED");
  });

  it("página /checkoutnow muestra el monto y aprueba → redirige a return_url con token y PayerID", async () => {
    const o = await client.createOrder(orderInput());
    const html = await (await fetch(o.approveUrl)).text();
    expect(html).toContain("180.00 USD");
    expect(html).toContain("Pagar a CEIUM");
    expect(html).toContain(`/__mock/approve/${o.id}`);
    const r = await fetch(`${base}/__mock/approve/${o.id}`, { method: "POST", redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/checkout/paypal/return");
    expect(loc.searchParams.get("o")).toBe("ord_abc123");
    expect(loc.searchParams.get("token")).toBe(o.id);
    expect(loc.searchParams.get("PayerID")).toMatch(/^[A-Z0-9]{13}$/);
    expect((await client.getOrder(o.id)).status).toBe("APPROVED");
  });

  it("cancelar → redirige a cancel_url?token= y la orden no se puede capturar", async () => {
    const o = await client.createOrder(orderInput());
    const r = await fetch(`${base}/__mock/deny/${o.id}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.pathname).toBe("/checkout/paypal/cancel");
    expect(loc.searchParams.get("token")).toBe(o.id);
    await expect(client.captureOrder(o.id)).rejects.toMatchObject({ issue: "ORDER_NOT_APPROVED" });
  });

  it("captura: purchase_units[0].payments.captures[0] con montos, comisión y payer", async () => {
    const o = await client.createOrder(orderInput());
    await approve(o.id);
    const c = await client.captureOrder(o.id);
    expect(c.orderStatus).toBe("COMPLETED");
    expect(c.captureStatus).toBe("COMPLETED");
    expect(c.captureId).toMatch(/^[A-Z0-9]{17}$/);
    expect(c.amountCents).toBe(18000);
    expect(c.feeCents! + c.netCents!).toBe(18000);
    expect(c.payerEmail).toContain("@");
    expect(c.payerId).toMatch(/^[A-Z0-9]{13}$/);
    expect(c.capture).toMatchObject({
      final_capture: true,
      custom_id: "ord_abc123",
      seller_protection: { status: "ELIGIBLE" },
      seller_receivable_breakdown: { gross_amount: { value: "180.00", currency_code: "USD" } },
    });
    expect(c.capture!.links!.map((l) => l.rel)).toEqual(["self", "refund", "up"]);
    const got = await client.getCapture(c.captureId!);
    expect(got.status).toBe("COMPLETED");
  });

  it("captura idempotente con el mismo PayPal-Request-Id; otra captura → ORDER_ALREADY_CAPTURED", async () => {
    const o = await client.createOrder(orderInput());
    await approve(o.id);
    const a = await client.captureOrder(o.id);
    const b = await client.captureOrder(o.id);
    expect(b.captureId).toBe(a.captureId);
    const err = await client.captureOrder(o.id, { requestId: "otro" }).catch((e) => e);
    expect(err.issue).toBe("ORDER_ALREADY_CAPTURED");
  });

  it("tarjeta rechazada → 422 INSTRUMENT_DECLINED (también vía PayPal-Mock-Response)", async () => {
    const o = await client.createOrder(orderInput());
    await approve(o.id, "INSTRUMENT_DECLINED");
    await expect(client.captureOrder(o.id)).rejects.toMatchObject({ status: 422, issue: "INSTRUMENT_DECLINED" });
  });
});

describe("Webhooks", () => {
  it("tras capturar, envía PAYMENT.CAPTURE.COMPLETED firmado que verifica SUCCESS", async () => {
    const c = await paidCapture();
    const w = await waitFor(() => received[0]);
    expect(w.headers["paypal-transmission-id"]).toBeTruthy();
    expect(w.headers["paypal-transmission-sig"]).toBeTruthy();
    expect(w.headers["paypal-auth-algo"]).toBe("SHA256withRSA");
    expect(w.headers["paypal-cert-url"]).toMatch(/^https:\/\/api\.sandbox\.paypal\.com\/v1\/notifications\/certs\//);
    const ev = JSON.parse(w.body) as WebhookEvent<{ id: string; status: string; custom_id: string; supplementary_data: { related_ids: { order_id: string } } }>;
    expect(ev).toMatchObject({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource_version: "2.0", event_version: "1.0" });
    expect(ev.id).toMatch(/^WH-/);
    expect(ev.resource.id).toBe(c.captureId);
    expect(ev.resource.custom_id).toBe("ord_abc123");
    expect(ev.resource.supplementary_data.related_ids.order_id).toBe(c.orderId);
    const v = await client.verifyWebhookSignature({ headers: w.headers as Record<string, string>, body: w.body });
    expect(v).toMatchObject({ verified: true, status: "SUCCESS" });
    // también con Headers de fetch y evento ya parseado
    const v2 = await client.verifyWebhookSignature({ headers: new Headers(w.headers as Record<string, string>), body: ev });
    expect(v2.verified).toBe(true);
  });

  it("FAILURE si se altera el cuerpo, la firma, el webhook_id o faltan cabeceras", async () => {
    await paidCapture();
    const w = await waitFor(() => received[0]);
    const h = w.headers as Record<string, string>;
    const tampered = JSON.parse(w.body);
    tampered.resource.amount.value = "0.01";
    expect((await client.verifyWebhookSignature({ headers: h, body: JSON.stringify(tampered) })).verified).toBe(false);
    expect((await client.verifyWebhookSignature({ headers: { ...h, "paypal-transmission-sig": "Zm9v" }, body: w.body })).verified).toBe(false);
    expect((await client.verifyWebhookSignature({ headers: { ...h, "paypal-transmission-time": new Date().toISOString() }, body: w.body })).verified).toBe(false);
    expect((await client.verifyWebhookSignature({ headers: h, body: w.body, webhookId: "OTRO" })).verified).toBe(false);
    const { ["paypal-transmission-sig"]: _omit, ...noSig } = h;
    void _omit;
    expect((await client.verifyWebhookSignature({ headers: noSig, body: w.body })).verified).toBe(false);
    // evento inventado con cabeceras de otra transmisión
    const forged = { ...JSON.parse(w.body), id: "WH-FORGED" };
    expect((await client.verifyWebhookSignature({ headers: h, body: forged })).verified).toBe(false);
  });

  it("verify-webhook-signature sin campos requeridos → 400 INVALID_REQUEST", async () => {
    const token = await client.getAccessToken();
    const r = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ webhook_id: "WH-ID-TEST" }),
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.name).toBe("INVALID_REQUEST");
    expect(b.details.map((d: { field: string }) => d.field)).toContain("transmission_sig");
  });

  it("/__mock/send-webhook/:captureId reenvía (y tamper=signature produce FAILURE)", async () => {
    await fetch(`${base}/__mock/config`, { method: "POST", body: JSON.stringify({ autoWebhooks: false }) });
    const c = await paidCapture();
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(0);
    const sent = await (await fetch(`${base}/__mock/send-webhook/${c.captureId}`, { method: "POST" })).json();
    expect(sent.status).toBe(200);
    expect(sent.event.event_type).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect(received).toHaveLength(1);
    expect((await client.verifyWebhookSignature({ headers: received[0].headers as Record<string, string>, body: received[0].body })).verified).toBe(true);
    await fetch(`${base}/__mock/send-webhook/${c.captureId}?tamper=signature`, { method: "POST" });
    expect((await client.verifyWebhookSignature({ headers: received[1].headers as Record<string, string>, body: received[1].body })).verified).toBe(false);
    const denied = await (await fetch(`${base}/__mock/send-webhook/${c.captureId}?event_type=PAYMENT.CAPTURE.DENIED`, { method: "POST" })).json();
    expect(denied.event).toMatchObject({ event_type: "PAYMENT.CAPTURE.DENIED", resource: { status: "DECLINED" } });
  });

  it("captura PENDING → al completarse llega PAYMENT.CAPTURE.COMPLETED", async () => {
    const o = await client.createOrder(orderInput());
    await approve(o.id, "PENDING");
    const c = await client.captureOrder(o.id);
    expect(c.captureStatus).toBe("PENDING");
    expect(c.capture?.status_details?.reason).toBe("PENDING_REVIEW");
    const pend = await waitFor(() => received[0]);
    expect(JSON.parse(pend.body).event_type).toBe("PAYMENT.CAPTURE.PENDING");
    await fetch(`${base}/__mock/captures/${c.captureId}/complete`, { method: "POST" });
    const done = JSON.parse(received[1].body);
    expect(done.event_type).toBe("PAYMENT.CAPTURE.COMPLETED");
    expect((await client.getCapture(c.captureId!)).status).toBe("COMPLETED");
  });
});

describe("Reembolsos", () => {
  it("parcial → PARTIALLY_REFUNDED, resto → REFUNDED, luego CAPTURE_FULLY_REFUNDED; webhook REFUNDED verificable", async () => {
    const c = await paidCapture(18000);
    await waitFor(() => received[0]);
    const r1 = await client.refundCapture(c.captureId!, { amountCents: 5000, noteToPayer: "Ajuste" });
    expect(r1).toMatchObject({ status: "COMPLETED", amount: { value: "50.00", currency_code: "USD" }, note_to_payer: "Ajuste" });
    expect(r1.id).toMatch(/^[A-Z0-9]{17}$/);
    expect((await client.getCapture(c.captureId!)).status).toBe("PARTIALLY_REFUNDED");
    await expect(client.refundCapture(c.captureId!, { amountCents: 20000 })).rejects.toMatchObject({ status: 422, issue: "REFUND_AMOUNT_EXCEEDED" });
    const r2 = await client.refundCapture(c.captureId!);
    expect(r2.amount?.value).toBe("130.00");
    expect(r2.seller_payable_breakdown?.total_refunded_amount?.value).toBe("180.00");
    expect((await client.getCapture(c.captureId!)).status).toBe("REFUNDED");
    expect((await client.getRefund(r2.id)).status).toBe("COMPLETED");
    await expect(client.refundCapture(c.captureId!)).rejects.toMatchObject({ issue: "CAPTURE_FULLY_REFUNDED" });
    const w = await waitFor(() => received.find((x) => JSON.parse(x.body).event_type === "PAYMENT.CAPTURE.REFUNDED"));
    const ev = JSON.parse(w.body);
    expect(ev.resource_type).toBe("refund");
    expect(ev.resource.supplementary_data.related_ids.capture_id).toBe(c.captureId);
    expect((await client.verifyWebhookSignature({ headers: w.headers as Record<string, string>, body: w.body })).verified).toBe(true);
    const order = await client.getOrder(c.orderId);
    expect(order.purchase_units![0].payments!.refunds).toHaveLength(2);
  });

  it("capture inexistente → RESOURCE_NOT_FOUND", async () => {
    await expect(client.refundCapture("NOPE0000000000000")).rejects.toMatchObject({ status: 404, errorName: "RESOURCE_NOT_FOUND" });
  });
});

describe("servidor standalone", () => {
  it("arranca con node mocks/paypal/server.mjs en MOCK_PAYPAL_PORT", async () => {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.resolve(__dirname, "../../mocks/paypal/server.mjs")], {
      env: { ...process.env, MOCK_PAYPAL_PORT: String(port) },
      stdio: "pipe",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d) => String(d).includes("escuchando") && resolve());
        child.on("exit", (code) => reject(new Error(`salió ${code}`)));
      });
      const r = await fetch(`http://localhost:${port}/health`);
      expect(await r.json()).toEqual({ ok: true, mock: "paypal" });
    } finally {
      child.kill();
    }
  });
});
