// Integración de punta a punta del cableado REAL (sin fakes): createDefaultDeps → adapters.ts → MoodleClient /
// PayPalClient reales → mocks HTTP de Moodle y PayPal, con las rutas reales de retorno PayPal y webhook.
// Solo la BD es de test: createDefaultDeps({ db }) con una SQLite aislada (nunca dev.db); todo lo demás
// (clientes, adaptadores, mailer, config) sale del entorno igual que en producción.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMoodleMock } from "../../../mocks/moodle/server.mjs";
import { createPaypalMock } from "../../../mocks/paypal/server.mjs";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let tmp: string;
let moodleUrl = "";
let paypalUrl = "";
let hookServer: http.Server;
const moodleMock = createMoodleMock({ token: "wiring-token", stateFile: path.join(os.tmpdir(), `ceium-wiring-moodle-${process.pid}.json`), persist: false });
const paypalMock = createPaypalMock({ clientId: "wiring-client", clientSecret: "wiring-secret", webhookId: "WH-WIRING", autoWebhooks: true });
const hookResponses: number[] = [];

type Services = Awaited<typeof import("@/server/services")>["services"] extends () => infer S ? S : never;
let s: Services;
let returnRoute: typeof import("@/app/(store)/pedido/[token]/paypal/retorno/route");

const moodleCtl = (p: string, body?: unknown) =>
  fetch(`${moodleUrl}/__mock/${p}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const paypalCtl = (p: string, method = "POST") => fetch(`${paypalUrl}/__mock/${p}`, { method }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  ctx = await setupContext("wiring");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ceium-wiring-"));
  moodleUrl = await moodleMock.listen(0);
  paypalUrl = (await paypalMock.listen(0)).url;
  await moodleCtl("reset", { courses: [201, ...ctx.fx.diplomaMoodleIds] });

  // Receptor de webhooks: reenvía al route handler real de la app.
  hookServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { POST } = await import("@/app/api/webhooks/paypal/route");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await POST(new Request("http://app.test/api/webhooks/paypal", { method: "POST", headers, body: Buffer.concat(chunks).toString("utf8") }));
    hookResponses.push(r.status);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  });
  await new Promise<void>((r) => hookServer.listen(0, r));
  const hookPort = (hookServer.address() as { port: number }).port;
  await fetch(`${paypalUrl}/__mock/config`, { method: "POST", body: JSON.stringify({ webhookTarget: `http://localhost:${hookPort}/`, webhookDelayMs: 5 }) });

  Object.assign(process.env, {
    APP_URL: "http://app.test",
    MOODLE_URL: moodleUrl,
    MOODLE_TOKEN: "wiring-token",
    MOODLE_LOGIN_URL: `${moodleUrl}/login/index.php`,
    PAYPAL_BASE_URL: paypalUrl,
    PAYPAL_CLIENT_ID: "wiring-client",
    PAYPAL_CLIENT_SECRET: "wiring-secret",
    PAYPAL_WEBHOOK_ID: "WH-WIRING",
    MAIL_TRANSPORT: "outbox",
    MAIL_DIR: path.join(tmp, "mail"),
    CERTIFICATES_DIR: path.join(tmp, "certificates"),
    PRIVATE_FILES_DIR: path.join(tmp, "files"),
  });
  const app = await import("@/server/services");
  // las rutas usan services(): se instala la instancia con la BD de test antes de llamarlas
  s = app.createServices(app.createDefaultDeps({ db: ctx.db }));
  (globalThis as unknown as { __ceiumServices?: Services }).__ceiumServices = s;
  returnRoute = await import("@/app/(store)/pedido/[token]/paypal/retorno/route");
});

afterAll(async () => {
  await Promise.all([moodleMock.close(), paypalMock.close(), new Promise((r) => hookServer.close(r))]);
  await ctx.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Comprador aprueba en PayPal (mock) y vuelve a la return_url de la app (route handler real). */
async function approveAndReturn(orderToken: string, paypalOrderId: string) {
  const a = await paypalCtl(`approve/${paypalOrderId}?json=1`);
  expect(a.status).toBe(200);
  const back = new URL(a.body.redirect);
  expect(back.origin + back.pathname).toBe(`http://app.test/pedido/${orderToken}/paypal/retorno`);
  const res = await returnRoute.GET(new Request(back), { params: Promise.resolve({ token: orderToken }) });
  expect(res.status).toBe(303);
  return new URL(res.headers.get("location")!);
}

describe("cableado real: servicios → clientes Moodle/PayPal → mocks", () => {
  it("services() arranca sin Moodle configurado (clientes perezosos)", async () => {
    const { createDefaultDeps } = await import("@/server/services");
    const prev = process.env.MOODLE_TOKEN;
    const { resetMoodleClientForTests } = await import("@/server/moodle");
    resetMoodleClientForTests();
    process.env.MOODLE_TOKEN = "";
    try {
      const d = createDefaultDeps();
      await expect(d.moodle.getCompletion(1, 201)).rejects.toThrow();
    } finally {
      process.env.MOODLE_TOKEN = prev;
      resetMoodleClientForTests();
    }
  });

  it("PayPal semipresencial: retorno + captura + webhook firmado → matrícula, cupo, correos; replay y firma adulterada; reembolso por API", async () => {
    const order = await s.orders.createCheckout({
      customer: { email: "wiring@example.com", firstName: "Lucía", lastName: "Gómez" },
      items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }],
      paymentMethod: "PAYPAL",
    });
    const start = await s.payments.startPaypalPayment(order.id);
    expect(start.approveUrl.startsWith(paypalUrl)).toBe(true);
    const back = await approveAndReturn(order.token, start.paypalOrderId);
    expect(back.searchParams.get("paypal")).toBe("completado");

    const payment = await until(() => ctx.db.payment.findFirst({ where: { orderId: order.id, status: "COMPLETED", paypalCaptureId: { not: null } } }));
    await until(() => ctx.db.webhookEvent.findFirst({ where: { eventType: "PAYMENT.CAPTURE.COMPLETED", resourceId: payment.paypalCaptureId, processedAt: { not: null } } }));
    const o = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { customer: true, items: { include: { reservation: true } } } });
    expect(o.status).toBe("ENROLLED");
    expect(o.amountPaidCents).toBe(18000);
    expect(o.items[0].reservation?.status).toBe("CONFIRMED");
    const moodleUser = o.customer.moodleUserId!;
    const st = await moodleCtl("state");
    expect(st.enrolments.some((e: { userid: number; courseid: number }) => e.userid === moodleUser && e.courseid === 201)).toBe(true);
    const templates = (await ctx.db.emailOutbox.findMany({ where: { orderId: order.id } })).map((m) => m.template).sort();
    expect(templates).toEqual(expect.arrayContaining(["order_confirmation", "platform_access", "cohort_details"]));

    // replay del mismo evento: 200 y no se aplica dos veces
    const replay = await paypalCtl(`send-webhook/${payment.paypalCaptureId}`);
    expect(replay.body.status).toBe(200);
    // firma o cuerpo adulterados: 400
    expect((await paypalCtl(`send-webhook/${payment.paypalCaptureId}?tamper=body`)).body.status).toBe(400);
    expect((await paypalCtl(`send-webhook/${payment.paypalCaptureId}?tamper=signature`)).body.status).toBe(400);
    expect((await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).amountPaidCents).toBe(18000);
    expect(await ctx.db.payment.count({ where: { orderId: order.id, status: "COMPLETED" } })).toBe(1);

    // reembolso total por la API de PayPal → desmatricula, libera cupo, correo
    await s.payments.refundPayment(ctx.fx.admin, { paymentId: payment.id, reason: "Solicitud del alumno" });
    await until(async () => (await ctx.db.order.findUniqueOrThrow({ where: { id: order.id } })).status === "REFUNDED");
    const after = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: { include: { reservation: true } } } });
    expect(after.items[0].reservation?.status).toBe("RELEASED");
    const enr = await ctx.db.enrollment.findUniqueOrThrow({ where: { customerId_moodleCourseId: { customerId: o.customerId, moodleCourseId: 201 } } });
    expect(enr.status).toBe("UNENROLLED");
    const st2 = await moodleCtl("state");
    expect(st2.enrolments.some((e: { userid: number; courseid: number; status?: number }) => e.userid === moodleUser && e.courseid === 201 && e.status !== 1)).toBe(false);
    expect(await ctx.db.refund.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await ctx.db.emailOutbox.count({ where: { orderId: order.id, template: "refund_issued" } })).toBe(1);
    const c = await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } });
    expect(c.seatsConfirmed + c.seatsHeld).toBe(0);
    expect(hookResponses.filter((x) => x >= 500)).toEqual([]);
  }, 30_000);

  it("diplomado: certificado SOLO cuando Moodle reporta los 9 cursos completos", async () => {
    const order = await s.orders.createCheckout({
      customer: { email: "diploma-wiring@example.com", firstName: "Pedro", lastName: "Salas" },
      items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }],
      paymentMethod: "PAYPAL",
    });
    const start = await s.payments.startPaypalPayment(order.id);
    await approveAndReturn(order.token, start.paypalOrderId);
    const o = await until(async () => {
      const x = await ctx.db.order.findUniqueOrThrow({ where: { id: order.id }, include: { customer: true } });
      return x.status === "ENROLLED" ? x : null;
    });
    const uid = o.customer.moodleUserId!;
    for (const id of ctx.fx.diplomaMoodleIds.slice(0, 8)) await moodleCtl("complete", { userid: uid, courseid: id });
    expect((await s.certificates.runCertificateSweep()).issued).toBe(0);
    expect(await ctx.db.certificate.count()).toBe(0);
    await moodleCtl("complete", { userid: uid, courseid: ctx.fx.diplomaMoodleIds[8] });
    const sweep = await s.certificates.runCertificateSweep();
    expect(sweep.issued).toBe(1);
    const cert = await ctx.db.certificate.findFirstOrThrow({ where: { customerId: o.customerId } });
    expect(fs.existsSync(cert.pdfPath!)).toBe(true);
    expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued", status: "SENT" } })).toBe(1);
  }, 30_000);
});
