// Cliente Prisma único (singleton) para route handlers, server components y scripts.
// Uso:  import { prisma } from "@/server/db";
//
// SERIALIZACIÓN (importante): el adaptador better-sqlite3 usa UNA sola conexión. Si una escritura
// "suelta" (fuera de $transaction) se ejecuta mientras otra petición tiene abierta una transacción
// interactiva, SQLite la ejecuta DENTRO de esa transacción; si luego la transacción falla (p.ej.
// SOLD_OUT), la escritura ajena se revierte aunque su llamador ya recibió "OK". Para impedirlo, el
// cliente se envuelve en un mutex asíncrono por conexión:
//   - $transaction(fn) toma el mutex durante toda la transacción;
//   - cada operación suelta (db.modelo.metodo, $queryRaw, …) toma el mutex solo mientras se ejecuta;
//   - dentro de una transacción (AsyncLocalStorage) no se vuelve a tomar (evita el interbloqueo).
// Varias instancias/procesos (p.ej. `npm run dev` + `npm run jobs`) usan conexiones distintas al mismo
// archivo. Para que no fallen por contención, cada conexión:
//   - usa journal_mode=WAL (los lectores no bloquean al escritor ni viceversa);
//   - espera el lock hasta busy_timeout (SQLITE_BUSY_TIMEOUT_MS, 1 s por defecto) en vez de fallar. La espera
//     de better-sqlite3 es SÍNCRONA (bloquea el event loop), por eso es corta: esperas más largas las hace
//     withTx de forma asíncrona (reintento con backoff), sin bloquear el proceso;
//   - abre las transacciones con BEGIN IMMEDIATE: el lock de escritura se toma al empezar, así una
//     transacción nunca lee y LUEGO descubre que no puede escribir (SQLITE_BUSY sin espera, que Prisma
//     reporta como P1008 "Operation has timed out").
// Si aun así hay contención, withTx reintenta (isTransientDbError incluye P1008/SQLITE_BUSY).
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

/** Resuelve DATABASE_URL ("file:./dev.db") a ruta absoluta respecto de app/ (process.cwd()). */
export function resolveDatabaseUrl(url = process.env.DATABASE_URL ?? "file:./dev.db"): string {
  if (!url.startsWith("file:")) return url;
  const p = url.slice("file:".length);
  return "file:" + (path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ process.cwd(), p));
}

/** Mutex FIFO asíncrono. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;
  get pending() {
    return this.waiting;
  }
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    this.waiting++;
    return prev
      .then(() => fn())
      .finally(() => {
        this.waiting--;
        release();
      });
  }
}

const RAW_OPS = new Set(["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe", "$runCommandRaw"]);

/**
 * Envuelve un PrismaClient de conexión única para que ninguna operación se intercale con una
 * transacción interactiva abierta por otra petición (ver comentario del archivo).
 */
export function serializeClient(client: PrismaClient): PrismaClient {
  const mutex = new AsyncMutex();
  const inTx = new AsyncLocalStorage<true>();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => (inTx.getStore() ? fn() : mutex.run(fn));
  const delegates = new Map<PropertyKey, unknown>();

  const wrapDelegate = (delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => locked(async () => await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      },
    });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "__serialized") return true;
      if (prop === "__mutex") return mutex;
      const v = Reflect.get(target, prop, receiver);
      if (prop === "$transaction") {
        return (arg: unknown, opts?: unknown) => {
          if (Array.isArray(arg)) {
            throw new Error("db.$transaction([...]) no está soportado con el cliente serializado: usa una transacción interactiva (withTx).");
          }
          const run = () => (target.$transaction as (a: unknown, o?: unknown) => Promise<unknown>)(arg, opts);
          if (inTx.getStore()) return run();
          return mutex.run(() => inTx.run(true, run));
        };
      }
      if (typeof prop === "string" && RAW_OPS.has(prop) && typeof v === "function") {
        return (...args: unknown[]) => locked(async () => await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      if (typeof prop === "string" && !prop.startsWith("$") && !prop.startsWith("_") && v && typeof v === "object") {
        let w = delegates.get(prop);
        if (!w) delegates.set(prop, (w = wrapDelegate(v)));
        return w;
      }
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export const SQLITE_BUSY_TIMEOUT_MS = Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 1000);

type SqliteHandle = { prepare: (sql: string) => unknown; pragma: (sql: string) => unknown };

/**
 * Adaptador better-sqlite3 con busy_timeout, WAL y transacciones BEGIN IMMEDIATE (el adaptador oficial
 * emite "BEGIN" = DEFERRED, que entre procesos produce SQLITE_BUSY inmediato al pasar de lectura a escritura).
 */
export function sqliteAdapter(url: string, busyTimeoutMs = SQLITE_BUSY_TIMEOUT_MS): PrismaBetterSqlite3 {
  const factory = new PrismaBetterSqlite3({ url, timeout: busyTimeoutMs });
  const connect = factory.connect.bind(factory);
  factory.connect = async () => {
    const adapter = await connect();
    const client = (adapter as unknown as { client: SqliteHandle }).client;
    client.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    client.pragma("journal_mode = WAL");
    const prepare = client.prepare.bind(client);
    client.prepare = (sql: string) => {
      if (!/^\s*BEGIN\s*;?\s*$/i.test(sql)) return prepare(sql);
      // Ojo: si BEGIN lanza, el adaptador NO libera su mutex interno y la conexión queda bloqueada para
      // siempre ("Unable to start a transaction in the given time"). Por eso BEGIN nunca debe fallar por
      // contención: si tras busy_timeout el lock sigue ocupado, se abre DEFERRED; la primera escritura
      // fallará entonces con SQLITE_BUSY DENTRO de la transacción (Prisma hace rollback y libera) y withTx
      // reintenta.
      return {
        run() {
          try {
            return (prepare("BEGIN IMMEDIATE") as { run(): unknown }).run();
          } catch (e) {
            if (!String((e as { code?: string })?.code ?? "").startsWith("SQLITE_BUSY")) throw e;
            return (prepare("BEGIN") as { run(): unknown }).run();
          }
        },
      };
    };
    return adapter;
  };
  return factory;
}

export function createPrismaClient(url?: string) {
  const adapter = sqliteAdapter(resolveDatabaseUrl(url));
  return serializeClient(new PrismaClient({ adapter }));
}

const globalForPrisma = globalThis as unknown as { __ceiumPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__ceiumPrisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__ceiumPrisma = prisma;

export * from "@/generated/prisma/client";
