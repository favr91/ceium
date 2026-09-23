"use server";
// Acción POST de la página intermedia de pago de una cuota: crea la orden PayPal por esa cuota y redirige
// al comprador a PayPal. Es POST a propósito: los escáneres de enlaces de correo (Outlook SafeLinks,
// Gmail) y los prefetch abren los enlaces con GET, y crear/cancelar intentos de PayPal con GET haría que un
// escáner cancelara el intento que el cliente está pagando.
import { redirect } from "next/navigation";
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";

export async function payInstallmentWithPaypal(token: string, installmentId: string): Promise<never> {
  const s = services();
  let target: string;
  try {
    const order = await s.orders.getOrderByToken(token);
    if (!order.installments.some((i) => i.id === installmentId)) throw Object.assign(new Error("cuota ajena"), { code: "NOT_FOUND" });
    const r = await s.payments.startPaypalPayment(order.id, { installmentId });
    target = r.approveUrl;
  } catch (e) {
    if (!isDomainError(e) && (e as { code?: string })?.code !== "NOT_FOUND") console.error("[cuota/paypal]", e);
    const back = new URLSearchParams({ pago: "error", motivo: isDomainError(e) ? e.message : "No pudimos iniciar el pago con PayPal. Intenta de nuevo." });
    target = `/pedido/${encodeURIComponent(token)}?${back}`;
  }
  redirect(target);
}
