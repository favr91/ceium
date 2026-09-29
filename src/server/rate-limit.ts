// Límite de intentos en memoria por clave (ventana deslizante). Un solo proceso: con varias instancias cada una
// cuenta aparte, pero sigue frenando la fuerza bruta junto al bloqueo por cuenta que vive en la BD.
const buckets = new Map<string, number[]>();
let lastSweep = 0;

export interface RateResult {
  ok: boolean;
  /** Milisegundos hasta que vuelva a haber cupo (0 si ok). */
  retryAfterMs: number;
}

/** Registra un intento para `key`; ok=false si ya hubo `limit` en la ventana. */
export function hit(key: string | null, limit: number, windowMs: number, now = Date.now()): RateResult {
  if (!key) return { ok: true, retryAfterMs: 0 };
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
  }
  const list = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    buckets.set(key, list);
    return { ok: false, retryAfterMs: windowMs - (now - list[0]) };
  }
  list.push(now);
  buckets.set(key, list);
  return { ok: true, retryAfterMs: 0 };
}

/** ¿Ya hubo `limit` intentos registrados en la ventana? (no registra nada) */
export function tooMany(key: string | null, limit: number, windowMs: number, now = Date.now()): boolean {
  if (!key) return false;
  return (buckets.get(key) ?? []).filter((t) => now - t < windowMs).length >= limit;
}

/** Registra un intento (p. ej. solo los fallidos). */
export function record(key: string | null, now = Date.now()): void {
  if (!key) return;
  const list = buckets.get(key) ?? [];
  list.push(now);
  buckets.set(key, list);
}

/** Solo para pruebas. */
export function resetRateLimits() {
  buckets.clear();
}
