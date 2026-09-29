// Mensajes de error que viajan en la URL (?pago=error&motivo=…) al volver a una página pública. Van firmados
// (HMAC): sin firma válida la página muestra un mensaje genérico, así nadie arma un enlace del dominio de CEIUM
// con un texto propio («paga por Zelle a …»).
import crypto from "node:crypto";

const key = () => crypto.createHash("sha256").update(`ceium-flash:${process.env.SESSION_SECRET ?? "dev-only"}`).digest();
const sign = (message: string) => crypto.createHmac("sha256", key()).update(message).digest("base64url").slice(0, 22);

/** Parámetros `motivo` + `firma` para la URL de vuelta. */
export function errorParams(message: string): { motivo: string; firma: string } {
  const m = message.slice(0, 300);
  return { motivo: m, firma: sign(m) };
}

/** El mensaje si su firma es válida; si no, null (la página usa su texto genérico). */
export function verifiedMessage(message: string | null | undefined, signature: string | null | undefined): string | null {
  if (!message || !signature) return null;
  const expected = Buffer.from(sign(message));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? message : null;
}
