// Cronograma en vivo de una cohorte (/cronograma/<producto>/<cohorte>): reemplaza los PDF «Cronograma Cohorte …»
// que enlazaba la home de ceium.net. Sedes, fechas, cierre de inscripción, cupos libres en vivo y calendario de
// clases, todo desde la BD (cohortes del panel).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import {
  formatDayMonth,
  formatLongDate,
  formatShortDate,
  formatWeekday,
  getCohortSchedule,
  PHASE_LABEL,
  type ScheduleSession,
  type SedeSchedule,
} from "@/components/store/cohort-schedule";
import { IconArrow } from "@/components/store/icons";
import "../../../home.css";
import "./cronograma.css";

type Props = { params: Promise<{ producto: string; cohorte: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { producto, cohorte } = await params;
  const data = await getCohortSchedule(producto, cohorte);
  return { title: data ? `Cronograma ${data.label} · ${data.product.title}` : "Cronograma" };
}

function SessionsTable({ sessions, caption }: { sessions: ScheduleSession[]; caption: string }) {
  return (
    <ol className="cron-sessions list-unstyled" aria-label={caption}>
      {sessions.map((s, i) => (
        <li key={`${s.date}-${i}`} className="cron-session">
          <span className="cron-session__n" aria-hidden="true">
            {i + 1}
          </span>
          <time className="cron-session__date" dateTime={s.date}>
            <span className="cron-session__wd">{formatWeekday(s.date)}</span>
            <span className="cron-session__day">{formatDayMonth(s.date)}</span>
            <span className="cron-session__yr">{s.date.slice(0, 4)}</span>
          </time>
          <span className="cron-session__title">
            {s.href ? <Link href={s.href}>{s.title}</Link> : s.title}
            {s.startTime ? (
              <span className="cron-session__time">
                {s.startTime}
                {s.endTime ? `–${s.endTime}` : ""}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function SedeCard({ s, productSlug }: { s: SedeSchedule; productSlug: string }) {
  const taken = s.capacity - s.available;
  const pct = s.capacity > 0 ? Math.min(100, Math.round((taken / s.capacity) * 100)) : 100;
  return (
    <li className="cron-sede" data-phase={s.phase}>
      <div className="cron-sede__head">
        <h3 className="cron-sede__name">{s.sede.name}</h3>
        <span className={`cron-chip cron-chip--${s.phase.toLowerCase()}`}>{PHASE_LABEL[s.phase]}</span>
      </div>
      {s.sede.address ? <p className="cron-sede__address">{s.sede.address}</p> : null}
      <dl className="cron-sede__facts">
        <div>
          <dt>Inicio</dt>
          <dd>{formatShortDate(s.startDate)}</dd>
        </div>
        <div>
          <dt>Fin</dt>
          <dd>{formatShortDate(s.endDate)}</dd>
        </div>
        {s.enrollmentDeadline ? (
          <div>
            <dt>Inscripción hasta</dt>
            <dd>{formatShortDate(s.enrollmentDeadline)}</dd>
          </div>
        ) : null}
      </dl>
      {s.phase === "OPEN" || s.phase === "SOLD_OUT" ? (
        <div className="cron-seats">
          <p className="cron-seats__label">
            <strong data-testid="cupos">{s.available}</strong> {s.available === 1 ? "cupo disponible" : "cupos disponibles"}
            <span> de {s.capacity}</span>
          </p>
          <div className="cron-seats__bar" role="progressbar" aria-label={`Cupos ocupados en ${s.sede.name}`} aria-valuemin={0} aria-valuemax={s.capacity} aria-valuenow={taken}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}
      {s.phase === "OPEN" ? (
        <Link href={`/products/${productSlug}`} className="home-btn cron-sede__btn" aria-label={`Inscríbete en ${s.sede.name}`}>
          Inscríbete
        </Link>
      ) : null}
      {s.scheduleUrl ? (
        <a className="cron-sede__pdf" href={s.scheduleUrl} target="_blank" rel="noopener noreferrer">
          Cronograma en PDF
        </a>
      ) : null}
    </li>
  );
}

export default async function CohortSchedulePage({ params }: Props) {
  await connection(); // cupos en vivo
  const { producto, cohorte } = await params;
  const data = await getCohortSchedule(producto, decodeURIComponent(cohorte));
  if (!data) notFound();
  const { product, sedes, sharedSessions } = data;
  const sample = sedes.some((s) => s.isSample);
  const first = sedes.reduce((a, b) => (a.startDate <= b.startDate ? a : b));

  return (
    <div className="cron">
      <div className="home-container">
        <nav className="cron-crumbs" aria-label="Ruta">
          <Link href="/">Inicio</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/products/${product.slug}`}>{product.title}</Link>
        </nav>

        <header className="cron-hero">
          <p className="cron-hero__eyebrow">Semipresencial · {sedes.length === 1 ? "1 sede" : `${sedes.length} sedes`}</p>
          <h1 className="cron-hero__title">Cronograma {data.label}</h1>
          <p className="cron-hero__product">{product.title}</p>
          <p className="cron-hero__lead">
            Comienza el {formatLongDate(first.startDate).replace(/^./, (c) => c.toLowerCase())}. Fechas, clases y cupos actualizados en tiempo real.
          </p>
          {sample ? (
            <p className="cron-note" role="note">
              Cronograma provisional: las fechas pueden ajustarse antes del inicio.
            </p>
          ) : null}
        </header>

        <section className="cron-block" aria-labelledby="cron-sedes-title">
          <h2 id="cron-sedes-title" className="cron-h2">
            Sedes y cupos
          </h2>
          <ul className="cron-sedes list-unstyled">
            {sedes.map((s) => (
              <SedeCard key={s.id} s={s} productSlug={product.slug} />
            ))}
          </ul>
        </section>

        <section className="cron-block" aria-labelledby="cron-clases-title">
          <h2 id="cron-clases-title" className="cron-h2">
            Calendario de clases
          </h2>
          {sharedSessions ? (
            sharedSessions.length ? (
              <SessionsTable sessions={sharedSessions} caption={`Clases de la ${data.label}`} />
            ) : (
              <p className="cron-empty">Las fechas de cada clase se publicarán pronto.</p>
            )
          ) : (
            sedes.map((s) => (
              <div key={s.id} className="cron-sede-sessions">
                <h3 className="cron-h3">{s.sede.name}</h3>
                {s.sessions.length ? (
                  <SessionsTable sessions={s.sessions} caption={`Clases en ${s.sede.name}`} />
                ) : (
                  <p className="cron-empty">Las fechas de cada clase se publicarán pronto.</p>
                )}
              </div>
            ))
          )}
        </section>

        {data.others.length ? (
          <nav className="cron-others" aria-label="Otras cohortes">
            {data.others.map((o) => (
              <Link key={o.href} href={o.href} className="cron-others__link">
                {o.label}
                <IconArrow width={14} height={10} />
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
