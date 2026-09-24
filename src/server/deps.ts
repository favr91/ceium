// Dependencias inyectables de los servicios de dominio. La app usa getServices() (src/server/services.ts);
// los tests construyen Deps con una BD SQLite propia y fakes de Moodle/PayPal/correo.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { isTransientDbError, isUniqueViolation } from "@/server/errors";
import type { MoodlePort, PaypalPort } from "@/server/ports";
import type { Mailer } from "@/server/email/mailer";

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export interface ServiceConfig {
  appUrl: string;
  moodleLoginUrl: string;
  mailFrom: string;
  mailBcc?: string;
  certificatesDir: string;
  privateFilesDir: string;
  /** Reintentos de matrícula dentro de la misma llamada antes de dejarla al job (con backoff). */
  enrollInlineRetries: number;
  enrollInlineDelayMs: number;
}

export interface Deps {
  db: Db;
  moodle: MoodlePort;
  paypal: PaypalPort;
  mailer: Mailer;
  config: ServiceConfig;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: Pick<Console, "info" | "warn" | "error">;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    appUrl: (env.APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    moodleLoginUrl: env.MOODLE_LOGIN_URL ?? `${(env.MOODLE_URL ?? "").replace(/\/$/, "")}/login/index.php`,
    mailFrom: env.MAIL_FROM ?? "CEIUM <no-reply@ceium.net>",
    mailBcc: env.MAIL_BCC || undefined,
    certificatesDir: env.CERTIFICATES_DIR ?? "var/certificates",
    privateFilesDir: env.PRIVATE_FILES_DIR ?? "var/files",
    enrollInlineRetries: 2,
    enrollInlineDelayMs: 750,
  };
}

export interface WithTxOptions {
  /** Reintentos ante contención (default 10). */
  retries?: number;
  /**
   * Reintentar también ante P2002 (restricción única). Solo para transacciones cuyo P2002 solo puede venir
   * de una carrera con otra transacción que ya confirmó (alta de cliente por correo, número de pedido):
   * al reintentar, la lectura ve la fila ajena y el camino es otro.
   */
  retryUnique?: boolean;
}

/**
 * Transacción interactiva con reintento ante contención (SQLITE_BUSY/P1008 entre procesos, P2034 en Postgres).
 * `fn` debe ser re-ejecutable (sin efectos externos dentro).
 */
export async function withTx<T>(d: Pick<Deps, "db" | "sleep">, fn: (tx: Tx) => Promise<T>, opts: number | WithTxOptions = {}): Promise<T> {
  const { retries = 10, retryUnique = false } = typeof opts === "number" ? { retries: opts } : opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await d.db.$transaction(fn, { maxWait: 10_000, timeout: 20_000 });
    } catch (e) {
      const retryable = isTransientDbError(e) || (retryUnique && isUniqueViolation(e));
      if (attempt >= retries || !retryable) throw e;
      await d.sleep(Math.min(1000, 10 * 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 50));
    }
  }
}

/** Lee una Setting (JSON) con valor por defecto, usando el cliente dado (BD de la app o de test). */
export async function readSetting<T>(db: Db | Tx, key: string, fallback: T): Promise<T> {
  const row = await db.setting.findUnique({ where: { key } });
  if (!row || row.value == null) return fallback;
  if (typeof fallback === "object" && fallback !== null && !Array.isArray(fallback)) {
    return { ...fallback, ...(row.value as object) } as T;
  }
  return row.value as T;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
