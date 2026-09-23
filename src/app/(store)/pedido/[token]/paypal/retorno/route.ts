// Return URL de PayPal (?token=<id de orden PayPal>): captura el pago (idempotente con el webhook) y
// devuelve al comprador a la página de su pedido con el resultado.
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  const paypalOrderId = url.searchParams.get("token");
  const back = new URL(`/pedido/${encodeURIComponent(token)}`, req.url);
  if (!paypalOrderId) {
    back.searchParams.set("paypal", "cancelado");
    return Response.redirect(back, 303);
  }
  const s = services();
  try {
    const order = await s.orders.getOrderByToken(token);
    if (!order.payments.some((p) => p.paypalOrderId === paypalOrderId)) throw Object.assign(new Error("pago ajeno"), { code: "NOT_FOUND" });
    const r = await s.payments.capturePaypalReturn(paypalOrderId);
    back.searchParams.set("paypal", { COMPLETED: "completado", PENDING: "pendiente", FAILED: "fallido" }[r.status]);
  } catch (e) {
    if (!isDomainError(e)) console.error("[paypal/retorno]", e);
    back.searchParams.set("paypal", "error");
  }
  return Response.redirect(back, 303);
}
