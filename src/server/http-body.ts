// Límite de tamaño para los cuerpos que leen los route handlers: el `bodySizeLimit` de next.config solo cubre las
// Server Actions; un route handler (webhook, API del carrito, comprobante) leía cualquier tamaño en memoria.
export class BodyTooLargeError extends Error {
  constructor() {
    super("El cuerpo de la solicitud es demasiado grande.");
  }
}

/** Texto del cuerpo, cortando la lectura apenas supera `maxBytes` (aunque no venga Content-Length). */
export async function readTextLimited(req: Request, maxBytes: number): Promise<string> {
  if (Number(req.headers.get("content-length") ?? "0") > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Para multipart (req.formData() lee todo): exige Content-Length declarado y dentro del tope. */
export function declaredLengthOk(req: Request, maxBytes: number): boolean {
  const n = Number(req.headers.get("content-length") ?? "");
  return Number.isFinite(n) && n > 0 && n <= maxBytes;
}
