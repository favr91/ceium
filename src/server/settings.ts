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
  /** { vesPerUsd: number, source: string, updatedAt: string, valueDate?: string, auto?: boolean } */
  exchangeRate: "exchangeRate.vesPerUsd",
  /** { enabled: true } — actualizar la tasa automáticamente desde el BCV (src/server/exchange-rate.ts) */
  exchangeRateAuto: "exchangeRate.auto",
  /** RateSyncStatus — resultado de la última consulta automática (lo escribe el sistema) */
  exchangeRateSync: "exchangeRate.sync",
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

// ───────────── Validación de datos de pago mostrados al comprador ─────────────

/** Texto de relleno del seed ("TODO: banco", "04xx-xxxxxxx", "V-/J-xxxxxxxx"): nunca se muestra a un comprador. */
export function isPlaceholderText(v: unknown): boolean {
  if (typeof v !== "string") return true;
  const s = v.trim();
  return s === "" || /\bTODO\b|x{3,}|^[-/.\s]+$/i.test(s);
}

/**
 * Problemas que impiden ofrecer un método manual: datos vacíos o de relleno. Un método con problemas no se
 * puede habilitar desde el panel (updateSetting) ni se acepta en el checkout aunque esté marcado `enabled`.
 */
export function manualMethodProblems(m: Pick<ManualMethodConfig, "method" | "label" | "details" | "instructions">): string[] {
  const out: string[] = [];
  const entries = Object.entries(m.details ?? {});
  if (m.method !== "EFECTIVO" && entries.length === 0) out.push(`${m.label}: faltan los datos para pagar (banco, cuenta/teléfono, titular…).`);
  for (const [k, v] of entries) if (isPlaceholderText(v)) out.push(`${m.label}: el dato «${k}» está vacío o es de ejemplo («${String(v ?? "").trim()}»).`);
  if (isPlaceholderText(m.instructions)) out.push(`${m.label}: faltan las instrucciones para el comprador.`);
  return out;
}

export interface ExchangeRateSetting {
  vesPerUsd: number;
  source?: string;
  updatedAt?: string;
  /** Fecha valor BCV (YYYY-MM-DD) cuando la tasa vino de la actualización automática. */
  valueDate?: string;
  /** true si la escribió la actualización automática; ausente si la escribió el personal. */
  auto?: boolean;
  /** Servicio que la trajo (dato interno: nunca se muestra; la fuente es el BCV). */
  provider?: string;
}

/** Horas tras las cuales la tasa Bs/USD se considera desactualizada (la tasa BCV cambia a diario). */
export const EXCHANGE_RATE_STALE_HOURS = 36;

export interface ExchangeRateStatus {
  vesPerUsd: number;
  /** Se puede cobrar en bolívares con esta tasa (positiva y no marcada como de ejemplo). */
  usable: boolean;
  /** La fuente es texto de relleno del seed («TODO: …»): la tasa es de ejemplo. */
  placeholder: boolean;
  /** Más vieja que EXCHANGE_RATE_STALE_HOURS (o sin fecha). Se sigue usando, pero el panel avisa. */
  stale: boolean;
  ageHours: number | null;
  /** Lo que impide cobrar en bolívares (sin tasa, o tasa de ejemplo). */
  blockers: string[];
  /** Avisos que no bloquean (tasa desactualizada). */
  notices: string[];
  /** blockers + notices. */
  problems: string[];
}

export function exchangeRateStatus(rate: Partial<ExchangeRateSetting> | null | undefined, now: Date): ExchangeRateStatus {
  const vesPerUsd = Number(rate?.vesPerUsd ?? 0);
  const placeholder = rate?.source != null && isPlaceholderText(rate.source);
  const ts = rate?.updatedAt ? Date.parse(rate.updatedAt) : NaN;
  const ageHours = Number.isFinite(ts) ? Math.max(0, (now.getTime() - ts) / 3_600_000) : null;
  const stale = ageHours == null || ageHours > EXCHANGE_RATE_STALE_HOURS;
  const blockers: string[] = [];
  const notices: string[] = [];
  if (!(vesPerUsd > 0) || !Number.isFinite(vesPerUsd)) blockers.push("No hay tasa de cambio Bs/USD configurada.");
  if (placeholder) blockers.push(`La tasa de cambio (Bs. ${vesPerUsd} por USD) es de ejemplo: actualízala con la tasa oficial.`);
  if (stale) notices.push(ageHours == null ? "La tasa de cambio no tiene fecha de actualización." : `La tasa de cambio tiene ${Math.floor(ageHours)} h sin actualizarse.`);
  return { vesPerUsd, usable: blockers.length === 0, placeholder, stale, ageHours, blockers, notices, problems: [...blockers, ...notices] };
}
