// Configuración (réplica de Configuración › Pagos de Shopify): métodos de pago manuales con los datos que recibe el
// médico, PayPal, tasa BCV, tiempo de reserva del cupo y recordatorios de cuotas. Todo sale de la tabla Setting.
import type { Metadata } from "next";
import { can } from "@/server/auth";
import { readSetting } from "@/server/deps";
import type { ExchangeRateAutoSetting, RateSyncStatus } from "@/server/exchange-rate";
import { manualMethodUnavailableReason } from "@/server/orders";
import { services } from "@/server/services";
import { DEFAULT_INSTALLMENT_REMINDERS, SETTING_KEYS, exchangeRateStatus, type ExchangeRateSetting, type InstallmentReminderPolicy, type ManualMethodConfig } from "@/server/settings";
import { SettingsView, type SettingsData } from "@/components/admin/settings/SettingsView";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Configuración" };

export default async function SettingsPage() {
  const user = await requireAdminPage("orders.view", "/admin/settings");
  const s = services();
  const db = s.deps.db;
  const [methods, paypal, rate, ttlPaypal, ttlManual, reminders, warnings, rateAuto, rateSync, require2fa, team] = await Promise.all([
    readSetting<ManualMethodConfig[]>(db, SETTING_KEYS.manualMethods, []),
    readSetting<{ enabled: boolean }>(db, SETTING_KEYS.paypal, { enabled: true }),
    readSetting<ExchangeRateSetting | null>(db, SETTING_KEYS.exchangeRate, null),
    readSetting<{ minutes: number }>(db, SETTING_KEYS.reservationTtlPaypal, { minutes: 30 }),
    readSetting<{ hours: number }>(db, SETTING_KEYS.reservationTtlManual, { hours: 72 }),
    readSetting<InstallmentReminderPolicy>(db, SETTING_KEYS.installmentReminders, DEFAULT_INSTALLMENT_REMINDERS),
    s.settings.getSettingsWarnings(user),
    readSetting<ExchangeRateAutoSetting>(db, SETTING_KEYS.exchangeRateAuto, { enabled: true }),
    readSetting<RateSyncStatus | null>(db, SETTING_KEYS.exchangeRateSync, null),
    readSetting<{ enabled: boolean }>(db, SETTING_KEYS.require2fa, { enabled: false }),
    db.adminUser.findMany({ where: { active: true }, select: { id: true, name: true, totpEnabledAt: true } }),
  ]);
  const st = exchangeRateStatus(rate, s.deps.now());
  const list = Array.isArray(methods) ? methods : [];
  // Lo mismo que decide el checkout: un método activo puede quedar fuera de la tienda (datos o tasa de ejemplo).
  const hiddenReasons = Object.fromEntries(
    await Promise.all(list.filter((m) => m.enabled).map(async (m) => [m.method, await manualMethodUnavailableReason(s.deps, m)] as const)),
  );
  const data: SettingsData = {
    methods: list,
    hiddenReasons,
    paypalEnabled: paypal.enabled !== false,
    rate: { vesPerUsd: rate?.vesPerUsd ?? null, source: st.placeholder ? "" : (rate?.source ?? ""), updatedAt: rate?.updatedAt ?? null, placeholder: st.placeholder, stale: st.stale, valueDate: rate?.valueDate ?? null, auto: !!rate?.auto },
    rateAuto: rateAuto.enabled !== false,
    rateSync: rateSync ? { checkedAt: rateSync.checkedAt, ok: rateSync.ok, message: rateSync.message } : null,
    security: {
      require2fa: require2fa.enabled === true,
      meEnabled: team.some((u) => u.id === user.id && !!u.totpEnabledAt),
      team: team.length,
      without: team.filter((u) => !u.totpEnabledAt).map((u) => u.name),
    },
    ttlPaypalMinutes: ttlPaypal.minutes,
    ttlManualHours: ttlManual.hours,
    reminders,
    warnings: warnings.map((w) => ({ severity: w.severity, message: w.message })),
  };
  return (
    <div className="adm-page">
      <SettingsView data={data} canEdit={can(user, "settings.manage")} />
    </div>
  );
}
