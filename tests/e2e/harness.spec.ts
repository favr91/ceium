// El arnés e2e está aislado y cableado a la app bajo prueba (ver playwright.config.ts):
// la app usa la BD e2e sembrada, PayPal vuelve a APP_URL = la app bajo prueba y el mock de PayPal
// entrega los webhooks firmados a ESTA app (no a :3000).
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";

const paypal = e2eEnv.PAYPAL_BASE_URL;

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "una vez basta (no depende del viewport)");
});

test("la app bajo prueba usa la BD e2e sembrada", async ({ request, baseURL }) => {
  expect(e2eEnv.APP_URL).toBe(baseURL);
  expect(e2eEnv.DATABASE_URL).toMatch(/var\/(e2e\/e2e|lanes\/[\w-]+)\.db$/);
  const health = await (await request.get("/api/health")).json();
  expect(health.ok).toBe(true);
  expect(health.products).toBeGreaterThan(0);
});

test("el mock de PayPal entrega los webhooks firmados a la app bajo prueba", async ({ request, baseURL }) => {
  const auth = "Basic " + Buffer.from(`${e2eEnv.PAYPAL_CLIENT_ID}:${e2eEnv.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const tok = await (await request.post(`${paypal}/v1/oauth2/token`, { headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, data: "grant_type=client_credentials" })).json();
  const h = { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" };
  const order = await (
    await request.post(`${paypal}/v2/checkout/orders`, {
      headers: h,
      data: {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: "e2e-harness", amount: { currency_code: "USD", value: "1.00" } }],
        payment_source: { paypal: { experience_context: { return_url: `${baseURL}/pedido/x/paypal/retorno`, cancel_url: `${baseURL}/pedido/x` } } },
      },
    })
  ).json();
  const approved = await (await request.get(`${paypal}/__mock/approve/${order.id}?json=1`)).json();
  expect(approved.redirect.startsWith(`${baseURL}/pedido/x/paypal/retorno`)).toBe(true);
  const cap = await (await request.post(`${paypal}/v2/checkout/orders/${order.id}/capture`, { headers: h, data: {} })).json();
  const captureId = cap.purchase_units[0].payments.captures[0].id;
  // Reenvío explícito del evento firmado: la app (no otro servidor) responde. El pago es ajeno a la BD →
  // error permanente registrado → 200. Un cuerpo adulterado → 400 (la app verificó la firma con el mock).
  const sent = await (await request.post(`${paypal}/__mock/send-webhook/${captureId}`)).json();
  expect(sent.status).toBe(200);
  const tampered = await (await request.post(`${paypal}/__mock/send-webhook/${captureId}?tamper=body`)).json();
  expect(tampered.status).toBe(400);
});
