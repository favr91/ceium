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
  CONFLICT: 409,
};

export function isDomainError(e: unknown, code?: DomainErrorCode): e is DomainError {
  return e instanceof DomainError && (!code || e.code === code);
}

/** Violación de restricción única de Prisma (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  return !!err && (err.code === "P2002" || /Unique constraint failed/i.test(err.message ?? ""));
}

/** Contención de escritura en SQLite (otra conexión tiene el lock) o conflicto de transacción en Postgres. */
export function isTransientDbError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  return err.code === "P2034" || /SQLITE_BUSY|database is locked|write conflict|deadlock/i.test(err.message ?? "");
}
