// Tasa oficial BCV automática (Bs. por USD) para cobrar en bolívares.
//
// Fuentes: DolarApi (principal, https://ve.dolarapi.com, código abierto) y DolarVZLA (respaldo,
// https://rates.dolarvzla.com, JSON estático). Ninguna pide clave. Ambas replican lo que publica
// https://www.bcv.org.ve; el sitio del BCV no se consulta directo porque su certificado TLS está mal configurado
// y su Excel cambia de nombre cada trimestre.
//
// Fecha valor: el BCV publica en la tarde la tasa del día hábil SIGUIENTE. Se cobra con la tasa cuya fecha
// valor es la de hoy (hora de Caracas) o, si hoy no hubo publicación (fin de semana, feriado), la última
// anterior. Nunca con la de mañana.
//
// Reglas al guardar:
//   - Ambas fuentes responden con la misma fecha y difieren más de RATE_MAX_SPREAD → no se toca la tasa (aviso).
//   - Fechas distintas → se usa la más reciente (la otra aún no se actualizó).
//   - Solo una responde → se usa esa.
//   - Salto mayor que RATE_MAX_JUMP frente a la tasa guardada → se rechaza por sospechoso (aviso; el
//     administrador puede escribirla a mano).
// El resultado de cada consulta queda en la Setting exchangeRate.sync (el panel lo muestra).
import type { Prisma } from "@/generated/prisma/client";
import { recordAudit } from "@/server/audit";
import { readSetting, withTx, type Deps } from "@/server/deps";
import { exchangeRateStatus, SETTING_KEYS, type ExchangeRateSetting } from "@/server/settings";

export type RateProvider = "DolarApi" | "DolarVZLA";
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateQuote {
  provider: RateProvider;
  vesPerUsd: number;
  /** Fecha valor BCV (YYYY-MM-DD). */
  valueDate: string;
}

export interface RateSourceResult {
  provider: RateProvider;
  ok: boolean;
  vesPerUsd?: number;
  valueDate?: string;
  error?: string;
}

export interface RateSyncStatus {
  /** Cuándo se consultó (ISO). */
  checkedAt: string;
  ok: boolean;
  /** Resumen para el panel. */
  message: string;
  /** La tasa guardada tras esta consulta, si la consulta fue buena. */
  applied?: RateQuote;
  /** true si esta consulta cambió la tasa (valor o fecha valor). */
  changed?: boolean;
  sources: RateSourceResult[];
}

/** { enabled } — actualización automática de la tasa desde el BCV (editable en el panel). */
export interface ExchangeRateAutoSetting {
  enabled: boolean;
}

/** Diferencia máxima aceptada entre las dos fuentes para la misma fecha valor (0,5 %). */
export const RATE_MAX_SPREAD = 0.005;
/** Salto máximo aceptado frente a la tasa guardada (30 %); más que eso se considera un dato erróneo. */
export const RATE_MAX_JUMP = 0.3;
/** Entre consultas cuando la tasa de hoy ya está al día. */
export const RATE_CHECK_EVERY_MS = 60 * 60_000;
/** Reintento tras una consulta fallida. */
export const RATE_RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/** Fecha de hoy en Caracas (YYYY-MM-DD). */
export function caracasToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(now);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function getJson(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`sin respuesta en ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function validRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** DolarApi: /v1/dolares/oficial; si ya trae la tasa de mañana, busca la de hoy en /v1/historicos/dolares/oficial. */
export async function fetchDolarApi(fetchFn: FetchLike, baseUrl: string, today: string, timeoutMs: number): Promise<RateQuote> {
  const base = baseUrl.replace(/\/$/, "");
  const cur = (await getJson(fetchFn, `${base}/v1/dolares/oficial`, timeoutMs)) as { promedio?: unknown; fechaActualizacion?: unknown };
  const curDate = typeof cur?.fechaActualizacion === "string" ? cur.fechaActualizacion.slice(0, 10) : "";
  if (validRate(cur?.promedio) && ISO_DATE.test(curDate) && curDate <= today) return { provider: "DolarApi", vesPerUsd: cur.promedio, valueDate: curDate };
  const hist = (await getJson(fetchFn, `${base}/v1/historicos/dolares/oficial`, timeoutMs)) as { promedio?: unknown; fecha?: unknown }[];
  if (!Array.isArray(hist)) throw new Error("respuesta inesperada del histórico");
  let best: RateQuote | null = null;
  for (const h of hist) {
    const date = typeof h?.fecha === "string" ? h.fecha.slice(0, 10) : "";
    if (!validRate(h?.promedio) || !ISO_DATE.test(date) || date > today) continue;
    if (!best || date > best.valueDate) best = { provider: "DolarApi", vesPerUsd: h.promedio, valueDate: date };
  }
  if (!best) throw new Error("no hay tasa con fecha valor de hoy o anterior");
  return best;
}

/** DolarVZLA: /bcv/current.json trae la tasa actual y la anterior; se toma la de fecha valor ≤ hoy. */
export async function fetchDolarVzla(fetchFn: FetchLike, baseUrl: string, today: string, timeoutMs: number): Promise<RateQuote> {
  const base = baseUrl.replace(/\/$/, "");
  const j = (await getJson(fetchFn, `${base}/bcv/current.json`, timeoutMs)) as { current?: { usd?: unknown; date?: unknown }; previous?: { usd?: unknown; date?: unknown } };
  for (const r of [j?.current, j?.previous]) {
    const date = typeof r?.date === "string" ? r.date.slice(0, 10) : "";
    if (validRate(r?.usd) && ISO_DATE.test(date) && date <= today) return { provider: "DolarVZLA", vesPerUsd: r.usd, valueDate: date };
  }
  throw new Error("no hay tasa con fecha valor de hoy o anterior");
}

const fmt = (n: number) => n.toLocaleString("es-VE", { maximumFractionDigits: 4 });

/** Decide qué tasa usar con lo que respondieron las fuentes (sin tocar la BD). */
export function pickRate(results: RateSourceResult[]): { quote: RateQuote } | { error: string } {
  const good = results.filter((r): r is RateSourceResult & { ok: true; vesPerUsd: number; valueDate: string } => r.ok && validRate(r.vesPerUsd) && !!r.valueDate);
  if (!good.length) return { error: `Ninguna fuente respondió (${results.map((r) => `${r.provider}: ${r.error ?? "sin datos"}`).join("; ")}).` };
  const newest = good.reduce((a, b) => (b.valueDate > a.valueDate ? b : a)).valueDate;
  const sameDay = good.filter((r) => r.valueDate === newest);
  if (sameDay.length > 1) {
    const [a, b] = sameDay;
    const spread = Math.abs(a.vesPerUsd - b.vesPerUsd) / Math.min(a.vesPerUsd, b.vesPerUsd);
    if (spread > RATE_MAX_SPREAD) return { error: `Las fuentes no coinciden para el ${newest}: ${a.provider} Bs. ${fmt(a.vesPerUsd)} y ${b.provider} Bs. ${fmt(b.vesPerUsd)}.` };
  }
  const chosen = sameDay.find((r) => r.provider === "DolarApi") ?? sameDay[0];
  return { quote: { provider: chosen.provider, vesPerUsd: chosen.vesPerUsd, valueDate: chosen.valueDate } };
}

/** ¿Toca consultar ahora? (lo usa el job; «Consultar ahora» del panel consulta siempre). */
export function rateSyncDue(stored: ExchangeRateSetting | null, last: RateSyncStatus | null, now: Date): boolean {
  if (!last) return true;
  const since = now.getTime() - Date.parse(last.checkedAt);
  if (!Number.isFinite(since) || since < 0) return true;
  if (!last.ok) return since >= RATE_RETRY_AFTER_FAILURE_MS;
  // Cambió el día en Caracas y la tasa guardada es de antes: puede haber una nueva con fecha valor de hoy.
  if (!stored?.valueDate || stored.valueDate < caracasToday(now)) return since >= RATE_RETRY_AFTER_FAILURE_MS;
  return since >= RATE_CHECK_EVERY_MS;
}

export interface SyncOptions {
  fetch?: FetchLike;
  /** Consultar aunque no toque o la actualización automática esté apagada (botón «Consultar ahora»). */
  force?: boolean;
}

/**
 * Consulta las fuentes y, si hay una tasa confiable con fecha valor de hoy (o la última anterior), la guarda en
 * exchangeRate.vesPerUsd. Siempre guarda el resultado en exchangeRate.sync. Si no tocaba consultar devuelve { skipped }.
 */
export async function syncExchangeRate(d: Deps, opts: SyncOptions = {}): Promise<RateSyncStatus | { skipped: string }> {
  const cfg = d.config.rateSync;
  if (!cfg?.enabled) return { skipped: "desactivada en este entorno (EXCHANGE_RATE_SYNC=off)" };
  const auto = await readSetting<ExchangeRateAutoSetting>(d.db, SETTING_KEYS.exchangeRateAuto, { enabled: true });
  if (!auto.enabled && !opts.force) return { skipped: "actualización automática apagada en Configuración" };
  const now = d.now();
  const stored = await readSetting<ExchangeRateSetting | null>(d.db, SETTING_KEYS.exchangeRate, null);
  const last = await readSetting<RateSyncStatus | null>(d.db, SETTING_KEYS.exchangeRateSync, null);
  if (!opts.force && !rateSyncDue(stored, last, now)) return { skipped: "la tasa de hoy ya está al día" };

  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const today = caracasToday(now);
  const settled = await Promise.allSettled([
    fetchDolarApi(fetchFn, cfg.dolarApiUrl, today, cfg.timeoutMs),
    fetchDolarVzla(fetchFn, cfg.dolarVzlaUrl, today, cfg.timeoutMs),
  ]);
  const providers: RateProvider[] = ["DolarApi", "DolarVZLA"];
  const sources: RateSourceResult[] = settled.map((s, i) =>
    s.status === "fulfilled" ? { provider: providers[i], ok: true, vesPerUsd: s.value.vesPerUsd, valueDate: s.value.valueDate } : { provider: providers[i], ok: false, error: String((s.reason as Error)?.message ?? s.reason) },
  );
  const checkedAt = now.toISOString();
  const pick = pickRate(sources);

  let status: RateSyncStatus;
  if ("error" in pick) {
    status = { checkedAt, ok: false, message: `${pick.error} Se mantiene la tasa anterior.`, sources };
  } else {
    const q = pick.quote;
    const prev = exchangeRateStatus(stored, now);
    const jump = prev.usable && stored ? Math.abs(q.vesPerUsd - stored.vesPerUsd) / stored.vesPerUsd : 0;
    if (jump > RATE_MAX_JUMP) {
      status = {
        checkedAt,
        ok: false,
        message: `${q.provider} informa Bs. ${fmt(q.vesPerUsd)} por USD, un cambio de ${Math.round(jump * 100)} % frente a la tasa guardada (Bs. ${fmt(stored!.vesPerUsd)}). No se aplicó: revísala y, si es correcta, escríbela a mano.`,
        sources,
      };
    } else {
      const changed = !stored || stored.vesPerUsd !== q.vesPerUsd || stored.valueDate !== q.valueDate || prev.placeholder;
      const next: ExchangeRateSetting = { vesPerUsd: q.vesPerUsd, source: `BCV · vía ${q.provider}`, updatedAt: checkedAt, valueDate: q.valueDate, auto: true };
      await withTx(d, async (tx) => {
        const before = await tx.setting.findUnique({ where: { key: SETTING_KEYS.exchangeRate } });
        await tx.setting.upsert({ where: { key: SETTING_KEYS.exchangeRate }, create: { key: SETTING_KEYS.exchangeRate, value: next as unknown as Prisma.InputJsonValue }, update: { value: next as unknown as Prisma.InputJsonValue } });
        // Auditoría solo cuando cambia la tasa (confirmarla cada hora no es un cambio).
        if (changed) await recordAudit(tx, { actor: null, action: "setting.update", entityType: "Setting", entityId: SETTING_KEYS.exchangeRate, before: before?.value ?? null, after: next, note: `Tasa BCV automática (${q.provider}, fecha valor ${q.valueDate})`, force: !before });
      });
      status = { checkedAt, ok: true, changed, applied: q, message: `Tasa BCV con fecha valor ${q.valueDate}: Bs. ${fmt(q.vesPerUsd)} por USD (vía ${q.provider}).`, sources };
    }
  }
  await d.db.setting.upsert({ where: { key: SETTING_KEYS.exchangeRateSync }, create: { key: SETTING_KEYS.exchangeRateSync, value: status as unknown as Prisma.InputJsonValue }, update: { value: status as unknown as Prisma.InputJsonValue } });
  if (!status.ok) d.log.warn(`[tasa BCV] ${status.message}`);
  return status;
}
