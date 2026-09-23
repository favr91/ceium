// Errores del cliente Moodle. Moodle responde HTTP 200 con {exception, errorcode, message, debuginfo?}
// cuando falla una función; los fallos de red/HTTP/timeout se modelan con otros `kind`.

export type MoodleErrorKind =
  | "moodle" // excepción devuelta por Moodle (exception/errorcode)
  | "network" // no se pudo conectar
  | "timeout" // no respondió a tiempo
  | "http" // status HTTP distinto de 2xx
  | "protocol"; // respuesta no JSON / forma inesperada

/** Códigos de error de Moodle que indican un problema transitorio (vale la pena reintentar). */
const RETRYABLE_ERRORCODES = new Set(["dmlreadexception", "dmlwriteexception", "dbsessionhandlerproblem", "servicebusy"]);

export class MoodleError extends Error {
  readonly kind: MoodleErrorKind;
  readonly wsfunction: string;
  /** p.ej. "invalid_parameter_exception", "moodle_exception" */
  readonly exception?: string;
  /** p.ej. "invalidparameter", "invalidtoken", "wsnoinstance" */
  readonly errorcode?: string;
  /** Detalle técnico (solo llega si Moodle tiene debug activado). */
  readonly debuginfo?: string;
  readonly status?: number;
  /** true si reintentar tiene sentido (red, timeout, 5xx, errores de BD). */
  readonly retryable: boolean;

  constructor(init: {
    kind: MoodleErrorKind;
    wsfunction: string;
    message: string;
    exception?: string;
    errorcode?: string;
    debuginfo?: string;
    status?: number;
    cause?: unknown;
  }) {
    super(`Moodle ${init.wsfunction}: ${init.message}${init.debuginfo ? ` (${init.debuginfo})` : ""}`, { cause: init.cause });
    this.name = "MoodleError";
    this.kind = init.kind;
    this.wsfunction = init.wsfunction;
    this.exception = init.exception;
    this.errorcode = init.errorcode;
    this.debuginfo = init.debuginfo;
    this.status = init.status;
    this.retryable =
      init.kind === "network" ||
      init.kind === "timeout" ||
      (init.kind === "http" && (init.status === undefined || init.status >= 500 || init.status === 429)) ||
      (init.kind === "protocol" && (init.status ?? 200) >= 500) ||
      (init.kind === "moodle" && !!init.errorcode && RETRYABLE_ERRORCODES.has(init.errorcode));
  }

  /** Mensaje corto para guardar en Enrollment.lastError / mostrar en el panel. */
  get short(): string {
    return this.kind === "moodle" ? `${this.errorcode}: ${this.debuginfo ?? this.message.replace(/^Moodle [^:]+: /, "")}` : this.message;
  }
}

export function isMoodleError(e: unknown, errorcode?: string): e is MoodleError {
  return e instanceof MoodleError && (errorcode === undefined || e.errorcode === errorcode);
}
