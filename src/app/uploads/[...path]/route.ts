// Sirve las imágenes subidas desde el panel (/uploads/…). No viven en public/: `next start` solo sirve los
// archivos que había en public/ al arrancar, así que una imagen subida después daría 404 hasta reiniciar.
// Cada archivo tiene un nombre único (lleva un hash) y nunca cambia: se cachea un año en el navegador/CDN.
import fs from "node:fs/promises";
import path from "node:path";
import { services } from "@/server/services";
import { resolveUpload, UPLOAD_TYPES } from "@/server/uploads";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const abs = resolveUpload(services().deps.config.publicUploadsDir, (await ctx.params).path);
  if (!abs) return new Response("Not found", { status: 404 });
  try {
    const data = await fs.readFile(abs);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": UPLOAD_TYPES[path.extname(abs).toLowerCase()],
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
