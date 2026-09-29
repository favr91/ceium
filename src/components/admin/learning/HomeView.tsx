"use client";
// Inicio del panel (réplica del Home de Shopify): saludo, periodo, tarjeta de métricas con pestañas y gráfica del
// periodo contra el anterior (con tooltip al pasar el cursor), pendientes como botones-píldora, avance por
// diplomado (distribución de médicos por cursos completados) y actividad reciente de Moodle/certificados/pagos.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HomeDashboard } from "@/server/admin-learning";
import { Icon } from "../Icon";
import { usd, listDate } from "../orders/format";
import { Avatar, Bar } from "./shared";

type MetricKey = keyof HomeDashboard["metrics"];
const METRICS: { key: MetricKey; label: string; money?: boolean; hint: string }[] = [
  { key: "collected", label: "Cobrado", money: true, hint: "Pagos confirmados (PayPal y manuales verificados) en USD." },
  { key: "orders", label: "Pedidos", hint: "Pedidos realizados en la tienda (sin vencidos ni cancelados)." },
  { key: "enrollments", label: "Matrículas en Moodle", hint: "Cursos habilitados en Moodle en el periodo." },
  { key: "completions", label: "Cursos completados", hint: "Cursos que Moodle reporta completados en el periodo." },
  { key: "certificates", label: "Certificados", hint: "Certificados de diplomado emitidos en el periodo." },
];

const F_DAY = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", timeZone: "America/Caracas" });
const fmtVal = (v: number, money?: boolean) => (money ? usd(v) : v.toLocaleString("es-VE"));

function greeting(now: Date) {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Caracas" }).format(now));
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0) return <span className="hm-delta none">{cur === 0 ? "—" : "Nuevo"}</span>;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return <span className="hm-delta none">0%</span>;
  return (
    <span className={`hm-delta ${pct > 0 ? "up" : "down"}`} aria-label={`${pct > 0 ? "Sube" : "Baja"} ${Math.abs(pct)}% contra el periodo anterior`}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d={pct > 0 ? "M3 9 9 3M4.5 3H9v4.5" : "M3 3l6 6M9 4.5V9H4.5"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {Math.abs(pct)}%
    </span>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

function Chart({ series, prev, labels, money, name }: { series: number[]; prev: number[]; labels: string[]; money?: boolean; name: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 232;
  const padL = money ? 56 : 36;
  const padR = 8;
  const padT = 12;
  const padB = 28;
  const max = niceMax(Math.max(...series, ...prev));
  const n = series.length;
  const x = (i: number) => padL + (n > 1 ? (i * (w - padL - padR)) / (n - 1) : 0);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => k * max);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((w - padL) / 90))));
  const tickLabel = (v: number) => (money ? (v >= 100_000 ? `$${Math.round(v / 100_000)}k` : `$${Math.round(v / 100)}`) : Number.isInteger(v) ? String(v) : v.toFixed(1));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - padL) / (w - padL - padR)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  return (
    <div className="hm-chart" ref={wrap}>
      <svg width={w} height={H} role="img" aria-label={`Gráfica de ${name} por día`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} data-testid="home-chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} className="grid" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="ax">{tickLabel(t)}</text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % every === 0 ? (
            <text key={l} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : "middle"} className="ax">{F_DAY.format(new Date(l))}</text>
          ) : null,
        )}
        <path d={path(prev)} className="prev" />
        <path d={`${path(series)} L${x(n - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} className="area" />
        <path d={path(series)} className="cur" />
        {hover != null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} className="cursor" />
            <circle cx={x(hover)} cy={y(series[hover])} r="4" className="dot" />
          </g>
        ) : null}
      </svg>
      {hover != null ? (
        <div className="hm-tip" style={{ left: Math.min(Math.max(x(hover) - 90, 0), w - 180) }} role="status">
          <div className="d">{F_DAY.format(new Date(labels[hover]))}</div>
          <div className="r"><i className="hm-key cur" />{fmtVal(series[hover], money)}</div>
          <div className="r muted"><i className="hm-key prev" />{fmtVal(prev[hover], money)} <small>periodo anterior</small></div>
        </div>
      ) : null}
    </div>
  );
}

const EVENT_TEXT: Record<string, { icon: string; text: (n: string) => string; tone?: string }> = {
  ENROLLMENT: { icon: "enroll", text: (n) => `${n} quedó matriculado en Moodle` },
  ENROLLMENT_FAILED: { icon: "alert", text: (n) => `Falló la matrícula de ${n} en Moodle`, tone: "critical" },
  UNENROLLMENT: { icon: "enroll", text: (n) => `${n} fue desmatriculado en Moodle` },
  CERTIFICATE_ISSUED: { icon: "certificate", text: (n) => `Certificado emitido a ${n}`, tone: "success" },
  CERTIFICATE_REVOKED: { icon: "certificate", text: (n) => `Se revocó el certificado de ${n}`, tone: "critical" },
  PAYMENT_VERIFIED: { icon: "check", text: (n) => `Pago de ${n} aprobado` },
  PAYMENT_CAPTURED: { icon: "check", text: (n) => `${n} pagó con PayPal` },
};

export function HomeView({ data, userName }: { data: HomeDashboard; userName: string }) {
  const [metric, setMetric] = useState<MetricKey>("collected");
  const now = useMemo(() => new Date(data.now), [data.now]);
  const m = METRICS.find((x) => x.key === metric)!;
  const t = data.todo;
  const todos = [
    t.awaiting.count && { href: "/admin/orders?view=AWAITING_VERIFICATION", icon: "order", tone: "hot", text: `${t.awaiting.count} ${t.awaiting.count === 1 ? "pago por verificar" : "pagos por verificar"}`, sub: usd(t.awaiting.cents) },
    t.failedEnrollments && { href: "/admin/enrollments?view=FAILED", icon: "alert", tone: "crit", text: `${t.failedEnrollments} ${t.failedEnrollments === 1 ? "matrícula con error en Moodle" : "matrículas con error en Moodle"}` },
    t.pendingEnrollments && { href: "/admin/enrollments?view=PENDING", icon: "enroll", text: `${t.pendingEnrollments} ${t.pendingEnrollments === 1 ? "matrícula pendiente" : "matrículas pendientes"}` },
    t.overdue.count && { href: "/admin/orders?view=BALANCE", icon: "cohort", tone: "hot", text: `${t.overdue.count} ${t.overdue.count === 1 ? "cuota vencida" : "cuotas vencidas"}`, sub: usd(t.overdue.cents) },
    t.underpaid && { href: "/admin/orders?view=PENDING_PAYMENT", icon: "order", text: `${t.underpaid} ${t.underpaid === 1 ? "pedido con pago insuficiente" : "pedidos con pago insuficiente"}` },
    t.blockedCertificates && { href: "/admin/certificates?view=BLOCKED", icon: "certificate", tone: "hot", text: `${t.blockedCertificates} ${t.blockedCertificates === 1 ? "certificado bloqueado por saldo" : "certificados bloqueados por saldo"}` },
    t.undeliveredCertificates && { href: "/admin/certificates", icon: "certificate", tone: "crit", text: `${t.undeliveredCertificates} ${t.undeliveredCertificates === 1 ? "certificado sin entregar" : "certificados sin entregar"}` },
    t.nearlyDone && { href: "/admin/certificates?view=IN_PROGRESS", icon: "star", text: `${t.nearlyDone} ${t.nearlyDone === 1 ? "médico a un curso del certificado" : "médicos a un curso del certificado"}` },
  ].filter(Boolean) as { href: string; icon: string; tone?: string; text: string; sub?: string }[];

  return (
    <div className="adm-page hm">
      <div className="hm-top">
        <div className="hm-range" role="group" aria-label="Periodo">
          {([7, 30, 90] as const).map((d) => (
            <Link key={d} href={d === 30 ? "/admin" : `/admin?dias=${d}`} className={`btn${data.days === d ? " on" : ""}`} aria-pressed={data.days === d} scroll={false}>
              {d === 7 ? "7 días" : d === 30 ? "30 días" : "90 días"}
            </Link>
          ))}
        </div>
        <span className="hm-cmp">Comparado con los {data.days} días anteriores</span>
      </div>

      <h1 className="hm-hello">
        {greeting(now)}, {userName.split(/\s+/)[0]}
      </h1>

      <section className="card card-flush hm-metrics" aria-label="Métricas del periodo">
        <div className="hm-tabs" role="tablist">
          {METRICS.map((x) => {
            const v = data.metrics[x.key];
            return (
              <button key={x.key} type="button" role="tab" aria-selected={metric === x.key} className={`hm-tab${metric === x.key ? " on" : ""}`} onClick={() => setMetric(x.key)} data-testid={`metric-${x.key}`} title={x.hint}>
                <span className="l">{x.label}</span>
                <span className="v">
                  <span className="n">{fmtVal(v.total, x.money)}</span>
                  <Delta cur={v.total} prev={v.prevTotal} />
                </span>
              </button>
            );
          })}
        </div>
        <Chart series={data.metrics[metric].series} prev={data.metrics[metric].prevSeries} labels={data.labels} money={m.money} name={m.label} />
        <div className="hm-legend">
          <span><i className="hm-key cur" /> Últimos {data.days} días</span>
          <span><i className="hm-key prev" /> Periodo anterior</span>
        </div>
      </section>

      <section className="hm-todo" aria-label="Pendientes">
        {todos.length ? (
          todos.map((x) => (
            <Link key={x.href + x.text} href={x.href} className={`hm-pill${x.tone ? ` ${x.tone}` : ""}`}>
              <Icon name={x.icon} size={16} />
              <b>{x.text}</b>
              {x.sub ? <span className="s">{x.sub}</span> : null}
              <Icon name="chevronRight" size={16} className="chev" />
            </Link>
          ))
        ) : (
          <div className="hm-pill ok" role="status">
            <Icon name="check" size={16} />
            <b>Todo al día</b>
            <span className="s">No hay pagos por verificar ni matrículas con error.</span>
          </div>
        )}
      </section>

      <div className="hm-grid">
        <section className="card card-flush" aria-labelledby="h-prog">
          <div className="hm-card-h">
            <h2 id="h-prog">Avance por diplomado</h2>
            <Link href="/admin/certificates?view=IN_PROGRESS" className="btn btn-plain">Ver avance</Link>
          </div>
          {data.programs.length === 0 ? <p className="muted hm-pad">Aún no hay diplomados en el catálogo.</p> : null}
          <ul className="hm-progs">
            {data.programs.map((p) => {
              const peak = Math.max(1, ...p.buckets);
              return (
                <li key={p.id} data-testid="home-program">
                  <div className="hd">
                    <span className="thumb" style={{ width: 40, height: 40 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN del catálogo */}
                      {p.image ? <img src={p.image} alt="" /> : <Icon name="product" />}
                    </span>
                    <div className="tt">
                      <Link href={`/admin/enrollments?program=${p.id}`} className="t">{p.title}</Link>
                      <span className="s">
                        {p.students} {p.students === 1 ? "médico cursando" : "médicos cursando"} · {p.issued} {p.issued === 1 ? "certificado" : "certificados"}
                      </span>
                    </div>
                    <span className="pct">{Math.round(p.rate * 100)}%</span>
                  </div>
                  <Bar value={p.completedCourses} max={p.totalCourses} tone="success" label={`Cursos completados de ${p.title}`} />
                  {p.courses > 0 && p.students > 0 ? (
                    <div className="hist" aria-label={`Médicos por cursos completados en ${p.title}`}>
                      {p.buckets.map((b, k) => (
                        <span key={k} className="col" title={`${b} ${b === 1 ? "médico" : "médicos"} con ${k} de ${p.courses} cursos`}>
                          <span className="bar" style={{ height: `${(b / peak) * 100}%` }} data-empty={b === 0 || undefined} />
                          <span className="kl">{k}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card card-flush" aria-labelledby="h-act">
          <div className="hm-card-h">
            <h2 id="h-act">Actividad reciente</h2>
            <Link href="/admin/enrollments" className="btn btn-plain">Ver matrículas</Link>
          </div>
          {data.recent.length === 0 ? <p className="muted hm-pad">Sin actividad todavía.</p> : null}
          <ul className="hm-feed">
            {data.recent.map((e) => {
              const k = EVENT_TEXT[e.type] ?? { icon: "info", text: (n: string) => n };
              return (
                <li key={e.id}>
                  <Avatar name={e.customer.name} />
                  <div className="b">
                    <Link href={`/admin/customers/${e.customer.id}`} className={`t${k.tone ? ` ${k.tone}` : ""}`}>{k.text(e.customer.name)}</Link>
                    <span className="s">
                      <Link href={`/admin/orders/${e.order.id}`}>#{e.order.number}</Link> · {listDate(e.createdAt, now)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
