// Enlace directo de pago de una cuota (correo de recordatorio): crea la orden PayPal por esa cuota y
// redirige al comprador a PayPal. Si la cuota ya no se puede pagar, vuelve a la página del pedido con el motivo.
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string; installmentId: string }> }) {
  const { token, installmentId } = await ctx.params;
  const s = services();
  const orderUrl = new URL(`/pedido/${encodeURIComponent(token)}`, req.url);
  try {
    const order = await s.orders.getOrderByToken(token);
    if (!order.installments.some((i) => i.id === installmentId)) throw Object.assign(new Error("cuota ajena"), { code: "NOT_FOUND" });
    const r = await s.payments.startPaypalPayment(order.id, { installmentId });
    return Response.redirect(r.approveUrl, 303);
  } catch (e) {
    if (!isDomainError(e) && (e as { code?: string })?.code !== "NOT_FOUND") console.error("[cuota/paypal]", e);
    orderUrl.searchParams.set("pago", "error");
    orderUrl.searchParams.set("motivo", isDomainError(e) ? e.message : "No pudimos iniciar el pago con PayPal. Intenta de nuevo.");
    return Response.redirect(orderUrl, 303);
  }
}
