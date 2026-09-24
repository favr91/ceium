// Fechas para los e2e con la MISMA regla que la app: el día del pago se valida en la zona de Venezuela
// (America/Caracas, UTC−4). `new Date().toISOString().slice(0, 10)` es el día UTC: entre las 20:00 y las 24:00 de
// Caracas ya es «mañana» y el servidor rechaza el comprobante con «La fecha del pago no puede ser posterior a hoy».
export function todayCaracas(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
