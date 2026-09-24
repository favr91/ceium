// GET /admin/certificates/<id>/pdf: PDF del certificado, solo con sesión del panel (el archivo vive fuera de
// public/). ?download=1 lo descarga; si no, se abre en el navegador.
import { readCertificatePdf } from "@/server/admin-learning";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { currentAdmin } from "../../../../_lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentAdmin();
  if (!user) return new Response("Inicia sesión en el panel.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    const pdf = await readCertificatePdf(services().deps, user, id);
    const download = new URL(req.url).searchParams.get("download") === "1";
    return new Response(new Uint8Array(pdf.bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `${download ? "attachment" : "inline"}; filename="Certificado-${pdf.code}.pdf"`,
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
