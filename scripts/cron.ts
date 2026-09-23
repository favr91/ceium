// Ejecuta los jobs periódicos: vencer reservas/pedidos, reintentar matrículas, emitir certificados,
// reintentar correos.
//   npx tsx scripts/cron.ts                 # una pasada, todos los jobs
//   npx tsx scripts/cron.ts certificates    # solo algunos
//   npx tsx scripts/cron.ts --loop 60       # cada 60 s
import "dotenv/config";
import { services } from "../src/server/services";
import { ALL_JOBS, type JobName } from "../src/server/jobs";

async function main() {
  const args = process.argv.slice(2);
  const loopIdx = args.indexOf("--loop");
  const every = loopIdx >= 0 ? Number(args[loopIdx + 1] ?? 60) : 0;
  const names = args.filter((a, i) => !a.startsWith("--") && (loopIdx < 0 || i !== loopIdx + 1)) as JobName[];
  const which = names.length ? names.filter((n) => ALL_JOBS.includes(n)) : ALL_JOBS;
  const s = services();
  do {
    const started = new Date();
    const out = await s.jobs.runJobs(which);
    console.log(`[cron ${started.toISOString()}]`, JSON.stringify(out));
    if (every > 0) await new Promise((r) => setTimeout(r, every * 1000));
  } while (every > 0);
  await s.deps.db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
