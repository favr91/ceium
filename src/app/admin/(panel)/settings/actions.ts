"use server";
// Acciones de Configuración del panel. Toda escritura pasa por services().settings.updateSetting, que valida el
// valor con el esquema de su clave (p. ej. no deja habilitar un método de pago con datos de ejemplo) y deja
// AuditLog (quién, cuándo, antes/después) en la misma transacción.
import { revalidatePath } from "next/cache";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { requireAdminAction } from "../../_lib/session";

export type SettingsResult = { ok: true; message: string } | { ok: false; error: string };

const MESSAGES: Record<string, string> = {
  "payments.manualMethods": "Métodos de pago manuales guardados.",
  "payments.paypal": "PayPal guardado.",
  "exchangeRate.vesPerUsd": "Tasa de cambio actualizada.",
  "reservation.ttl.paypal": "Reserva de PayPal guardada.",
  "reservation.ttl.manual": "Reserva de pagos manuales guardada.",
  "installments.reminders": "Recordatorios de cuotas guardados.",
};

/** Guarda una o varias claves (en orden). Se detiene en la primera que el servicio rechace. */
export async function saveSettingsAction(entries: { key: string; value: unknown }[]): Promise<SettingsResult> {
  const user = await requireAdminAction();
  try {
    for (const e of entries) await services().settings.updateSetting(user, e.key, e.value);
  } catch (e) {
    if (isDomainError(e)) return { ok: false, error: e.message };
    console.error("[admin/settings]", e);
    return { ok: false, error: "No pudimos guardar la configuración. Intenta de nuevo." };
  } finally {
    revalidatePath("/admin/settings");
    // La tienda y el checkout leen los métodos, la tasa y las reservas en cada solicitud.
    revalidatePath("/", "layout");
  }
  return { ok: true, message: entries.length === 1 ? (MESSAGES[entries[0].key] ?? "Configuración guardada.") : "Configuración guardada." };
}
