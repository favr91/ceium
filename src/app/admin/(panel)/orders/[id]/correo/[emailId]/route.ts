// GET /admin/orders/<id>/correo/<emailId>: HTML del correo enviado al cliente, para la vista previa del panel
// (se muestra en un iframe con sandbox; el outbox guarda la versión sin secretos).
import { getOrderEmail } from "@/server/admin-order-views";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { currentAdmin } from "../../../../../_lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; emailId: string }> }) {
  const { id, emailId } = await ctx.params;
  const user = await currentAdmin();
  if (!user) return new Response("Inicia sesión en el panel.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const m = await getOrderEmail(services().deps, user, id, emailId);
    return new Response(m.html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        // Sin scripts ni envíos desde el HTML del correo.
        "content-security-policy": "default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src *; frame-ancestors 'self'",
      },
    });
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return new Response(e.message, { status: e.code === "FORBIDDEN" ? 403 : 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
