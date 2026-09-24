// x3 (crítico 2, intento I): un certificado revocado por reembolso total no deja al médico sin certificado para
// siempre. Por HTTP contra el carril (E2E_LANE=e2e-cert E2E_PORT=3105): compra online con PayPal → 9/9 → certificado
// → reembolso total desde PayPal (webhook) → REVOCADO → vuelve a comprar, paga todo, 9/9 → el job emite UN
// certificado NUEVO (otro código, otro correo), el viejo sigue verificándose como revocado y repetir el job no
// duplica nada.
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MOODLE, PAYPAL, customerOf, enrollments, order, paypalConfig, payments, q, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { addToCart, checkoutFormFields, submitCheckout } from "./support/storefront";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor");
});
test.setTimeout(300_000);

const DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";
const ordersOf = (email: string) => q<{ id: string }>(`SELECT o.id FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ? ORDER BY o.createdAt`, email.toLowerCase());
const certs = (customerId: string) => q<{ code: string; status: string; orderItemId: string; emailedAt: number | null }>(`SELECT code, status, orderItemId, emailedAt FROM Certificate WHERE customerId = ? ORDER BY issuedAt`, customerId);
const certMails = (email: string) => q<{ status: string; text: string }>(`SELECT status, text FROM EmailOutbox WHERE template = 'certificate_issued' AND "to" = ? ORDER BY createdAt`, email.toLowerCase());

test("reembolso total revoca → recompra pagada y 9/9 → certificado NUEVO verificable; el viejo sigue revocado; sin duplicados", async ({ playwright, request, page }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
  const email = uniqueEmail("x3reissue");
  const buy = async () => {
    const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
    try {
      expect((await addToCart(ctx, { product: DIPLOMA, modality: "ONLINE", plan: "FULL" })).error).toBeNull();
      const out = await submitCheckout(ctx, await checkoutFormFields(ctx), { email, firstName: "Andrea", lastName: "Recompra Salas", method: "PAYPAL" });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) throw new Error("checkout");
      const a = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1`)).json();
      await request.get(a.redirect, { maxRedirects: 0 });
    } finally {
      await ctx.dispose();
    }
    const id = ordersOf(email).at(-1)!.id;
    await waitForOrderStatus(id, "ENROLLED", 60_000);
    await expect.poll(() => enrollments(id).filter((e) => e.status === "ENROLLED").length, { timeout: 30_000 }).toBe(9);
    return id;
  };
  const completeAll = async (r: APIRequestContext, userid: number, orderId: string) => {
    const ids = q<{ m: number }>(`SELECT p.moodleCourseId AS m FROM OrderItemCourse oc JOIN OrderItem oi ON oi.id = oc.orderItemId JOIN Product p ON p.id = oc.courseId WHERE oi.orderId = ?`, orderId).map((x) => x.m);
    expect(ids).toHaveLength(9);
    for (const courseid of ids) expect((await r.post(`${MOODLE}/__mock/complete`, { data: { userid, courseid } })).ok()).toBe(true);
  };

  const o1 = await buy();
  const cust = customerOf(o1);
  await completeAll(request, cust.moodleUserId!, o1);
  await runCron(request, "certificates");
  const [c1] = certs(cust.id);
  expect(c1.status).toBe("ISSUED");

  // Reembolso total en PayPal → webhook → pedido REFUNDED, certificado revocado.
  const cap = payments(o1).find((p) => p.paypalCaptureId)!.paypalCaptureId!;
  const tok = (await (await request.post(`${PAYPAL}/v1/oauth2/token`, { headers: { authorization: `Basic ${Buffer.from("mock-client-id:mock-client-secret").toString("base64")}` }, form: { grant_type: "client_credentials" } })).json()).access_token;
  expect((await request.post(`${PAYPAL}/v2/payments/captures/${cap}/refund`, { headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, data: {} })).status()).toBeLessThan(300);
  await waitForOrderStatus(o1, "REFUNDED", 20_000);
  await expect.poll(() => certs(cust.id).map((c) => c.status)).toEqual(["REVOKED"]);
  await runCron(request, "certificates");
  expect(certs(cust.id), "sin compra vigente no se emite nada").toHaveLength(1);

  // Recompra pagada completa y 9/9 → un certificado nuevo, con su correo.
  const o2 = await buy();
  expect(order(o2).balanceCents).toBe(0);
  await completeAll(request, cust.moodleUserId!, o2);
  await runCron(request, "certificates");
  await runCron(request, "certificates");
  await Promise.all([runCron(request, "certificates"), runCron(request, "certificates"), runCron(request, "certificates")]);
  const all = certs(cust.id);
  expect(all.map((c) => c.status)).toEqual(["REVOKED", "ISSUED"]);
  const c2 = all[1];
  expect(c2.code).not.toBe(c1.code);
  expect(c2.orderItemId).toBe(q<{ id: string }>(`SELECT id FROM OrderItem WHERE orderId = ?`, o2)[0].id);
  await expect.poll(() => certMails(email).map((m) => m.status)).toEqual(["SENT", "SENT"]);
  expect(certMails(email)[1].text).toContain(`${e2eEnv.APP_URL}/certificados/${c2.code}`);
  expect(q(`SELECT id FROM OrderEvent WHERE orderId = ? AND type = 'CERTIFICATE_ISSUED'`, o2)).toHaveLength(1);

  await page.goto(`/certificados/${c2.code}`);
  await expect(page.getByRole("status")).toHaveText("Certificado válido");
  await page.goto(`/certificados/${c1.code}`);
  await expect(page.getByRole("status")).toHaveText("Certificado revocado");
});
