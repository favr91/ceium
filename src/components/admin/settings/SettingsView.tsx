"use client";
// Configuración del panel (réplica de Configuración › Pagos de Shopify, en secciones anotadas): métodos de pago
// manuales (datos que el médico recibe para pagar), PayPal, tasa Bs/USD, reservas de cupo y recordatorios de cuotas.
// Cada sección se guarda por separado con saveSettingsAction (valida y audita en el servidor).
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveSettingsAction, syncRateNowAction } from "@/app/admin/(panel)/settings/actions";
import { Icon } from "../Icon";
import { useToast } from "../ui";
import "./settings.css";

export interface ManualMethod {
  method: "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "EFECTIVO";
  enabled: boolean;
  label: string;
  currency: "USD" | "VES";
  details: Record<string, string>;
  instructions: string;
}

export interface SettingsData {
  methods: ManualMethod[];
  /** Métodos activos que la tienda NO ofrece ahora, con el motivo (null = se ofrece). Refleja lo guardado. */
  hiddenReasons: Partial<Record<ManualMethod["method"], string | null>>;
  paypalEnabled: boolean;
  rate: { vesPerUsd: number | null; source: string; updatedAt: string | null; placeholder: boolean; stale: boolean; valueDate: string | null; auto: boolean };
  /** Actualización automática de la tasa desde el BCV (DolarApi, respaldo DolarVZLA). */
  rateAuto: boolean;
  /** Última consulta automática (null: nunca se consultó). */
  rateSync: { checkedAt: string; ok: boolean; message: string } | null;
  /** Verificación en dos pasos: si el equipo la exige, si el usuario actual la tiene y quiénes no. */
  security: { require2fa: boolean; meEnabled: boolean; team: number; without: string[] };
  ttlPaypalMinutes: number;
  ttlManualHours: number;
  reminders: { daysBefore: number; overdueGraceDays: number; overdueEveryDays: number; maxOverdueReminders: number };
  warnings: { severity: "error" | "warning"; message: string }[];
}

const DETAIL_LABELS: Record<string, string> = {
  banco: "Banco",
  telefono: "Teléfono",
  cedulaRif: "Cédula / RIF",
  titular: "Titular",
  cuenta: "Número de cuenta",
  tipo: "Tipo de cuenta",
  correo: "Correo Zelle",
  lugar: "Dónde pagar",
};
const METHOD_HELP: Record<ManualMethod["method"], string> = {
  PAGO_MOVIL: "El médico paga en bolívares a la tasa del día y sube el comprobante.",
  TRANSFERENCIA: "Transferencia bancaria en bolívares con comprobante.",
  ZELLE: "Pago en dólares por Zelle con la confirmación.",
  EFECTIVO: "Pago en la sede; el personal lo registra desde el pedido.",
};

/** Dato de ejemplo del seed («TODO: banco», «04xx-xxxxxxx»): se muestra como pista, no como valor. */
const isPlaceholder = (v: string) => !v.trim() || /\bTODO\b|x{3,}|^[-/.\s]+$/i.test(v.trim());

/** «187,25», «187.25» o «1.234,5» → número; otra cosa → NaN. */
function parseRate(raw: string): number {
  const s = raw.trim().replace(/\s/g, "");
  if (!s) return NaN;
  const norm = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  return /^\d+(\.\d+)?$/.test(norm) ? Number(norm) : NaN;
}
const int = (raw: string) => (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
const fmtRate = (n: number | null) => (n == null ? "" : n.toLocaleString("es-VE", { maximumFractionDigits: 4 }));
const fmtWhen = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("es-VE", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Caracas" }).format(new Date(iso)) : null;

/** «2026-09-29» → «martes, 29 de septiembre» (fecha valor BCV). */
const fmtValueDate = (d: string | null) =>
  d ? new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : null;

type MethodForm = ManualMethod & { hints: Record<string, string> };

export function SettingsView({ data, canEdit }: { data: SettingsData; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const initialMethods = (): MethodForm[] =>
    data.methods.map((m) => {
      const hints: Record<string, string> = {};
      const details: Record<string, string> = {};
      for (const [k, v] of Object.entries(m.details ?? {})) {
        if (isPlaceholder(String(v ?? ""))) {
          hints[k] = String(v ?? "").replace(/^TODO:\s*/i, "");
          details[k] = "";
        } else details[k] = String(v);
      }
      return { ...m, details, hints, instructions: isPlaceholder(m.instructions ?? "") ? "" : m.instructions };
    });
  const [methods, setMethods] = useState<MethodForm[]>(initialMethods);
  const [paypal, setPaypal] = useState(data.paypalEnabled);
  // Carga manual: arranca con la tasa en uso (vacía si es la de ejemplo) y se reinicia cuando la tasa guardada
  // cambia (p. ej. tras «Consultar ahora»); la fuente de una tasa automática se muestra como «BCV».
  const manualRate = () => ({ vesPerUsd: data.rate.placeholder ? "" : fmtRate(data.rate.vesPerUsd), source: data.rate.auto ? "BCV" : data.rate.source || "BCV" });
  const [rate, setRate] = useState(manualRate);
  const [rateSeen, setRateSeen] = useState(data.rate.updatedAt);
  if (rateSeen !== data.rate.updatedAt) {
    setRateSeen(data.rate.updatedAt);
    setRate(manualRate());
  }
  const [rateAuto, setRateAuto] = useState(data.rateAuto);
  const [require2fa, setRequire2fa] = useState(data.security.require2fa);
  const [lastRequire, setLastRequire] = useState(data.security.require2fa);
  if (lastRequire !== data.security.require2fa) {
    setLastRequire(data.security.require2fa);
    setRequire2fa(data.security.require2fa);
  }
  const [ttl, setTtl] = useState({ paypal: String(data.ttlPaypalMinutes), manual: String(data.ttlManualHours) });
  const [rem, setRem] = useState({
    daysBefore: String(data.reminders.daysBefore),
    overdueGraceDays: String(data.reminders.overdueGraceDays),
    overdueEveryDays: String(data.reminders.overdueEveryDays),
    maxOverdueReminders: String(data.reminders.maxOverdueReminders),
  });

  const save = (section: string, entries: { key: string; value: unknown }[]) => {
    setBusy(section);
    setErrors((e) => ({ ...e, [section]: null }));
    start(async () => {
      try {
        const r = await saveSettingsAction(entries);
        if (r.ok) {
          toast.show(r.message);
          router.refresh();
        } else {
          setErrors((e) => ({ ...e, [section]: r.error }));
          toast.show("No se guardó: revisa el aviso de la sección.", true);
        }
      } catch {
        setErrors((e) => ({ ...e, [section]: "No pudimos guardar. Revisa tu conexión e intenta de nuevo." }));
      } finally {
        setBusy(null);
      }
    });
  };

  const setMethod = (i: number, patch: Partial<MethodForm>) => setMethods((all) => all.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const methodProblems = (m: MethodForm) => {
    if (!m.enabled) return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(m.details)) if (!v.trim()) out.push(`Falta «${DETAIL_LABELS[k] ?? k}».`);
    if (!m.instructions.trim()) out.push("Faltan las instrucciones para el médico.");
    return out;
  };
  const saveMethods = () => {
    if (methods.some((m) => methodProblems(m).length)) {
      setErrors((e) => ({ ...e, methods: "Completa los datos marcados de los métodos activos, o desactívalos." }));
      return;
    }
    save("methods", [{ key: "payments.manualMethods", value: methods.map(({ hints: _h, ...m }) => (void _h, { ...m, label: m.label.trim(), instructions: m.instructions.trim(), details: Object.fromEntries(Object.entries(m.details).map(([k, v]) => [k, v.trim()])) })) }]);
  };
  const saveRate = () => {
    const n = parseRate(rate.vesPerUsd);
    if (!(n > 0)) return setErrors((e) => ({ ...e, rate: "Escribe la tasa en bolívares por dólar, p. ej. 187,25." }));
    if (!rate.source.trim()) return setErrors((e) => ({ ...e, rate: "Indica la fuente de la tasa (p. ej. BCV)." }));
    save("rate", [{ key: "exchangeRate.vesPerUsd", value: { vesPerUsd: n, source: rate.source.trim() } }]);
  };
  const toggleRequire2fa = (enabled: boolean) => {
    setRequire2fa(enabled);
    setBusy("security");
    setErrors((e) => ({ ...e, security: null }));
    start(async () => {
      try {
        const r = await saveSettingsAction([{ key: "security.require2fa", value: { enabled } }]);
        if (r.ok) {
          toast.show(enabled ? "Listo: todo el equipo deberá usar la verificación en dos pasos." : "Ya no se exige la verificación en dos pasos.");
          router.refresh();
        } else {
          setRequire2fa(!enabled); // no se guardó: el interruptor vuelve a su estado real
          setErrors((e) => ({ ...e, security: r.error }));
        }
      } catch {
        setRequire2fa(!enabled);
        setErrors((e) => ({ ...e, security: "No pudimos guardar. Revisa tu conexión e intenta de nuevo." }));
      } finally {
        setBusy(null);
      }
    });
  };
  const toggleRateAuto = (enabled: boolean) => {
    setRateAuto(enabled);
    save("rateAuto", [{ key: "exchangeRate.auto", value: { enabled } }]);
  };
  const syncRateNow = () => {
    setBusy("rateSync");
    setErrors((e) => ({ ...e, rate: null }));
    start(async () => {
      try {
        const r = await syncRateNowAction();
        if (r.ok) toast.show(r.message);
        else {
          setErrors((e) => ({ ...e, rate: r.error }));
          toast.show("No se actualizó la tasa: revisa el aviso de la sección.", true);
        }
        router.refresh();
      } catch {
        setErrors((e) => ({ ...e, rate: "No pudimos consultar la tasa. Revisa tu conexión e intenta de nuevo." }));
      } finally {
        setBusy(null);
      }
    });
  };
  const saveTtl = () => {
    const p = int(ttl.paypal);
    const m = int(ttl.manual);
    if (!(p >= 5 && p <= 1440)) return setErrors((e) => ({ ...e, ttl: "La reserva con PayPal va de 5 a 1440 minutos." }));
    if (!(m >= 1 && m <= 336)) return setErrors((e) => ({ ...e, ttl: "La reserva con pago manual va de 1 a 336 horas (14 días)." }));
    save("ttl", [
      { key: "reservation.ttl.paypal", value: { minutes: p } },
      { key: "reservation.ttl.manual", value: { hours: m } },
    ]);
  };
  const saveReminders = () => {
    const v = { daysBefore: int(rem.daysBefore), overdueGraceDays: int(rem.overdueGraceDays), overdueEveryDays: int(rem.overdueEveryDays), maxOverdueReminders: int(rem.maxOverdueReminders) };
    if (Object.values(v).some((x) => !Number.isFinite(x))) return setErrors((e) => ({ ...e, reminders: "Usa números enteros (0 o más)." }));
    save("reminders", [{ key: "installments.reminders", value: v }]);
  };

  const ro = !canEdit;
  const sectionError = (k: string) =>
    errors[k] ? (
      <div className="banner critical" role="alert">
        <Icon name="alert" />
        <span>{errors[k]}</span>
      </div>
    ) : null;
  const saveButton = (k: string, label: string, onClick: () => void) =>
    canEdit ? (
      <div className="set-actions">
        <button type="button" className="btn btn-primary" disabled={pending && busy === k} onClick={onClick}>
          {pending && busy === k ? "Guardando…" : label}
        </button>
      </div>
    ) : null;
  const updated = fmtWhen(data.rate.updatedAt);

  return (
    <>
      <div className="adm-ph">
        <div className="grow">
          <h1>Configuración</h1>
          <div className="meta">Cobros, tasa de cambio, reservas de cupo y recordatorios</div>
        </div>
      </div>
      {ro ? (
        <div className="banner info" role="status">
          <Icon name="info" />
          <span>Tu rol (personal) puede ver la configuración; solo un administrador puede cambiarla.</span>
        </div>
      ) : null}
      {data.warnings.length ? (
        <div className={`banner ${data.warnings.some((w) => w.severity === "error") ? "critical" : "attention"}`} role="note" data-testid="settings-warnings">
          <Icon name="alert" />
          <ul className="set-warn">
            {data.warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="set-sec" aria-labelledby="h-manual">
        <div className="set-ann">
          <h2 id="h-manual">Pagos manuales</h2>
          <p>Datos que el médico ve en el checkout y recibe por correo para pagar. Cada pago manual queda en verificación hasta que el equipo lo apruebe.</p>
        </div>
        <div className="card set-card">
          {sectionError("methods")}
          {methods.map((m, i) => {
            const problems = methodProblems(m);
            const saved = data.methods.find((x) => x.method === m.method);
            const hiddenReason = saved?.enabled ? data.hiddenReasons[m.method] ?? null : null;
            return (
              <fieldset key={m.method} className="set-method" data-method={m.method} aria-label={m.label || m.method}>
                <div className="set-method-h">
                  <div className="grow">
                    <div className="t">
                      {m.label || m.method}
                      {hiddenReason ? (
                        <span className="badge sm critical" data-testid="method-hidden">No visible en la tienda</span>
                      ) : (
                        <span className={`badge sm ${m.enabled ? "success" : ""}`}>{m.enabled ? "Activo" : "Inactivo"}</span>
                      )}
                      <span className="badge sm">{m.currency === "VES" ? "Bs." : "USD"}</span>
                    </div>
                    <div className="small muted">{METHOD_HELP[m.method]}</div>
                    {hiddenReason ? (
                      <p className="field-err" data-testid="method-hidden-reason">
                        <span>
                          Está activado, pero el checkout no lo ofrece: {hiddenReason}{" "}
                          {m.currency === "VES" && data.rate.placeholder ? <a href="#h-rate">Actualizar la tasa</a> : null}
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <input type="checkbox" className="toggle" role="switch" aria-label={`Activar ${m.label || m.method}`} checked={m.enabled} disabled={ro} onChange={(e) => setMethod(i, { enabled: e.target.checked })} />
                </div>
                <div className="set-grid">
                  <label className="field">
                    <span>Nombre visible</span>
                    <input className="inp" aria-label={`Nombre visible de ${m.method}`} value={m.label} disabled={ro} onChange={(e) => setMethod(i, { label: e.target.value })} />
                  </label>
                  {Object.keys(m.details).map((k) => {
                    const missing = m.enabled && !m.details[k].trim();
                    const label = DETAIL_LABELS[k] ?? k;
                    return (
                      <label className="field" key={k}>
                        <span>{label}</span>
                        <input
                          className="inp"
                          aria-label={`${label} (${m.label || m.method})`}
                          value={m.details[k]}
                          placeholder={m.hints[k] || undefined}
                          aria-invalid={missing}
                          disabled={ro}
                          onChange={(e) => setMethod(i, { details: { ...m.details, [k]: e.target.value } })}
                        />
                      </label>
                    );
                  })}
                </div>
                <label className="field">
                  <span>Instrucciones para el médico</span>
                  <textarea className="inp" rows={2} aria-label={`Instrucciones (${m.label || m.method})`} value={m.instructions} aria-invalid={m.enabled && !m.instructions.trim()} disabled={ro} onChange={(e) => setMethod(i, { instructions: e.target.value })} />
                </label>
                {problems.length ? <p className="field-err">{problems.join(" ")}</p> : null}
              </fieldset>
            );
          })}
          {!methods.length ? <p className="muted">No hay métodos manuales configurados.</p> : null}
          {saveButton("methods", "Guardar pagos manuales", saveMethods)}
        </div>
      </section>

      <section className="set-sec" aria-labelledby="h-paypal">
        <div className="set-ann">
          <h2 id="h-paypal">PayPal</h2>
          <p>Cobro automático con tarjeta o cuenta PayPal. El pedido se confirma y matricula en Moodle sin intervención del equipo.</p>
        </div>
        <div className="card set-card">
          {sectionError("paypal")}
          <label className="set-switch">
            <input type="checkbox" className="toggle" role="switch" aria-label="Ofrecer PayPal en la tienda" checked={paypal} disabled={ro} onChange={(e) => setPaypal(e.target.checked)} />
            <span className="t">
              Ofrecer PayPal en la tienda
              <span className="d">Si lo desactivas, el checkout y los recordatorios solo ofrecen los pagos manuales activos.</span>
            </span>
          </label>
          {saveButton("paypal", "Guardar PayPal", () => save("paypal", [{ key: "payments.paypal", value: { enabled: paypal } }]))}
        </div>
      </section>

      <section className="set-sec" aria-labelledby="h-rate">
        <div className="set-ann">
          <h2 id="h-rate">Tasa de cambio</h2>
          <p>Bolívares por dólar para cobrar en Bs. los pagos manuales. Se usa la tasa oficial del BCV con fecha valor de hoy.</p>
        </div>
        <div className="card set-card">
          {sectionError("rateAuto")}
          {sectionError("rate")}
          {data.rate.placeholder ? (
            <div className="banner attention" role="note">
              <Icon name="alert" />
              <span>La tasa actual es de ejemplo: los métodos en bolívares no se ofrecen hasta que la actualices{rateAuto ? " (pulsa «Consultar ahora»)" : ""}.</span>
            </div>
          ) : null}
          <label className="set-switch">
            <input type="checkbox" className="toggle" role="switch" aria-label="Actualizar la tasa automáticamente desde el BCV" checked={rateAuto} disabled={ro || (pending && busy === "rateAuto")} onChange={(e) => toggleRateAuto(e.target.checked)} />
            <span className="t">
              Actualizar automáticamente con la tasa oficial del BCV
              <span className="d">Se consulta cada hora la tasa oficial publicada por el BCV. Si hay datos inconsistentes o el valor parece erróneo, se mantiene la tasa anterior y verás un aviso aquí.</span>
            </span>
          </label>

          <div className="set-rate-now" data-testid="rate-current">
            <div className="set-rate-val">
              <span className="small muted">Tasa en uso</span>
              <strong className="mono">{data.rate.vesPerUsd && !data.rate.placeholder ? `Bs. ${fmtRate(data.rate.vesPerUsd)} por USD` : "Sin tasa válida"}</strong>
              <span className="small muted">
                {data.rate.placeholder
                  ? "Tasa de ejemplo de la instalación."
                  : data.rate.auto && data.rate.valueDate
                    ? `Oficial del BCV, fecha valor ${fmtValueDate(data.rate.valueDate)}`
                    : `Escrita a mano${data.rate.source ? ` · ${data.rate.source}` : ""}`}
                {updated ? ` · ${data.rate.auto ? "verificada" : "guardada"} ${updated}` : ""}
              </span>
            </div>
            {canEdit ? (
              <button type="button" className="btn" onClick={syncRateNow} disabled={pending && busy === "rateSync"}>
                {pending && busy === "rateSync" ? "Consultando…" : "Consultar ahora"}
              </button>
            ) : null}
          </div>
          {data.rateSync ? (
            <p className={`small ${data.rateSync.ok ? "muted" : "set-sync-err"}`} data-testid="rate-sync">
              {data.rateSync.ok ? `Última consulta automática: ${fmtWhen(data.rateSync.checkedAt)?.replace(/\.$/, "")}. Se vuelve a consultar cada hora.` : `La última consulta automática falló (${fmtWhen(data.rateSync.checkedAt)}): ${data.rateSync.message}`}
            </p>
          ) : (
            <p className="small muted" data-testid="rate-sync">Aún no se ha consultado la tasa automáticamente.</p>
          )}

          <div className="set-manual">
            <h3 className="set-h3">Escribir la tasa a mano</h3>
            <p className="small muted">{rateAuto ? "Útil si las fuentes fallan. La próxima consulta automática la reemplaza con la del BCV; apaga la actualización automática para fijarla." : "La actualización automática está apagada: esta tasa se usa hasta que la cambies."}</p>
            <div className="grid2">
              <label className="field">
                <span>Bs. por USD</span>
                <span className="inp-affix">
                  <span className="pre">Bs.</span>
                  <input className="inp num has-pre set-bs" inputMode="decimal" aria-label="Bolívares por dólar" value={rate.vesPerUsd} disabled={ro} onChange={(e) => setRate((r) => ({ ...r, vesPerUsd: e.target.value }))} />
                </span>
              </label>
              <label className="field">
                <span>Fuente</span>
                <input className="inp" aria-label="Fuente de la tasa" value={rate.source} placeholder="BCV" disabled={ro} onChange={(e) => setRate((r) => ({ ...r, source: e.target.value }))} />
              </label>
            </div>
            {saveButton("rate", "Actualizar tasa", saveRate)}
          </div>
        </div>
      </section>

      <section className="set-sec" aria-labelledby="h-ttl">
        <div className="set-ann">
          <h2 id="h-ttl">Reserva de cupo</h2>
          <p>Cuánto tiempo se aparta el cupo de una cohorte mientras el médico paga. Si no se confirma a tiempo, se libera.</p>
        </div>
        <div className="card set-card">
          {sectionError("ttl")}
          <div className="grid2">
            <label className="field">
              <span>Con PayPal</span>
              <span className="inp-affix">
                <input className="inp num has-suf" inputMode="numeric" aria-label="Minutos de reserva con PayPal" value={ttl.paypal} disabled={ro} onChange={(e) => setTtl((t) => ({ ...t, paypal: e.target.value }))} />
                <span className="suf">min</span>
              </span>
            </label>
            <label className="field">
              <span>Con pago manual (hasta verificarlo)</span>
              <span className="inp-affix">
                <input className="inp num has-suf" inputMode="numeric" aria-label="Horas de reserva con pago manual" value={ttl.manual} disabled={ro} onChange={(e) => setTtl((t) => ({ ...t, manual: e.target.value }))} />
                <span className="suf">h</span>
              </span>
            </label>
          </div>
          {saveButton("ttl", "Guardar reservas", saveTtl)}
        </div>
      </section>

      <section className="set-sec" aria-labelledby="h-rem">
        <div className="set-ann">
          <h2 id="h-rem">Recordatorios de cuotas</h2>
          <p>Correo con el enlace directo de pago de la siguiente cuota (planes mes a mes y mitad). También puedes enviarlo desde cada pedido.</p>
        </div>
        <div className="card set-card">
          {sectionError("reminders")}
          <div className="grid2">
            <label className="field">
              <span>Días antes del vencimiento</span>
              <input className="inp num" inputMode="numeric" aria-label="Días antes del vencimiento" value={rem.daysBefore} disabled={ro} onChange={(e) => setRem((r) => ({ ...r, daysBefore: e.target.value }))} />
            </label>
            <label className="field">
              <span>Días de gracia antes de marcarla vencida</span>
              <input className="inp num" inputMode="numeric" aria-label="Días de gracia" value={rem.overdueGraceDays} disabled={ro} onChange={(e) => setRem((r) => ({ ...r, overdueGraceDays: e.target.value }))} />
            </label>
            <label className="field">
              <span>Repetir cada (días) si está vencida</span>
              <input className="inp num" inputMode="numeric" aria-label="Repetir cada (días)" value={rem.overdueEveryDays} disabled={ro} onChange={(e) => setRem((r) => ({ ...r, overdueEveryDays: e.target.value }))} />
            </label>
            <label className="field">
              <span>Máximo de avisos de cuota vencida</span>
              <input className="inp num" inputMode="numeric" aria-label="Máximo de avisos" value={rem.maxOverdueReminders} disabled={ro} onChange={(e) => setRem((r) => ({ ...r, maxOverdueReminders: e.target.value }))} />
            </label>
          </div>
          {saveButton("reminders", "Guardar recordatorios", saveReminders)}
        </div>
      </section>

      <section className="set-sec" aria-labelledby="h-sec">
        <div className="set-ann">
          <h2 id="h-sec">Seguridad del panel</h2>
          <p>Cada usuario activa su verificación en dos pasos desde su menú (Mi cuenta y seguridad). Aquí puedes exigirla a todo el equipo.</p>
        </div>
        <div className="card set-card">
          {sectionError("security")}
          <label className="set-switch">
            <input
              type="checkbox"
              className="toggle"
              role="switch"
              aria-label="Exigir la verificación en dos pasos a todo el equipo"
              checked={require2fa}
              disabled={ro || (pending && busy === "security") || (!require2fa && !data.security.meEnabled)}
              onChange={(e) => toggleRequire2fa(e.target.checked)}
            />
            <span className="t">
              Exigir la verificación en dos pasos a todo el equipo
              <span className="d">Quien no la tenga activada solo podrá entrar a Mi cuenta hasta activarla.</span>
            </span>
          </label>
          {!data.security.meEnabled ? (
            <p className="small muted" style={{ marginTop: 8 }}>
              Para exigirla, primero actívala en tu cuenta: <a className="lk" href="/admin/account#dos-pasos">Mi cuenta y seguridad</a>.
            </p>
          ) : null}
          <p className="small muted" data-testid="team-2fa" style={{ marginTop: 8 }}>
            {data.security.without.length === 0
              ? `Todo el equipo (${data.security.team}) la tiene activada.`
              : `${data.security.team - data.security.without.length} de ${data.security.team} usuarios la tienen activada. Falta: ${data.security.without.join(", ")}.`}
          </p>
        </div>
      </section>
      {toast.node}
    </>
  );
}
