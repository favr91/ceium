// Jobs periódicos (scripts/cron.ts o una ruta protegida con CRON_SECRET los ejecutan).
import type { Deps } from "@/server/deps";
import { expireStaleReservations } from "@/server/seats";
import { expireStaleOrders } from "@/server/orders";
import { retryDueEnrollments, retryFailedUnenrollments } from "@/server/enrollment";
import { runCertificateSweep } from "@/server/certificates";
import { retryFailedEmails } from "@/server/email";
import { reconcilePaypalPayments, reconcilePendingRefunds } from "@/server/payments";
import { runInstallmentReminders } from "@/server/installments";
import { syncExchangeRate } from "@/server/exchange-rate";

export type JobName = "rates" | "paypal" | "expire" | "enrollments" | "installments" | "certificates" | "emails";
/**
 * Orden importante: "paypal" (capturar aprobados sin retorno) antes de "expire" (liberar cupos).
 * "paypal" también retoma reembolsos PayPal que quedaron PENDING (timeout + webhook perdido).
 * "installments": marca cuotas vencidas y envía el recordatorio de la siguiente cuota con enlace de pago.
 * "rates": tasa oficial BCV del día (cada hora; tras medianoche y tras un fallo, cada 10 min). Va primero para
 * que los montos en bolívares de los correos de esta pasada usen la tasa de hoy.
 */
export const ALL_JOBS: JobName[] = ["rates", "paypal", "expire", "enrollments", "installments", "certificates", "emails"];

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
  await run("rates", () => syncExchangeRate(d));
  await run("paypal", async () => ({ ...(await reconcilePaypalPayments(d)), refunds: await reconcilePendingRefunds(d) }));
  await run("expire", async () => ({ orders: await expireStaleOrders(d), reservations: await expireStaleReservations(d) }));
  await run("enrollments", async () => ({ ...(await retryDueEnrollments(d)), unenrollments: await retryFailedUnenrollments(d) }));
  await run("installments", () => runInstallmentReminders(d));
  await run("certificates", () => runCertificateSweep(d));
  await run("emails", async () => ({ sent: await retryFailedEmails(d) }));
  return out;
}
