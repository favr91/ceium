// Webhook de PayPal (suscribir en el dashboard: PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED y
// CHECKOUT.ORDER.APPROVED). Lee el cuerpo CRUDO (la firma se verifica sobre él) y delega en
// handlePaypalWebhook, que verifica la firma con PayPal, deduplica por event id y despacha.
// Códigos: 200 procesado / duplicado / error permanente registrado (PayPal no debe reintentar);
// 400 firma o cuerpo inválidos; 500 error transitorio → PayPal reintenta con backoff.
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const r = await services().payments.handlePaypalWebhook(req.headers, raw);
    if (r.retry) return Response.json({ ok: false, error: r.error }, { status: 500 });
    return Response.json({ ok: r.ok, duplicate: r.duplicate, eventType: r.eventType, ...(r.ok ? {} : { error: r.error }) }, { status: 200 });
  } catch (e) {
    if (isDomainError(e) && (e.code === "UNAUTHORIZED" || e.code === "VALIDATION")) {
      return Response.json({ ok: false, error: e.message }, { status: 400 });
    }
    // Verificación de firma sin respuesta de PayPal, BD ocupada, etc.: reintentar.
    console.error("[webhooks/paypal]", e);
    return Response.json({ ok: false, error: "Error transitorio; reintentar." }, { status: 500 });
  }
}
