// Configuración desde el panel (tabla Setting) con validación por clave y auditoría (quién/cuándo/antes/después).
// Cubre los datos bancarios de pago móvil / transferencia, la tasa BCV, los TTL de reserva, PayPal on/off,
// reintentos de matrícula, recordatorios de cuotas, job de certificados y contacto de la tienda.
// order.nextNumber y seed.sampleData no se editan desde aquí (los mueve el sistema).
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { exchangeRateStatus, isPlaceholderText, manualMethodProblems, SETTING_KEYS, type ExchangeRateSetting, type ManualMethodConfig } from "@/server/settings";
import { readSetting } from "@/server/deps";

const manualMethod = z.object({
  method: z.enum(["PAGO_MOVIL", "TRANSFERENCIA", "ZELLE", "EFECTIVO"]),
  enabled: z.boolean(),
  label: z.string().trim().min(1).max(100),
  currency: z.enum(["USD", "VES"]),
  details: z.record(z.string(), z.string().max(300)),
  instructions: z.string().max(2000),
});

/** Esquema de cada clave editable. Una clave fuera de esta lista no se puede editar desde el panel. */
export const EDITABLE_SETTINGS = {
  [SETTING_KEYS.reservationTtlPaypal]: z.object({ minutes: z.number().int().min(5).max(24 * 60) }).strict(),
  [SETTING_KEYS.reservationTtlManual]: z.object({ hours: z.number().int().min(1).max(24 * 14) }).strict(),
  [SETTING_KEYS.manualMethods]: z
    .array(manualMethod)
    .max(10)
    .refine((a) => new Set(a.map((m) => m.method)).size === a.length, "Método repetido")
    // No se puede habilitar un método cuyos datos (banco, cuenta, titular…) están vacíos o son de ejemplo:
    // el comprador los recibe en el correo de confirmación para pagar.
    .superRefine((a, ctx) => {
      a.forEach((m, i) => {
        if (!m.enabled) return;
        for (const msg of manualMethodProblems(m)) ctx.addIssue({ code: "custom", path: [i, "details"], message: `${msg} Complétalo o deja el método deshabilitado.` });
      });
    }),
  [SETTING_KEYS.paypal]: z.object({ enabled: z.boolean() }).strict(),
  [SETTING_KEYS.exchangeRate]: z
    .object({
      vesPerUsd: z.number().positive("La tasa debe ser mayor que 0").max(1e9),
      source: z.string().max(300).refine((v) => !isPlaceholderText(v), "Indica la fuente de la tasa (p. ej. BCV)").optional(),
      updatedAt: z.string().optional(),
    })
    .strict(),
  [SETTING_KEYS.exchangeRateAuto]: z.object({ enabled: z.boolean() }).strict(),
  [SETTING_KEYS.enrollmentRetry]: z.object({ maxAttempts: z.number().int().min(1).max(30), baseDelaySeconds: z.number().int().min(5).max(86_400) }).strict(),
  [SETTING_KEYS.installmentReminders]: z
    .object({ daysBefore: z.number().int().min(0).max(60), overdueGraceDays: z.number().int().min(0).max(60), overdueEveryDays: z.number().int().min(1).max(60), maxOverdueReminders: z.number().int().min(0).max(20) })
    .strict(),
  [SETTING_KEYS.certificateJob]: z.object({ intervalMinutes: z.number().int().min(5).max(7 * 24 * 60) }).strict(),
  [SETTING_KEYS.storeContact]: z
    .object({ phones: z.array(z.string().max(50)).max(10), emails: z.array(z.email()).max(10), whatsapp: z.string().max(50).optional(), instagram: z.string().max(300).optional() })
    .strict(),
} as const;
export type EditableSettingKey = keyof typeof EDITABLE_SETTINGS;

export function isEditableSetting(key: string): key is EditableSettingKey {
  return Object.prototype.hasOwnProperty.call(EDITABLE_SETTINGS, key);
}

/** Actualiza una Setting validada. La tasa de cambio registra automáticamente su fecha de actualización. */
export async function updateSetting(d: Deps, actor: SessionUser, key: string, value: unknown, note?: string) {
  actor = await requireAdmin(d.db, actor, "settings.manage");
  if (!isEditableSetting(key)) throw new DomainError("VALIDATION", `La configuración «${key}» no se puede editar desde el panel.`);
  const r = (EDITABLE_SETTINGS[key] as z.ZodType).safeParse(value);
  if (!r.success) throw new DomainError("VALIDATION", r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join(". "), { issues: r.error.issues });
  let parsed = r.data as Record<string, unknown> | unknown[];
  if (key === SETTING_KEYS.exchangeRate) parsed = { ...(parsed as Record<string, unknown>), updatedAt: d.now().toISOString() };
  return withTx(d, async (tx) => {
    const before = await tx.setting.findUnique({ where: { key } });
    const after = await tx.setting.upsert({ where: { key }, create: { key, value: parsed as Prisma.InputJsonValue }, update: { value: parsed as Prisma.InputJsonValue } });
    await recordAudit(tx, { actor, action: "setting.update", entityType: "Setting", entityId: key, before: before?.value ?? null, after: after.value, note, force: !before });
    return after;
  });
}

export interface SettingsWarning {
  key: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * Avisos para el panel sobre la configuración de cobro: métodos manuales con datos de ejemplo y tasa Bs/USD
 * de ejemplo o desactualizada (el equivalente en USD de cada pago en bolívares depende de ella; el personal
 * puede corregirla al verificar cada pago).
 */
export async function getSettingsWarnings(d: Deps, actor: SessionUser): Promise<SettingsWarning[]> {
  await requireAdmin(d.db, actor, "orders.view");
  const out: SettingsWarning[] = [];
  const methods = await readSetting<ManualMethodConfig[]>(d.db, SETTING_KEYS.manualMethods, []);
  for (const m of methods) {
    const problems = manualMethodProblems(m);
    if (m.enabled && problems.length) for (const message of problems) out.push({ key: SETTING_KEYS.manualMethods, severity: "error", message: `${message} El método no se ofrece en la tienda hasta corregirlo.` });
  }
  if (methods.some((m) => m.enabled && m.currency === "VES")) {
    const st = exchangeRateStatus(await readSetting<ExchangeRateSetting | null>(d.db, SETTING_KEYS.exchangeRate, null), d.now());
    for (const message of st.blockers) out.push({ key: SETTING_KEYS.exchangeRate, severity: "error", message: `${message} Los métodos en bolívares no se ofrecen en la tienda hasta corregirla.` });
    for (const message of st.notices) out.push({ key: SETTING_KEYS.exchangeRate, severity: "warning", message: `${message} Se sigue usando, pero conviene actualizarla.` });
    const auto = await readSetting<{ enabled: boolean }>(d.db, SETTING_KEYS.exchangeRateAuto, { enabled: true });
    const sync = await readSetting<{ ok: boolean; message: string } | null>(d.db, SETTING_KEYS.exchangeRateSync, null);
    if (auto.enabled && sync && !sync.ok) out.push({ key: SETTING_KEYS.exchangeRateSync, severity: "warning", message: `No se pudo actualizar la tasa automáticamente: ${sync.message}` });
  }
  return out;
}
