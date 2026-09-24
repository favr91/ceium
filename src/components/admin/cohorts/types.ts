// Tipos y etiquetas compartidos por Cohortes y Sedes del panel (sin dependencias de servidor).
export type CohortStatus = "DRAFT" | "OPEN" | "CLOSED" | "IN_PROGRESS" | "FINISHED" | "CANCELLED";
export const COHORT_STATUSES: CohortStatus[] = ["DRAFT", "OPEN", "CLOSED", "IN_PROGRESS", "FINISHED", "CANCELLED"];

export const STATUS_LABEL: Record<CohortStatus, string> = {
  DRAFT: "Borrador",
  OPEN: "Inscripciones abiertas",
  CLOSED: "Inscripciones cerradas",
  IN_PROGRESS: "En curso",
  FINISHED: "Finalizada",
  CANCELLED: "Cancelada",
};
export const STATUS_SHORT: Record<CohortStatus, string> = {
  DRAFT: "Borrador",
  OPEN: "Abierta",
  CLOSED: "Cerrada",
  IN_PROGRESS: "En curso",
  FINISHED: "Finalizada",
  CANCELLED: "Cancelada",
};
export const STATUS_HELP: Record<CohortStatus, string> = {
  DRAFT: "No se muestra en la tienda. Úsalo mientras preparas fechas y cupo.",
  OPEN: "Se muestra en la tienda y se puede comprar mientras haya cupos libres.",
  CLOSED: "Visible para los inscritos, pero ya no se vende.",
  IN_PROGRESS: "Las clases comenzaron. No se vende.",
  FINISHED: "Terminó. Queda como historial.",
  CANCELLED: "No se dicta. Solo se puede cancelar sin cupos ocupados.",
};
export const STATUS_TONE: Record<CohortStatus, "success" | "info" | "attention" | "critical" | "neutral"> = {
  DRAFT: "info",
  OPEN: "success",
  CLOSED: "neutral",
  IN_PROGRESS: "attention",
  FINISHED: "neutral",
  CANCELLED: "critical",
};

/** Cupos de una cohorte, como los cuenta seats.ts (reservas vivas; las vencidas sin liberar aparte). */
export interface Seats {
  capacity: number;
  confirmed: number;
  held: number;
  /** Reservas vencidas que el barrido aún no liberó (ya no cuentan: se liberan al reservar). */
  stale: number;
  free: number;
}

export type Fill = "full" | "low" | "ok" | "empty";
/** Semáforo de ocupación: lleno, últimos cupos (≤ 20 % o ≤ 3 libres), con cupo, sin ventas. */
export function fillOf(s: Seats): Fill {
  if (s.capacity > 0 && s.free === 0) return "full";
  if (s.capacity > 0 && (s.free <= 3 || s.free / s.capacity <= 0.2)) return "low";
  if (s.confirmed + s.held === 0) return "empty";
  return "ok";
}

export interface CohortRow {
  id: string;
  name: string;
  productId: string;
  productTitle: string;
  productType: "COURSE" | "DIPLOMA";
  image: string | null;
  sedeId: string;
  sedeName: string;
  startDate: string; // AAAA-MM-DD (día de Venezuela)
  endDate: string;
  enrollmentDeadline: string | null;
  status: CohortStatus;
  isSample: boolean;
  sessions: number;
  seats: Seats;
}

export type View = "ALL" | "OPEN" | "LOW" | "FULL" | "IN_PROGRESS" | "DRAFT" | "ENDED";
export const VIEWS: { key: View; label: string }[] = [
  { key: "ALL", label: "Todas" },
  { key: "OPEN", label: "Abiertas" },
  { key: "LOW", label: "Últimos cupos" },
  { key: "FULL", label: "Llenas" },
  { key: "IN_PROGRESS", label: "En curso" },
  { key: "DRAFT", label: "Borradores" },
  { key: "ENDED", label: "Cerradas y finalizadas" },
];

export function inView(r: CohortRow, v: View): boolean {
  switch (v) {
    case "ALL": return true;
    case "OPEN": return r.status === "OPEN";
    case "LOW": return r.status === "OPEN" && fillOf(r.seats) === "low";
    case "FULL": return (r.status === "OPEN" || r.status === "CLOSED") && fillOf(r.seats) === "full";
    case "IN_PROGRESS": return r.status === "IN_PROGRESS";
    case "DRAFT": return r.status === "DRAFT";
    case "ENDED": return r.status === "CLOSED" || r.status === "FINISHED" || r.status === "CANCELLED";
  }
}

export interface SessionItem { date: string; title: string; startTime: string; endTime: string; courseSlug: string }

export interface CohortForm {
  id: string | null;
  productId: string;
  sedeId: string;
  name: string;
  startDate: string;
  endDate: string;
  enrollmentDeadline: string;
  capacity: string;
  status: CohortStatus;
  sessions: SessionItem[];
  notes: string;
  scheduleUrl: string;
}

export interface ReservationRow {
  id: string;
  status: "HELD" | "CONFIRMED" | "RELEASED";
  live: boolean; // HELD que todavía cuenta
  orderId: string;
  orderNumber: number;
  orderStatus: string;
  customer: string;
  email: string;
  plan: string | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  releasedAt: string | null;
  releasedReason: string | null;
}

export interface ProgramOption {
  id: string;
  title: string;
  type: "COURSE" | "DIPLOMA";
  courses: { title: string; slug: string }[];
  /** Precio semipresencial por sede (centavos), para mostrar junto a la cohorte. */
  prices: Record<string, number>;
  slug: string;
  published: boolean;
}
export interface SedeOption { id: string; name: string; slug: string; active: boolean; address: string | null }

export interface CohortContext {
  programs: ProgramOption[];
  sedes: SedeOption[];
  seats: Seats | null;
  purchasable: { ok: boolean; reason: string } | null;
  reservations: ReservationRow[];
  audit: { id: string; action: string; when: string; who: string | null; note: string | null; fields: string[] }[];
  hasSales: boolean;
  isSample: boolean;
  prevId: string | null;
  nextId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Pago pendiente",
  AWAITING_VERIFICATION: "En verificación",
  PARTIALLY_PAID: "Pago parcial",
  PAID: "Pagado",
  ENROLLED: "Matriculado",
  REJECTED: "Rechazado",
  CANCELLED: "Cancelado",
  EXPIRED: "Vencido",
  REFUNDED: "Reembolsado",
};
export const RELEASE_LABEL: Record<string, string> = {
  EXPIRED: "venció",
  REJECTED: "pago rechazado",
  REFUNDED: "reembolsado",
  CANCELLED: "pedido cancelado",
  REASSIGNED: "reasignado a otra cohorte",
};

/** Fecha AAAA-MM-DD → texto corto en español («14 mar 2026»). */
export function fmtDay(iso: string | null, opts: { year?: boolean } = {}): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
  return `${d} ${MONTHS[m - 1]}${opts.year === false ? "" : ` ${y}`}`;
}

export function fmtRange(a: string, b: string): string {
  if (a === b) return fmtDay(a);
  const [ya] = a.split("-");
  const [yb] = b.split("-");
  return ya === yb ? `${fmtDay(a, { year: false })} – ${fmtDay(b)}` : `${fmtDay(a)} – ${fmtDay(b)}`;
}

/** Días entre hoy (Venezuela) y una fecha AAAA-MM-DD. */
export function daysFrom(today: string, iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function relDays(today: string, start: string, end: string): string {
  const s = daysFrom(today, start);
  const e = daysFrom(today, end);
  if (s > 1) return `Empieza en ${s} días`;
  if (s === 1) return "Empieza mañana";
  if (s === 0) return "Empieza hoy";
  if (e >= 0) return "En curso";
  return `Terminó hace ${-e} ${-e === 1 ? "día" : "días"}`;
}
