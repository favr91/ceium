// Rutas HTTP de integración: webhook de PayPal (cuerpo crudo, códigos para reintentos) y jobs por CRON_SECRET.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@/server/errors";

const handlePaypalWebhook = vi.fn();
const runJobs = vi.fn();
vi.mock("@/server/services", () => ({ services: () => ({ payments: { handlePaypalWebhook }, jobs: { runJobs } }) }));

const { POST: webhook } = await import("@/app/api/webhooks/paypal/route");
const cron = await import("@/app/api/cron/route");

const post = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/webhooks/paypal", { method: "POST", body, headers });

describe("POST /api/webhooks/paypal", () => {
  beforeEach(() => handlePaypalWebhook.mockReset());

  it("pasa el cuerpo crudo exacto y los headers; 200 al procesar", async () => {
    handlePaypalWebhook.mockResolvedValue({ ok: true, duplicate: false, eventType: "PAYMENT.CAPTURE.COMPLETED", retry: false });
    const raw = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED"}';
    const res = await webhook(post(raw, { "paypal-transmission-id": "t-1" }));
    expect(res.status).toBe(200);
    const [headers, body] = handlePaypalWebhook.mock.calls[0];
    expect(body).toBe(raw);
    expect((headers as Headers).get("paypal-transmission-id")).toBe("t-1");
  });

  it("500 cuando el servicio pide reintento (PayPal reintenta)", async () => {
    handlePaypalWebhook.mockResolvedValue({ ok: false, duplicate: false, eventType: "X", retry: true, error: "db busy" });
    expect((await webhook(post("{}"))).status).toBe(500);
  });

  it("200 en error permanente ya registrado (no reintentar)", async () => {
    handlePaypalWebhook.mockResolvedValue({ ok: false, duplicate: false, eventType: "X", retry: false, error: "pago desconocido" });
    expect((await webhook(post("{}"))).status).toBe(200);
  });

  it("400 con firma inválida; 500 si la verificación falla por red", async () => {
    handlePaypalWebhook.mockRejectedValueOnce(new DomainError("UNAUTHORIZED", "Firma de webhook inválida."));
    expect((await webhook(post("{}"))).status).toBe(400);
    handlePaypalWebhook.mockRejectedValueOnce(new Error("fetch failed"));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    expect((await webhook(post("{}"))).status).toBe(500);
  });
});

describe("/api/cron", () => {
  const prev = process.env.CRON_SECRET;
  beforeEach(() => {
    runJobs.mockReset();
    runJobs.mockResolvedValue({ expire: { orders: 0, reservations: 0 } });
    process.env.CRON_SECRET = "s3cret";
  });
  afterEach(() => {
    process.env.CRON_SECRET = prev;
  });
  const req = (url: string, headers: Record<string, string> = {}) => new Request(`http://localhost:3000${url}`, { headers });

  it("401 sin secreto o con uno incorrecto; no ejecuta nada", async () => {
    expect((await cron.GET(req("/api/cron"))).status).toBe(401);
    expect((await cron.GET(req("/api/cron", { authorization: "Bearer nope" }))).status).toBe(401);
    expect(runJobs).not.toHaveBeenCalled();
  });

  it("503 si CRON_SECRET no está configurado", async () => {
    delete process.env.CRON_SECRET;
    expect((await cron.GET(req("/api/cron", { authorization: "Bearer " }))).status).toBe(503);
  });

  it("ejecuta todos los jobs o los pedidos en ?jobs=", async () => {
    const all = await cron.POST(req("/api/cron", { authorization: "Bearer s3cret" }));
    expect(all.status).toBe(200);
    expect(runJobs.mock.calls[0][0]).toEqual(["rates", "paypal", "expire", "enrollments", "installments", "certificates", "emails"]);
    const some = await cron.GET(req("/api/cron?jobs=paypal,expire", { "x-cron-secret": "s3cret" }));
    expect(some.status).toBe(200);
    expect(runJobs.mock.calls[1][0]).toEqual(["paypal", "expire"]);
    expect((await cron.GET(req("/api/cron?jobs=borrar", { authorization: "Bearer s3cret" }))).status).toBe(400);
  });
});
