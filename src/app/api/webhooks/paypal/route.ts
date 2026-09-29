// Webhook de PayPal (suscribir en el dashboard: PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED / REVERSED,
// CHECKOUT.ORDER.APPROVED y CUSTOMER.DISPUTE.CREATED). Lee el cuerpo CRUDO (la firma se verifica sobre él) y delega en
// handlePaypalWebhook, que verifica la firma con PayPal, deduplica por event id y despacha.
// Códigos: 200 procesado / duplicado / error permanente registrado (PayPal no debe reintentar);
// 400 firma o cuerpo inválidos; 500 error transitorio → PayPal reintenta con backoff.
import { services } from "@/server/services";
import { isDomainError } from "@/server/errors";
import { BodyTooLargeError, readTextLimited } from "@/server/http-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Un evento de PayPal pesa unos pocos KB: más que esto no es PayPal (y no se reenvía a su API de verificación).
const MAX_WEBHOOK_BYTES = 128 * 1024;

export async function POST(req: Request) {
  let raw: string;
  try {
    raw = await readTextLimited(req, MAX_WEBHOOK_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return Response.json({ ok: false, error: e.message }, { status: 413 });
    throw e;
  }
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
