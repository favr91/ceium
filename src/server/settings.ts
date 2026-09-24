// Claves de configuración (tabla Setting, value = JSON). El seed crea todas con valores por defecto.
import { prisma } from "@/server/db";

export const SETTING_KEYS = {
  /** { minutes: 30 } — vida de la reserva de cupo en checkout PayPal */
  reservationTtlPaypal: "reservation.ttl.paypal",
  /** { hours: 72 } — vida de la reserva en pagos manuales hasta verificación */
  reservationTtlManual: "reservation.ttl.manual",
  /** ManualMethodConfig[] — métodos manuales y datos bancarios mostrados al comprador */
  manualMethods: "payments.manualMethods",
  /** { enabled: true } */
  paypal: "payments.paypal",
  /** { vesPerUsd: number, source: string, updatedAt: string } */
  exchangeRate: "exchangeRate.vesPerUsd",
  /** { next: 1001 } — siguiente número visible de orden */
  orderNextNumber: "order.nextNumber",
  /** { maxAttempts, baseDelaySeconds } — reintentos de matrícula Moodle */
  enrollmentRetry: "enrollment.retry",
  /** InstallmentReminderPolicy — recordatorios de la siguiente cuota (mes a mes / saldo de la mitad) */
  installmentReminders: "installments.reminders",
  /** { intervalMinutes } — job de certificados */
  certificateJob: "certificates.job",
  /** { phones, emails, whatsapp, instagram } */
  storeContact: "store.contact",
  /** { cohortsAreSample: true, note } — marca que las cohortes sembradas son de ejemplo */
  sampleData: "seed.sampleData",
} as const;

export interface InstallmentReminderPolicy {
  /** Días antes del vencimiento en que se envía el primer recordatorio. */
  daysBefore: number;
  /** Días tras el vencimiento antes de marcar la cuota OVERDUE. */
  overdueGraceDays: number;
  /** Cada cuántos días se repite el recordatorio de una cuota vencida. */
  overdueEveryDays: number;
  /** Máximo de recordatorios de cuota vencida (luego queda en el panel). */
  maxOverdueReminders: number;
}
export const DEFAULT_INSTALLMENT_REMINDERS: InstallmentReminderPolicy = { daysBefore: 3, overdueGraceDays: 0, overdueEveryDays: 7, maxOverdueReminders: 3 };

export interface ManualMethodConfig {
  method: "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "EFECTIVO";
  enabled: boolean;
  label: string;
  currency: "USD" | "VES";
  /** Datos mostrados al comprador (banco, teléfono, cédula/RIF, titular, cuenta, correo…). */
  details: Record<string, string>;
  instructions: string;
}

export async function getSetting<T = unknown>(key: string, fallback?: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? (fallback as T);
}

// Escrituras: updateSetting (src/server/admin-settings.ts) — valida por clave y deja auditoría.
