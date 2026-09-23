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
// Varias instancias/procesos usan conexiones distintas: ahí aplica el bloqueo de SQLite
// (SQLITE_BUSY), que withTx reintenta.
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

export function createPrismaClient(url?: string) {
  const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl(url) });
  return serializeClient(new PrismaClient({ adapter }));
}

const globalForPrisma = globalThis as unknown as { __ceiumPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__ceiumPrisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__ceiumPrisma = prisma;

export * from "@/generated/prisma/client";
