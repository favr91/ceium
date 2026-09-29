// IP del cliente detrás del proxy de producción. El primer valor de X-Forwarded-For lo escribe el cliente (se
// puede inventar); el último lo agrega nuestro proxy. X-Real-IP (nginx) tiene prioridad si existe.
//
// null si no hay cabecera de proxy (desarrollo, pruebas o un proxy mal configurado): los límites por IP se omiten en
// vez de meter a todos los visitantes en la misma cuenta (un solo «bucket» bloquearía a toda la tienda). Los límites
// por cuenta y por correo siguen valiendo.
export function clientIp(h: Pick<Headers, "get">): string | null {
  const real = h.get("x-real-ip")?.trim();
  const xff = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = (real || xff[xff.length - 1] || "").slice(0, 64);
  // Next llena X-Forwarded-For con la dirección de la conexión si no viene: sin proxy (desarrollo, pruebas) o con un
  // proxy en la misma máquina que no la pasa, esa es la de loopback, compartida por todos → «desconocida».
  return ip && !LOOPBACK.test(ip) ? ip : null;
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$)/;

/** Clave de límite por IP, o null (sin límite por IP) si la IP es desconocida. */
export const ipKey = (prefix: string, ip: string | null) => (ip ? `${prefix}:${ip}` : null);
