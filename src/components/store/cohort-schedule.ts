// Cronograma en vivo de una cohorte (reemplaza los PDF «Cronograma Cohorte …» de ceium.net). Solo servidor.
// Una «cohorte» para el alumno es un nombre (p. ej. «Cohorte I - 2026») que el panel abre en una o varias sedes;
// la ficha /cronograma/<producto>/<cohorte> reúne esas filas: fechas, clases, cierre de inscripción y cupos
// libres contados en vivo (confirmados + reservas vivas, igual que el checkout).
import type { CohortStatus } from "@/server/db";
import { prisma } from "@/server/db";
import { liveHeldCounts } from "@/server/seats";

/** Estados que la tienda muestra (la home solo lista las vigentes; la ficha también abre las finalizadas). */
export const LISTED_COHORT_STATUSES = ["OPEN", "CLOSED", "IN_PROGRESS"] as const satisfies readonly CohortStatus[];
const PUBLIC_COHORT_STATUSES: CohortStatus[] = [...LISTED_COHORT_STATUSES, "FINISHED"];

const TZ = "America/Caracas";

/** «Cohorte I - 2026» → «cohorte-i-2026» (segmento de URL estable por nombre de cohorte). */
export function cohortKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** «Cohorte I - 2026» → «Cohorte I 2026» (como lo rotula ceium.net). */
export function cohortLabel(name: string): string {
  return name.replace(/\s*[-–]\s*/g, " ").replace(/\s+/g, " ").trim();
}

export function cohortScheduleHref(productSlug: string, cohortName: string): string {
  return `/cronograma/${productSlug}/${cohortKey(cohortName)}`;
}

export type CohortPhase = "OPEN" | "SOLD_OUT" | "CLOSED" | "IN_PROGRESS" | "FINISHED";

export const PHASE_LABEL: Record<CohortPhase, string> = {
  OPEN: "Inscripciones abiertas",
  SOLD_OUT: "Cupos agotados",
  CLOSED: "Inscripciones cerradas",
  IN_PROGRESS: "En curso",
  FINISHED: "Finalizada",
};

export interface ScheduleSession {
  date: string; // AAAA-MM-DD
  title: string;
  startTime?: string;
  endTime?: string;
  /** Ficha del curso en la tienda, si existe y está publicada. */
  href: string | null;
}

export interface SedeSchedule {
  id: string;
  sede: { name: string; city: string | null; address: string | null; mapUrl: string | null };
  startDate: Date;
  endDate: Date;
  enrollmentDeadline: Date | null;
  phase: CohortPhase;
  capacity: number;
  available: number;
  sessions: ScheduleSession[];
  scheduleUrl: string | null;
  isSample: boolean;
}

export interface CohortSchedule {
  product: { slug: string; title: string; image: string | null };
  name: string;
  label: string;
  sedes: SedeSchedule[];
  /** Las clases son las mismas en todas las sedes → una sola tabla. */
  sharedSessions: ScheduleSession[] | null;
  /** Otras cohortes del mismo programa (para saltar entre cronogramas). */
  others: { label: string; href: string }[];
}

type RawSession = { date?: unknown; title?: unknown; startTime?: unknown; endTime?: unknown; courseSlug?: unknown };

function parseSessions(raw: unknown): (Omit<ScheduleSession, "href"> & { courseSlug: string | null })[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawSession[])
    .filter((s) => s && typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date))
    .map((s) => ({
      date: s.date as string,
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : "Clase",
      startTime: typeof s.startTime === "string" && s.startTime ? s.startTime : undefined,
      endTime: typeof s.endTime === "string" && s.endTime ? s.endTime : undefined,
      courseSlug: typeof s.courseSlug === "string" && s.courseSlug ? s.courseSlug : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function phaseOf(c: { status: CohortStatus; enrollmentDeadline: Date | null }, available: number, now: Date): CohortPhase {
  if (c.status === "IN_PROGRESS") return "IN_PROGRESS";
  if (c.status === "FINISHED") return "FINISHED";
  if (c.status !== "OPEN") return "CLOSED";
  if (c.enrollmentDeadline && c.enrollmentDeadline.getTime() < now.getTime()) return "CLOSED";
  return available > 0 ? "OPEN" : "SOLD_OUT";
}

export async function getCohortSchedule(productSlug: string, key: string, now: Date = new Date()): Promise<CohortSchedule | null> {
  const product = await prisma.product.findFirst({
    where: { slug: productSlug, published: true },
    select: {
      id: true,
      slug: true,
      title: true,
      images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
      cohorts: {
        where: { status: { in: PUBLIC_COHORT_STATUSES } },
        orderBy: [{ startDate: "asc" }, { sede: { position: "asc" } }],
        select: {
          id: true,
          name: true,
          status: true,
          startDate: true,
          endDate: true,
          enrollmentDeadline: true,
          capacity: true,
          seatsConfirmed: true,
          sessions: true,
          scheduleUrl: true,
          isSample: true,
          sede: { select: { name: true, city: true, address: true, mapUrl: true, position: true, active: true } },
        },
      },
    },
  });
  if (!product) return null;
  const rows = product.cohorts.filter((c) => cohortKey(c.name) === key && c.sede.active);
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.sede.position - b.sede.position || a.startDate.getTime() - b.startDate.getTime());

  const held = await liveHeldCounts({ db: prisma, now: () => now }, rows.map((r) => r.id));
  const parsed = rows.map((r) => ({ r, sessions: parseSessions(r.sessions) }));
  const courseSlugs = [...new Set(parsed.flatMap((p) => p.sessions.map((s) => s.courseSlug).filter((s): s is string => !!s)))];
  const published = new Set(
    courseSlugs.length
      ? (await prisma.product.findMany({ where: { slug: { in: courseSlugs }, published: true }, select: { slug: true } })).map((p) => p.slug)
      : [],
  );
  const withHref = (s: (typeof parsed)[number]["sessions"][number]): ScheduleSession => ({
    date: s.date,
    title: s.title,
    startTime: s.startTime,
    endTime: s.endTime,
    href: s.courseSlug && published.has(s.courseSlug) ? `/products/${s.courseSlug}` : null,
  });

  const sedes: SedeSchedule[] = parsed.map(({ r, sessions }) => {
    const available = Math.max(0, r.capacity - r.seatsConfirmed - (held.get(r.id) ?? 0));
    return {
      id: r.id,
      sede: { name: r.sede.name, city: r.sede.city, address: r.sede.address, mapUrl: r.sede.mapUrl },
      startDate: r.startDate,
      endDate: r.endDate,
      enrollmentDeadline: r.enrollmentDeadline,
      phase: phaseOf(r, available, now),
      capacity: r.capacity,
      available,
      sessions: sessions.map(withHref),
      scheduleUrl: r.scheduleUrl,
      isSample: r.isSample,
    };
  });

  const sig = (s: ScheduleSession[]) => JSON.stringify(s.map((x) => [x.date, x.title, x.startTime, x.endTime]));
  const sharedSessions = sedes.length > 0 && sedes.every((s) => sig(s.sessions) === sig(sedes[0].sessions)) ? sedes[0].sessions : null;

  const seen = new Set<string>([key]);
  const others = product.cohorts
    .filter((c) => c.status !== "FINISHED" && c.sede.active && !seen.has(cohortKey(c.name)) && seen.add(cohortKey(c.name)))
    .map((c) => ({ label: `Cronograma ${cohortLabel(c.name)}`, href: cohortScheduleHref(product.slug, c.name) }));

  return {
    product: { slug: product.slug, title: product.title, image: product.images[0]?.url ?? null },
    name: rows[0].name,
    label: cohortLabel(rows[0].name),
    sedes,
    sharedSessions,
    others,
  };
}

// ───── formato de fechas (hora de Venezuela) ─────
const dayFmt = new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const shortFmt = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
const weekdayFmt = new Intl.DateTimeFormat("es-VE", { weekday: "short", timeZone: TZ });
const dayMonthFmt = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "long", timeZone: TZ });

/** Fecha guardada como 00:00 de Venezuela, o «AAAA-MM-DD» de una sesión. */
function toDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(`${d}T12:00:00-04:00`) : d;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const formatLongDate = (d: Date | string) => cap(dayFmt.format(toDate(d)));
export const formatShortDate = (d: Date | string) => shortFmt.format(toDate(d)).replace(/\./g, "");
export const formatWeekday = (d: Date | string) => cap(weekdayFmt.format(toDate(d)).replace(/\./g, ""));
export const formatDayMonth = (d: Date | string) => dayMonthFmt.format(toDate(d));
export const sessionYear = (d: string) => d.slice(0, 4);
