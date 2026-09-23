// Proceso independiente (otra "instancia" de la app) que intenta reservar cupos en la misma BD SQLite.
//   tsx race-worker.ts <dbUrl> <cohortId> <orderId...>
// Imprime una línea JSON: { ok, soldOut, errors }.
import { createPrismaClient } from "@/server/db";
import { withTx, MINUTE } from "@/server/deps";
import { isDomainError } from "@/server/errors";
import { reserveSeat } from "@/server/seats";

async function main() {
  const [url, cohortId, ...orderIds] = process.argv.slice(2);
  const db = createPrismaClient(url);
  const d = { db, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  let ok = 0;
  let soldOut = 0;
  const errors: string[] = [];
  await Promise.all(
    orderIds.map(async (orderId) => {
      try {
        await withTx(d, (tx) => reserveSeat(tx, { cohortId, orderId, ttlMs: 30 * MINUTE, now: new Date("2026-09-01T12:00:00Z") }), 100);
        ok++;
      } catch (e) {
        if (isDomainError(e, "SOLD_OUT")) soldOut++;
        else errors.push(String((e as Error)?.message ?? e));
      }
    }),
  );
  await db.$disconnect();
  process.stdout.write(JSON.stringify({ ok, soldOut, errors }) + "\n");
}
main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: 0, soldOut: 0, errors: [String(e)] }) + "\n");
  process.exit(1);
});
