// Configuración (réplica de Configuración › Pagos de Shopify): métodos de pago manuales con los datos que recibe el
// médico, PayPal, tasa BCV, tiempo de reserva del cupo y recordatorios de cuotas. Todo sale de la tabla Setting.
import type { Metadata } from "next";
import { can } from "@/server/auth";
import { readSetting } from "@/server/deps";
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
  const [methods, paypal, rate, ttlPaypal, ttlManual, reminders, warnings] = await Promise.all([
    readSetting<ManualMethodConfig[]>(db, SETTING_KEYS.manualMethods, []),
    readSetting<{ enabled: boolean }>(db, SETTING_KEYS.paypal, { enabled: true }),
    readSetting<ExchangeRateSetting | null>(db, SETTING_KEYS.exchangeRate, null),
    readSetting<{ minutes: number }>(db, SETTING_KEYS.reservationTtlPaypal, { minutes: 30 }),
    readSetting<{ hours: number }>(db, SETTING_KEYS.reservationTtlManual, { hours: 72 }),
    readSetting<InstallmentReminderPolicy>(db, SETTING_KEYS.installmentReminders, DEFAULT_INSTALLMENT_REMINDERS),
    s.settings.getSettingsWarnings(user),
  ]);
  const st = exchangeRateStatus(rate, s.deps.now());
  const data: SettingsData = {
    methods: Array.isArray(methods) ? methods : [],
    paypalEnabled: paypal.enabled !== false,
    rate: { vesPerUsd: rate?.vesPerUsd ?? null, source: st.placeholder ? "" : (rate?.source ?? ""), updatedAt: rate?.updatedAt ?? null, placeholder: st.placeholder, stale: st.stale },
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
