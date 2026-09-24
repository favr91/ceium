// GET /admin/orders/<id>/comprobante/<paymentId>: el comprobante de un pago manual, solo con sesión del panel
// (el archivo vive fuera de public/). Se muestra en línea (imagen o PDF) en la ficha del pedido.
import { readPaymentProof } from "@/server/admin-orders";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { currentAdmin } from "../../../../../_lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; paymentId: string }> }) {
  const { id, paymentId } = await ctx.params;
  const user = await currentAdmin();
  if (!user) return new Response("Inicia sesión en el panel.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const proof = await readPaymentProof(services().deps, user, paymentId);
    if (proof.orderId !== id) return new Response("No encontrado.", { status: 404 });
    return new Response(new Uint8Array(proof.bytes), {
      headers: {
        "content-type": proof.contentType,
        "content-disposition": `inline; filename="${proof.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (e) {
    if (!isDomainError(e)) throw e;
    const status = e.code === "FORBIDDEN" ? 403 : e.code === "UNAUTHORIZED" ? 401 : 404;
    return new Response(e.message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
