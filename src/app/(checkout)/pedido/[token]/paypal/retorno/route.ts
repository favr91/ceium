// Return URL de PayPal (?token=<id de orden PayPal>&PayerID=…).
//   1. Navegación del navegador (Sec-Fetch-Mode: navigate) recién llegada de PayPal → 303 a la pantalla
//      «Confirmando tu pago» (/pedido/[token]/paypal/procesando), que vuelve aquí con &confirmar=1. Así el médico
//      ve nuestra pantalla de proceso mientras se captura el cobro, en vez de la página de PayPal congelada.
//   2. Con &confirmar=1 (o cualquier cliente que no sea una navegación: reintentos, pruebas) → captura el pago
//      (idempotente con el webhook) y 303 a la página del pedido con ?paypal=completado|pendiente|fallido|error.
// Si el pago quedó cobrado (o en revisión de PayPal) y este navegador tenía ESE pedido en curso en el checkout,
// se vacía el carrito: la compra terminó (como Shopify tras «Gracias por tu compra»).
import { CART_COOKIE } from "@/server/cart";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { CHECKOUT_COOKIE, decodePendingCookie } from "@/app/(checkout)/checkout/data";

export const dynamic = "force-dynamic";

function see(location: URL, clearCookies: string[] = []): Response {
  const headers = new Headers({ location: location.toString(), "cache-control": "no-store" });
  for (const name of clearCookies) headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return new Response(null, { status: 303, headers });
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  const paypalOrderId = url.searchParams.get("token");
  const back = new URL(`/pedido/${encodeURIComponent(token)}`, req.url);
  if (!paypalOrderId) {
    back.searchParams.set("paypal", "cancelado");
    return see(back);
  }

  if (req.headers.get("sec-fetch-mode") === "navigate" && !url.searchParams.has("confirmar")) {
    const processing = new URL(`/pedido/${encodeURIComponent(token)}/paypal/procesando`, req.url);
    processing.searchParams.set("token", paypalOrderId);
    return see(processing);
  }

  const s = services();
  const clear: string[] = [];
  try {
    const order = await s.orders.getOrderByToken(token);
    if (!order.payments.some((p) => p.paypalOrderId === paypalOrderId)) throw Object.assign(new Error("pago ajeno"), { code: "NOT_FOUND" });
    const r = await s.payments.capturePaypalReturn(paypalOrderId);
    back.searchParams.set("paypal", { COMPLETED: "completado", PENDING: "pendiente", FAILED: "fallido" }[r.status]);
    if (r.status !== "FAILED" && decodePendingCookie(readCookie(req, CHECKOUT_COOKIE))?.token === token) clear.push(CART_COOKIE, CHECKOUT_COOKIE);
  } catch (e) {
    if (!isDomainError(e)) console.error("[paypal/retorno]", e);
    back.searchParams.set("paypal", "error");
  }
  return see(back, clear);
}
