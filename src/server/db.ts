// Cliente Prisma único (singleton) para route handlers, server components y scripts.
// Uso:  import { prisma } from "@/server/db";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

/** Resuelve DATABASE_URL ("file:./dev.db") a ruta absoluta respecto de app/ (process.cwd()). */
export function resolveDatabaseUrl(url = process.env.DATABASE_URL ?? "file:./dev.db"): string {
  if (!url.startsWith("file:")) return url;
  const p = url.slice("file:".length);
  return "file:" + (path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ process.cwd(), p));
}

export function createPrismaClient(url?: string) {
  const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl(url) });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { __ceiumPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__ceiumPrisma ?? createPrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.__ceiumPrisma = prisma;

export * from "@/generated/prisma/client";
