// IP del cliente detrás del proxy de producción. El primer valor de X-Forwarded-For lo escribe el cliente (se
// puede inventar); el último lo agrega nuestro proxy. X-Real-IP (nginx) tiene prioridad si existe.
export function clientIp(h: Pick<Headers, "get">): string {
  const real = h.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const xff = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (xff[xff.length - 1] ?? "desconocida").slice(0, 64);
}
