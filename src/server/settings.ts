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
  /** { intervalMinutes } — job de certificados */
  certificateJob: "certificates.job",
  /** { requireFullPayment: true } — el certificado exige saldo 0 además de completar todos los cursos */
  certificatePolicy: "certificates.policy",
  /** { phones, emails, whatsapp, instagram } */
  storeContact: "store.contact",
  /** { cohortsAreSample: true, note } — marca que las cohortes sembradas son de ejemplo */
  sampleData: "seed.sampleData",
} as const;

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

export async function setSetting(key: string, value: unknown, description?: string) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as never, description },
    update: { value: value as never, ...(description ? { description } : {}) },
  });
}
