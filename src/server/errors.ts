// Errores de dominio con código estable (las rutas los traducen a HTTP) y mensaje en español.
export type DomainErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "SOLD_OUT"
  | "COHORT_UNAVAILABLE"
  | "INVALID_TRANSITION"
  | "INVALID_STATE"
  | "PAYMENT_PROVIDER"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const HTTP_STATUS: Record<DomainErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 422,
  SOLD_OUT: 409,
  COHORT_UNAVAILABLE: 409,
  INVALID_TRANSITION: 409,
  INVALID_STATE: 409,
  PAYMENT_PROVIDER: 502,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
};

/**
 * `instanceof` no basta: Next empaqueta src/server en más de un chunk (rutas, RSC, server actions) y cada uno
 * puede traer su propia copia de la clase. Se reconoce también por nombre + código conocido.
 */
export function isDomainError(e: unknown, code?: DomainErrorCode): e is DomainError {
  const c = (e as { code?: unknown } | null)?.code;
  const ok = e instanceof DomainError || (e instanceof Error && e.name === "DomainError" && typeof c === "string" && Object.prototype.hasOwnProperty.call(HTTP_STATUS, c));
  return ok && (!code || (e as DomainError).code === code);
}

/** Violación de restricción única de Prisma (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return !!err && (err.code === "P2002" || /Unique constraint failed/i.test(err.message ?? ""));
}

/**
 * Error transitorio de BD: reintentar la transacción completa es seguro.
 *  - P1008 "Operation has timed out": así reporta Prisma un SQLITE_BUSY (otra conexión/proceso tiene el lock).
 *  - P2034: conflicto de escritura / deadlock (Postgres, serialización).
 *  - P2028 "Unable to start a transaction in the given time": maxWait agotado por contención.
 */
export function isTransientDbError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  const msg = err.message ?? "";
  if (err.code === "P1008" || err.code === "P2034") return true;
  if (err.code === "P2028" && /Unable to start a transaction/i.test(msg)) return true;
  return /SQLITE_BUSY|database is locked|Operation has timed out|write conflict|deadlock|could not serialize/i.test(msg);
}
