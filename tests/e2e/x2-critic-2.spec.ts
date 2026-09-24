// Pieza x2 — segunda ronda de crítica adversarial (QA) por HTTP contra el carril y los mocks. Casos que las
// specs x2-manual-payment / x2-manual-adversarial / x2-critic no cubren; cada uno comprueba el resultado REAL
// (BD, estado del mock de Moodle, estado del mock de PayPal y bandeja de correos), no la UI.
//   1. Webhooks FUERA DE ORDEN: la captura se hace en PayPal pero su PAYMENT.CAPTURE.COMPLETED falla en la
//      primera entrega (la app no lo ve); el comercio reembolsa desde PayPal y PAYMENT.CAPTURE.REFUNDED llega
//      ANTES que el reintento de COMPLETED → el médico no puede terminar matriculado, con el cupo ocupado y el
//      dinero devuelto.
// Carril: E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/x2-critic-2.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MOODLE, PAYPAL, cohort, customerOf, emails, fixture, one, order, paypalConfig, q, replayWebhook, reservationOf, uniqueEmail } from "./support/purchase";

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(180_000);

const COURSE = "curso-universitario-ecografia-de-abdomen";

interface CourseCohort { productId: string; moodleCourseId: number; sedeSlug: string; cohortId: string; capacity: number }
interface Placed { orderId: string; token: string; number: number; dueNowCents: number }
const newCohort = (capacity: number) => fixture<CourseCohort>("course-cohort", { product: COURSE, sede: "barquisimeto", capacity, name: `Cohorte x2crit2 ${Date.now().toString(36)}` });
const checkout = (C: CourseCohort, email: string, paymentMethod = "PAYPAL") => fixture<Placed>("checkout", { productId: C.productId, cohortId: C.cohortId, planKind: "FULL", email, paymentMethod });

async function ppToken(request: APIRequestContext): Promise<string> {
  const r = await request.post(`${PAYPAL}/v1/oauth2/token`, {
    headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    data: "grant_type=client_credentials",
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).access_token;
}
const enrolledIn = async (request: APIRequestContext, uid: number | null) =>
  uid == null ? [] : ((await (await request.get(`${MOODLE}/__mock/state`)).json()) as { enrolments: { userid: number; courseid: number }[] }).enrolments.filter((e) => e.userid === uid).map((e) => e.courseid);

test.afterEach(async ({ request }) => {
  // Deja el mock de PayPal como lo arranca el carril.
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: true });
});

// ───────────── 1. REFUNDED antes que COMPLETED ─────────────

test("PAYMENT.CAPTURE.REFUNDED llega antes que el reintento de PAYMENT.CAPTURE.COMPLETED → el médico no queda matriculado ni con cupo tras el reembolso", async ({ page, request }) => {
  const C = newCohort(3);
  const email = uniqueEmail("crit2-ooo");
  const o = checkout(C, email);

  // Sin webhooks automáticos: la app solo sabe lo que este test le entregue.
  await paypalConfig(request, { autoWebhooks: false, approvalWebhooks: false });
  await page.goto(`/pedido/${o.token}`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const ppOrder = new URL(page.url()).searchParams.get("token")!;
  // El médico aprueba y cierra la pestaña (no vuelve al sitio); PayPal captura (p.ej. por otro canal).
  expect((await request.post(`${PAYPAL}/__mock/approve/${ppOrder}?json=1`)).ok()).toBe(true);
  const token = await ppToken(request);
  const cap = await request.post(`${PAYPAL}/v2/checkout/orders/${ppOrder}/capture`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "return=representation" }, data: "{}" });
  expect(cap.status(), await cap.text()).toBe(201);
  const captureId: string = (await cap.json()).purchase_units[0].payments.captures[0].id;

  // Primera entrega de COMPLETED: la app no responde (caída, timeout) → PayPal la reintentará más tarde.
  await paypalConfig(request, { autoWebhooks: false, webhookTarget: "http://127.0.0.1:9/api/webhooks/paypal" });
  const completed = (await (await request.post(`${PAYPAL}/__mock/send-webhook/${captureId}?event_type=PAYMENT.CAPTURE.COMPLETED`)).json()) as { event: unknown; headers: Record<string, string>; status: number | null; error: string | null };
  expect(completed.status).toBeNull();
  await paypalConfig(request, { autoWebhooks: false });
  expect(order(o.orderId).status).toBe("PENDING_PAYMENT");

  // El comercio reembolsa la captura completa desde PayPal; su webhook llega primero.
  const ref = await request.post(`${PAYPAL}/v2/payments/captures/${captureId}/refund`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, data: "{}" });
  expect(ref.status(), await ref.text()).toBe(201);
  const refunded = (await (await request.post(`${PAYPAL}/__mock/send-webhook/${captureId}?event_type=PAYMENT.CAPTURE.REFUNDED`)).json()) as { event: unknown; headers: Record<string, string>; status: number };

  // Reintento de PayPal de COMPLETED (mismo evento, misma firma).
  const retried = await replayWebhook(request, completed);
  expect(retried.status).toBe(200);
  // PayPal reintenta todo evento que no recibió 2xx: si la app pidió reintento del REFUNDED, llega ahora.
  if (refunded.status >= 300) {
    const again = await replayWebhook(request, refunded);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  }

  // Resultado real: PayPal devolvió todo el dinero → el pedido queda reembolsado, sin cupo y sin Moodle.
  const pp = ((await (await request.get(`${PAYPAL}/__mock/state`)).json()) as { captures: { id: string; status: string }[] }).captures.find((c) => c.id === captureId)!;
  expect(pp.status).toBe("REFUNDED");
  const pay = one<{ id: string; status: string; refundedCents: number; amountUsdCents: number }>(`SELECT id, status, refundedCents, amountUsdCents FROM Payment WHERE paypalCaptureId = ?`, captureId);
  await expect.poll(() => order(o.orderId).status, { timeout: 15_000 }).toBe("REFUNDED");
  expect(one<{ status: string; refundedCents: number }>(`SELECT status, refundedCents FROM Payment WHERE id = ?`, pay.id)).toEqual({ status: "REFUNDED", refundedCents: pay.amountUsdCents });
  expect(order(o.orderId)).toMatchObject({ amountPaidCents: 0 });
  expect(reservationOf(o.orderId).status).toBe("RELEASED");
  expect(cohort(C.cohortId)).toEqual({ capacity: 3, seatsHeld: 0, seatsConfirmed: 0 });
  expect(await enrolledIn(request, customerOf(o.orderId).moodleUserId)).toEqual([]);
  expect(q<{ status: string }>(`SELECT status FROM Refund WHERE paymentId = ?`, pay.id)).toEqual([{ status: "COMPLETED" }]);
  expect(emails(o.orderId).filter((m) => m.template === "refund_issued")).toHaveLength(1);
});

// ───────────── 2. /pedido valida en el servidor lo mismo que el checkout ─────────────

const PAGO_MOVIL_REAL = {
  method: "PAGO_MOVIL",
  enabled: true,
  label: "Pago Móvil",
  currency: "VES",
  details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." },
  instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra la referencia y el comprobante.",
};
const OTHERS_OFF = [
  { method: "TRANSFERENCIA", enabled: false, label: "Transferencia bancaria", currency: "VES", details: { banco: "TODO: banco" }, instructions: "" },
  { method: "ZELLE", enabled: false, label: "Zelle", currency: "USD", details: { correo: "TODO: correo Zelle" }, instructions: "" },
  { method: "EFECTIVO", enabled: false, label: "Efectivo en sede", currency: "USD", details: { lugar: "TODO: sede y horario" }, instructions: "" },
];
const RATE = 187.25;
function tinyPng(): Buffer {
  return Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082", "hex");
}

test("/pedido/<token> rechaza en el servidor fecha futura o ilegible, referencia inválida y monto absurdo: ni pago, ni «en verificación», ni comprobante huérfano", async ({ page }) => {
  const before = fixture<{ before: unknown }>("setting", { key: "payments.manualMethods", value: [PAGO_MOVIL_REAL, ...OTHERS_OFF] }).before;
  fixture("setting", { key: "exchangeRate.vesPerUsd", value: { vesPerUsd: RATE, source: "BCV" } });
  try {
    const C = newCohort(10);
    const today = new Date().toISOString().slice(0, 10);
    const r = () => `0134${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
    const cases: { name: string; reference: string; amount?: string; paidAt: string }[] = [
      { name: "fecha futura", reference: r(), paidAt: "2099-12-31" },
      { name: "fecha ilegible", reference: r(), paidAt: "ayer" },
      { name: "referencia de 1 carácter", reference: "7", paidAt: today },
      { name: "referencia con símbolos", reference: "<b>ref</b>", paidAt: today },
      { name: "monto que desborda", reference: r(), amount: "999.999.999.999,99", paidAt: today },
    ];
    for (const b of cases) {
      const o = checkout(C, uniqueEmail("crit2-val"), "PAGO_MOVIL");
      const amount = b.amount ?? (Math.round(o.dueNowCents * RATE) / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const proofsDir = path.resolve(__dirname, "../../var/lanes/e2e/files/proofs", o.orderId.replace(/[^a-z0-9]/gi, ""));
      await page.goto(`/pedido/${o.token}`);
      // Sin las ayudas del navegador (cualquiera puede enviar el formulario a mano).
      await page.evaluate(() => document.querySelectorAll("input").forEach((i) => { i.removeAttribute("required"); i.removeAttribute("pattern"); i.removeAttribute("max"); }));
      await page.getByLabel("Número de referencia").fill(b.reference);
      await page.getByLabel(/Monto pagado/).fill(amount);
      await page.getByLabel("Banco de origen").fill("Banesco (0134)");
      await page.locator("#paidAt").evaluate((el: HTMLInputElement, v) => { el.type = "text"; el.value = v; }, b.paidAt);
      await page.getByLabel("Cédula del titular").fill("V-14567890");
      await page.getByLabel(/Comprobante/).setInputFiles({ name: "comprobante.png", mimeType: "image/png", buffer: tinyPng() });
      await page.getByRole("button", { name: "Enviar datos del pago" }).click();
      await page.waitForURL(/[?&]pago=(registrado|error)/);
      const u = new URL(page.url());
      expect.soft(u.searchParams.get("pago"), `${b.name}: ${u.searchParams.get("motivo") ?? ""}`).toBe("error");
      expect.soft(q(`SELECT id FROM Payment WHERE orderId = ?`, o.orderId), b.name).toEqual([]);
      expect.soft(order(o.orderId).status, b.name).toBe("PENDING_PAYMENT");
      expect.soft(fs.existsSync(proofsDir) ? fs.readdirSync(proofsDir) : [], `${b.name}: comprobante huérfano en disco`).toEqual([]);
      expect.soft(emails(o.orderId).map((m) => m.template), b.name).not.toContain("payment_under_verification");
    }
  } finally {
    if (before != null) {
      try {
        fixture("setting", { key: "payments.manualMethods", value: before });
      } catch {
        /* valor previo no válido */
      }
    }
  }
});
