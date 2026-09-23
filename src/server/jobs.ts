// Jobs periódicos (scripts/cron.ts o una ruta protegida con CRON_SECRET los ejecutan).
import type { Deps } from "@/server/deps";
import { expireStaleReservations } from "@/server/seats";
import { expireStaleOrders } from "@/server/orders";
import { retryDueEnrollments } from "@/server/enrollment";
import { runCertificateSweep } from "@/server/certificates";
import { retryFailedEmails } from "@/server/email";

export type JobName = "expire" | "enrollments" | "certificates" | "emails";
export const ALL_JOBS: JobName[] = ["expire", "enrollments", "certificates", "emails"];

export async function runJobs(d: Deps, which: JobName[] = ALL_JOBS) {
  const out: Record<string, unknown> = {};
  const run = async (name: JobName, fn: () => Promise<unknown>) => {
    if (!which.includes(name)) return;
    try {
      out[name] = await fn();
    } catch (e) {
      d.log.error(`[jobs] ${name} falló`, e);
      out[name] = { error: String((e as Error)?.message ?? e) };
    }
  };
  await run("expire", async () => ({ orders: await expireStaleOrders(d), reservations: await expireStaleReservations(d) }));
  await run("enrollments", () => retryDueEnrollments(d));
  await run("certificates", () => runCertificateSweep(d));
  await run("emails", async () => ({ sent: await retryFailedEmails(d) }));
  return out;
}
