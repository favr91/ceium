import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { caracasToday, pickRate, syncExchangeRate, type FetchLike, type RateSyncStatus } from "@/server/exchange-rate";
import { getSettingsWarnings, updateSetting } from "@/server/admin-settings";
import { listPaymentOptions } from "@/server/orders";
import { SETTING_KEYS, type ExchangeRateSetting } from "@/server/settings";
import type { Deps } from "@/server/deps";
import type { SessionUser } from "@/server/auth";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let d: Deps;
let admin: SessionUser;
const API = "https://dolarapi.test";
const VZLA = "https://vzla.test";

beforeEach(async () => {
  ctx = await setupContext("exchange-rate");
  d = { ...ctx.d, config: { ...ctx.d.config, rateSync: { enabled: true, dolarApiUrl: API, dolarVzlaUrl: VZLA, timeoutMs: 1000 } } };
  admin = { id: ctx.fx.adminId, email: "admin@ceium.net", name: "Admin", role: "ADMIN" };
  // Martes 29 sept 2026, 11:00 en Caracas; tasa real guardada del lunes.
  ctx.clock.t = new Date("2026-09-29T15:00:00Z");
  await setRate({ vesPerUsd: 857.0058, source: "BCV", updatedAt: "2026-09-28T15:00:00Z" });
});
afterEach(async () => {
  await ctx.dispose();
});

async function setRate(v: ExchangeRateSetting) {
  await ctx.db.setting.update({ where: { key: SETTING_KEYS.exchangeRate }, data: { value: v as never } });
}
const stored = async () => (await ctx.db.setting.findUniqueOrThrow({ where: { key: SETTING_KEYS.exchangeRate } })).value as unknown as ExchangeRateSetting;
const lastSync = async () => (await ctx.db.setting.findUnique({ where: { key: SETTING_KEYS.exchangeRateSync } }))?.value as unknown as RateSyncStatus;

type Routes = Record<string, unknown | Error | number>;
/** fetch falso: cada URL devuelve JSON, un código HTTP (número) o lanza (Error). Registra las llamadas. */
function fakeFetch(routes: Routes) {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === "number") return new Response("error", { status: r });
    if (r === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}
const apiCurrent = (promedio: number, date: string) => ({ [`${API}/v1/dolares/oficial`]: { moneda: "USD", fuente: "oficial", promedio, fechaActualizacion: `${date}T00:00:00-04:00` } });
const apiHistory = (rows: [string, number][]) => ({ [`${API}/v1/historicos/dolares/oficial`]: rows.map(([fecha, promedio]) => ({ fuente: "oficial", promedio, fecha })) });
const vzla = (cur: [string, number], prev: [string, number]) => ({ [`${VZLA}/bcv/current.json`]: { current: { date: cur[0], usd: cur[1] }, previous: { date: prev[0], usd: prev[1] } } });

describe("tasa BCV automática", () => {
  it("mañana: las dos fuentes traen la de hoy y coinciden → se guarda la de DolarApi con fecha valor y auditoría", async () => {
    const f = fakeFetch({ ...apiCurrent(857.8876, "2026-09-29"), ...vzla(["2026-09-29", 857.8876], ["2026-09-28", 857.0058]) });
    const r = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(await stored()).toMatchObject({ vesPerUsd: 857.8876, valueDate: "2026-09-29", source: "BCV", provider: "DolarApi", auto: true, updatedAt: ctx.clock.now().toISOString() });
    expect((await lastSync()).ok).toBe(true);
    const audit = await ctx.db.auditLog.findMany({ where: { entityId: SETTING_KEYS.exchangeRate } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "SYSTEM", note: "Tasa BCV automática (DolarApi, fecha valor 2026-09-29)" });
  });

  it("tarde: el BCV ya publicó la de mañana → se cobra con la de hoy (histórico de DolarApi / «previous» de DolarVZLA)", async () => {
    ctx.clock.t = new Date("2026-09-29T21:00:00Z"); // 17:00 en Caracas
    const f = fakeFetch({
      ...apiCurrent(859.1, "2026-09-30"),
      ...apiHistory([["2026-09-28", 857.0058], ["2026-09-29", 857.8876], ["2026-09-30", 859.1]]),
      ...vzla(["2026-09-30", 859.1], ["2026-09-29", 857.8876]),
    });
    const r = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual({ provider: "DolarApi", vesPerUsd: 857.8876, valueDate: "2026-09-29" });
    expect(r.sources.map((s) => s.valueDate)).toEqual(["2026-09-29", "2026-09-29"]);
    expect((await stored()).vesPerUsd).toBe(857.8876);
  });

  it("fin de semana: no hay tasa con fecha de hoy → la última anterior (viernes)", async () => {
    ctx.clock.t = new Date("2026-10-03T15:00:00Z"); // sábado
    expect(caracasToday(ctx.clock.now())).toBe("2026-10-03");
    const f = fakeFetch({ ...apiCurrent(861, "2026-10-05"), ...apiHistory([["2026-10-01", 859.5], ["2026-10-02", 860.2], ["2026-10-05", 861]]), ...vzla(["2026-10-05", 861], ["2026-10-02", 860.2]) });
    const r = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(r.applied).toMatchObject({ vesPerUsd: 860.2, valueDate: "2026-10-02" });
  });

  it("DolarApi caído → se usa DolarVZLA", async () => {
    const f = fakeFetch({ [`${API}/v1/dolares/oficial`]: 503, ...vzla(["2026-09-29", 857.8876], ["2026-09-28", 857.0058]) });
    const r = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(r.ok).toBe(true);
    expect(r.applied?.provider).toBe("DolarVZLA");
    expect(await stored()).toMatchObject({ vesPerUsd: 857.8876, source: "BCV", provider: "DolarVZLA" });
    expect(r.sources[0]).toMatchObject({ provider: "DolarApi", ok: false, error: "HTTP 503" });
  });

  it("las fuentes no coinciden (> 0,5 %) → no se toca la tasa y el panel avisa", async () => {
    const f = fakeFetch({ ...apiCurrent(857.8876, "2026-09-29"), ...vzla(["2026-09-29", 880], ["2026-09-28", 857.0058]) });
    const r = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no coinciden para el 2026-09-29/);
    expect((await stored()).vesPerUsd).toBe(857.0058);
    const w = await getSettingsWarnings(d, admin);
    expect(w).toEqual(expect.arrayContaining([expect.objectContaining({ key: SETTING_KEYS.exchangeRateSync, severity: "warning", message: expect.stringMatching(/No se pudo actualizar la tasa automáticamente/) })]));
  });

  it("ninguna responde → se mantiene la tasa anterior; salto mayor al 30 % → se rechaza", async () => {
    const down = fakeFetch({ [`${API}/v1/dolares/oficial`]: new Error("getaddrinfo ENOTFOUND"), [`${VZLA}/bcv/current.json`]: 500 });
    const r1 = (await syncExchangeRate(d, { fetch: down.fn })) as RateSyncStatus;
    expect(r1.ok).toBe(false);
    expect(r1.message).toMatch(/Ninguna fuente respondió.*Se mantiene la tasa anterior/);
    expect((await stored()).vesPerUsd).toBe(857.0058);

    const wild = fakeFetch({ ...apiCurrent(8578.876, "2026-09-29"), ...vzla(["2026-09-29", 8578.876], ["2026-09-28", 857.0058]) });
    const r2 = (await syncExchangeRate(d, { fetch: wild.fn, force: true })) as RateSyncStatus;
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/cambio de 901 % .* No se aplicó/);
    expect((await stored()).vesPerUsd).toBe(857.0058);
  });

  it("con la tasa de ejemplo del seed: la primera consulta la reemplaza y pago móvil vuelve a ofrecerse", async () => {
    await setRate({ vesPerUsd: 100, source: "TODO: actualizar con la tasa oficial BCV", updatedAt: "2026-09-24T21:00:00Z" });
    expect((await listPaymentOptions(d)).map((o) => o.method)).toEqual(["PAYPAL"]);
    const f = fakeFetch({ ...apiCurrent(857.8876, "2026-09-29"), ...vzla(["2026-09-29", 857.8876], ["2026-09-28", 857.0058]) });
    const r = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(r.ok).toBe(true);
    expect((await listPaymentOptions(d)).map((o) => o.method)).toEqual(["PAYPAL", "PAGO_MOVIL", "TRANSFERENCIA"]);
  });

  it("el job no consulta de más: cada hora si está al día, tras medianoche aunque no haya pasado la hora, y el apagado se respeta", async () => {
    const f = fakeFetch({ ...apiCurrent(857.8876, "2026-09-29"), ...vzla(["2026-09-29", 857.8876], ["2026-09-28", 857.0058]) });
    await syncExchangeRate(d, { fetch: f.fn });
    const n = f.calls.length;
    ctx.clock.advance(20 * 60_000);
    expect(await syncExchangeRate(d, { fetch: f.fn })).toEqual({ skipped: "la tasa de hoy ya está al día" });
    expect(f.calls.length).toBe(n);
    // Confirmarla una hora después no crea otra auditoría (no cambió), pero sí renueva la fecha de verificación.
    ctx.clock.advance(45 * 60_000);
    const again = (await syncExchangeRate(d, { fetch: f.fn })) as RateSyncStatus;
    expect(again).toMatchObject({ ok: true, changed: false });
    expect((await stored()).updatedAt).toBe(ctx.clock.now().toISOString());
    expect(await ctx.db.auditLog.count({ where: { entityId: SETTING_KEYS.exchangeRate } })).toBe(1);

    // 00:15 del miércoles en Caracas: la tasa guardada es de ayer → consulta aunque no haya pasado la hora.
    ctx.clock.t = new Date("2026-09-30T04:15:00Z");
    const before = f.calls.length;
    await syncExchangeRate(d, { fetch: f.fn });
    expect(f.calls.length).toBeGreaterThan(before);

    // Apagada en Configuración: el job no consulta; «Consultar ahora» (force) sí.
    await updateSetting(d, admin, SETTING_KEYS.exchangeRateAuto, { enabled: false });
    ctx.clock.advance(3 * 3_600_000);
    expect(await syncExchangeRate(d, { fetch: f.fn })).toEqual({ skipped: "actualización automática apagada en Configuración" });
    expect(await syncExchangeRate(d, { fetch: f.fn, force: true })).toMatchObject({ ok: true });
    // Sin configuración (entorno de pruebas / EXCHANGE_RATE_SYNC=off) nunca consulta.
    expect(await syncExchangeRate(ctx.d, { fetch: f.fn, force: true })).toMatchObject({ skipped: expect.stringMatching(/EXCHANGE_RATE_SYNC=off/) });
  });

  it("pickRate: fechas distintas → la más reciente; misma fecha dentro del margen → DolarApi", () => {
    expect(pickRate([{ provider: "DolarApi", ok: true, vesPerUsd: 857, valueDate: "2026-09-28" }, { provider: "DolarVZLA", ok: true, vesPerUsd: 858, valueDate: "2026-09-29" }])).toEqual({ quote: { provider: "DolarVZLA", vesPerUsd: 858, valueDate: "2026-09-29" } });
    expect(pickRate([{ provider: "DolarVZLA", ok: true, vesPerUsd: 858.1, valueDate: "2026-09-29" }, { provider: "DolarApi", ok: true, vesPerUsd: 858, valueDate: "2026-09-29" }])).toEqual({ quote: { provider: "DolarApi", vesPerUsd: 858, valueDate: "2026-09-29" } });
  });
});
