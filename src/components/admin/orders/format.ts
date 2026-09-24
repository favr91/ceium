// Pedidos del panel: etiquetas, tonos de badge (Polaris), dinero/fechas en es-VE y los textos humanos de la
// cronología. Sin dependencias de servidor: lo usan tanto las páginas (RSC) como los componentes cliente.

export type Tone = "success" | "info" | "attention" | "warning" | "critical" | "neutral";
/** Icono de progreso de Polaris dentro del badge: vacío (sin hacer), mitad (en curso), lleno (hecho). */
export type Progress = "incomplete" | "partial" | "complete" | null;
export interface BadgeSpec { label: string; tone: Tone; progress: Progress }

export const ORDER_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING_PAYMENT: { label: "Pago pendiente", tone: "attention" },
  AWAITING_VERIFICATION: { label: "En verificación", tone: "warning" },
  PARTIALLY_PAID: { label: "Pagado parcialmente", tone: "attention" },
  PAID: { label: "Pagado", tone: "info" },
  ENROLLED: { label: "Inscrito", tone: "success" },
  REJECTED: { label: "Rechazado", tone: "critical" },
  CANCELLED: { label: "Cancelado", tone: "neutral" },
  EXPIRED: { label: "Vencido", tone: "neutral" },
  REFUNDED: { label: "Reembolsado", tone: "neutral" },
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Sin completar", tone: "neutral" },
  AWAITING_VERIFICATION: { label: "Por verificar", tone: "warning" },
  COMPLETED: { label: "Confirmado", tone: "success" },
  REJECTED: { label: "Rechazado", tone: "critical" },
  FAILED: { label: "Fallido", tone: "critical" },
  REFUNDED: { label: "Reembolsado", tone: "neutral" },
  PARTIALLY_REFUNDED: { label: "Reembolso parcial", tone: "info" },
  CANCELLED: { label: "Cancelado", tone: "neutral" },
};

export const METHOD: Record<string, string> = { PAYPAL: "PayPal", PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia bancaria", ZELLE: "Zelle", EFECTIVO: "Efectivo" };
export const METHOD_SHORT: Record<string, string> = { PAYPAL: "PayPal", PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia", ZELLE: "Zelle", EFECTIVO: "Efectivo" };
export const RESERVATION_STATUS: Record<string, string> = { HELD: "Reservado", CONFIRMED: "Ocupado", RELEASED: "Liberado" };
export const RELEASE_REASON: Record<string, string> = { EXPIRED: "venció", REJECTED: "pago rechazado", REFUNDED: "reembolso", CANCELLED: "cancelado", REASSIGNED: "reasignado" };
export const ENROLLMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Pendiente", tone: "attention" },
  ENROLLED: { label: "Matriculado", tone: "success" },
  FAILED: { label: "Falló", tone: "critical" },
  UNENROLLED: { label: "Desmatriculado", tone: "neutral" },
};
export const INSTALLMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Pendiente", tone: "attention" },
  PAID: { label: "Pagada", tone: "success" },
  OVERDUE: { label: "Vencida", tone: "critical" },
  WAIVED: { label: "Condonada", tone: "info" },
};
export const PLAN: Record<string, string> = { FULL: "Pago total", HALF: "Mitad y mitad", MONTHLY: "Mes a mes" };
export const COHORT_STATUS: Record<string, string> = { DRAFT: "Borrador", OPEN: "Inscripciones abiertas", CLOSED: "Inscripciones cerradas", IN_PROGRESS: "En curso", FINISHED: "Finalizada", CANCELLED: "Cancelada" };
export const EMAIL_TEMPLATE: Record<string, string> = {
  order_confirmation: "Confirmación de pedido",
  payment_under_verification: "Pago en verificación",
  payment_approved: "Pago aprobado",
  payment_rejected: "Pago rechazado",
  platform_access: "Acceso a la plataforma",
  cohort_details: "Datos de la cohorte",
  certificate_issued: "Certificado emitido",
  installment_reminder: "Recordatorio de cuota",
  refund_issued: "Reembolso",
};
export const ACTOR: Record<string, string> = { SYSTEM: "CEIUM", ADMIN: "Panel", CUSTOMER: "Cliente", WEBHOOK: "PayPal" };

// ───────────── Dinero y fechas ─────────────

export const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const ves = (cents: number) => "Bs. " + (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TZ = "America/Caracas";
const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-VE", { timeZone: TZ, ...o });
const F_TIME = fmt({ hour: "numeric", minute: "2-digit" });
const F_DAY = fmt({ day: "numeric", month: "long" });
const F_DAY_Y = fmt({ day: "numeric", month: "long", year: "numeric" });
const F_SHORT = fmt({ day: "numeric", month: "short" });
const F_SHORT_Y = fmt({ day: "numeric", month: "short", year: "numeric" });
const F_KEY = fmt({ year: "numeric", month: "2-digit", day: "2-digit" });

export const time = (d: Date | string) => F_TIME.format(new Date(d)).replace(/\s?([ap])\.?\s?m\.?/i, " $1. m.");
export const dayKey = (d: Date | string) => F_KEY.format(new Date(d));
/** «Hoy», «Ayer», «20 de septiembre» (con año si no es el actual). */
export function dayLabel(d: Date | string, now: Date | string = new Date()): string {
  const k = dayKey(d);
  const n = new Date(now);
  if (k === dayKey(n)) return "Hoy";
  if (k === dayKey(new Date(n.getTime() - 86_400_000))) return "Ayer";
  const sameYear = fmt({ year: "numeric" }).format(new Date(d)) === fmt({ year: "numeric" }).format(n);
  return (sameYear ? F_DAY : F_DAY_Y).format(new Date(d));
}
/** Fecha corta del listado: «Hoy a las 3:14 p. m.», «Ayer a las …», «20 sept. a las …». */
export function listDate(d: Date | string, now: Date | string = new Date()): string {
  const l = dayLabel(d, now);
  const day = l === "Hoy" || l === "Ayer" ? l : (fmt({ year: "numeric" }).format(new Date(d)) === fmt({ year: "numeric" }).format(new Date(now)) ? F_SHORT : F_SHORT_Y).format(new Date(d));
  return `${day} a las ${time(d)}`;
}
export const longDate = (d: Date | string) => `${F_DAY_Y.format(new Date(d))} a las ${time(d)}`;
export const shortDate = (d: Date | string) => F_SHORT_Y.format(new Date(d));
/** Fechas de calendario guardadas a medianoche de Caracas o UTC (cohortes): se muestran en UTC. */
export const calDate = (d: Date | string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(d));

// ───────────── Estados derivados (badges tipo Shopify: pago + matrícula) ─────────────

interface OrderLike {
  status: string;
  balanceCents: number;
  amountPaidCents: number;
  refundedCents?: number;
}

/** «Estado del pago» del pedido (como el financial status de Shopify). */
export function paymentBadge(o: OrderLike): BadgeSpec {
  const refunded = o.refundedCents ?? 0;
  switch (o.status) {
    case "PENDING_PAYMENT":
      return { label: "Pago pendiente", tone: "attention", progress: "incomplete" };
    case "AWAITING_VERIFICATION":
      return { label: "Por verificar", tone: "warning", progress: "partial" };
    case "REJECTED":
      return { label: "Pago rechazado", tone: "critical", progress: "incomplete" };
    case "EXPIRED":
      return { label: "Vencido", tone: "neutral", progress: "incomplete" };
    case "CANCELLED":
      return { label: "Anulado", tone: "neutral", progress: "incomplete" };
    case "REFUNDED":
      return { label: "Reembolsado", tone: "neutral", progress: "complete" };
    default:
      if (refunded > 0) return { label: "Reembolso parcial", tone: "neutral", progress: "partial" };
      if (o.balanceCents > 0) return { label: "Pagado parcialmente", tone: "attention", progress: "partial" };
      return { label: "Pagado", tone: "neutral", progress: "complete" };
  }
}

interface EnrollmentSummary { total: number; enrolled: number; failed: number; unenrolled: number; pending: number }

/** «Matrícula» (el fulfillment de Shopify): cursos de Moodle habilitados por el pedido. `monthly`: plan mes a mes
 * (cada cuota habilita un curso), con `courses` = número de cursos del diplomado. */
export function enrollmentBadge(status: string, e: EnrollmentSummary, monthly?: { courses: number } | null): BadgeSpec | null {
  if (["REJECTED", "EXPIRED", "CANCELLED"].includes(status)) return null;
  if (e.failed > 0) return { label: "Matrícula fallida", tone: "critical", progress: "incomplete" };
  if (status === "REFUNDED" || (e.unenrolled > 0 && e.enrolled === 0)) {
    if (e.enrolled > 0) return { label: "Sigue matriculado", tone: "attention", progress: "complete" };
    return e.unenrolled > 0 ? { label: "Desmatriculado", tone: "neutral", progress: "incomplete" } : null;
  }
  if (status === "ENROLLED" || e.enrolled > 0) {
    if (monthly && monthly.courses > 1 && e.enrolled < monthly.courses) return { label: `${e.enrolled} de ${monthly.courses} cursos`, tone: "info", progress: "partial" };
    return { label: "Inscrito", tone: "neutral", progress: "complete" };
  }
  if (["PAID", "PARTIALLY_PAID"].includes(status)) return { label: "Matriculando", tone: "info", progress: "partial" };
  return { label: "Sin matricular", tone: "attention", progress: "incomplete" };
}

// ───────────── Cronología ─────────────

export interface EventLike {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string;
  actor: { name: string; email: string } | null;
  note: string | null;
  data: unknown;
  createdAt: Date | string;
}

const EVENT_TITLE: Record<string, string> = {
  CREATED: "Pedido creado",
  STATUS_CHANGE: "Cambio de estado",
  PAYMENT_SUBMITTED: "Pago registrado por el cliente",
  PAYMENT_VERIFIED: "Pago aprobado",
  PAYMENT_REJECTED: "Pago rechazado",
  PAYMENT_RECEIVED: "Pago recibido",
  REFUND_REQUESTED: "Reembolso solicitado",
  REFUND: "Reembolso aplicado",
  ENROLLMENT: "Matrícula",
  ENROLLMENT_FAILED: "Matrícula fallida",
  UNENROLLMENT: "Desmatrícula en Moodle",
  UNENROLLMENT_FAILED: "Desmatrícula fallida (se reintenta)",
  NOTE: "Comentario",
  EMAIL_SENT: "Correo enviado",
  EMAIL_FAILED: "Correo fallido",
  MOODLE_USER: "Cuenta de Moodle",
  MOODLE_USER_CREATE_REQUESTED: "Alta en Moodle solicitada",
  MOODLE_USER_CREATE_UNCONFIRMED: "Alta en Moodle sin confirmar",
  ATTENTION: "Requiere atención",
  CUSTOMER_UPDATED: "Cliente actualizado",
  COHORT_REASSIGNED: "Cohorte reasignada",
  CERTIFICATE_ISSUED: "Certificado emitido",
  CERTIFICATE_REVOKED: "Certificado revocado",
  INSTALLMENT_PAID: "Cuota pagada",
  INSTALLMENT_OVERDUE: "Cuota vencida",
  INSTALLMENT_WAIVED: "Cuota condonada",
  BALANCE_ADJUSTED: "Saldo ajustado",
  PAYPAL_ORDER_CREATED: "Pago PayPal iniciado",
  PAYMENT_CAPTURED: "Pago PayPal capturado",
  PAYMENT_FAILED: "Pago fallido",
  PAYMENT_NOT_CAPTURED: "Pago PayPal no capturado",
  PAYMENT_PENDING_REVIEW: "PayPal retuvo el pago",
  SEAT_HOLD_EXTENDED: "Reserva extendida",
  SEAT_REACQUIRED: "Cupo vuelto a tomar",
  SEAT_UNAVAILABLE: "Sin cupo",
  SEAT_RELEASED: "Cupo liberado",
};
export const eventTitle = (type: string) => EVENT_TITLE[type] ?? type.toLowerCase().replace(/_/g, " ");

export type EventKind = "comment" | "money" | "refund" | "alert" | "mail" | "moodle" | "status" | "seat" | "default";
export function eventKind(type: string): EventKind {
  if (type === "NOTE") return "comment";
  if (["REFUND", "REFUND_REQUESTED"].includes(type)) return "refund";
  if (["ATTENTION", "PAYMENT_REJECTED", "PAYMENT_FAILED", "ENROLLMENT_FAILED", "UNENROLLMENT_FAILED", "EMAIL_FAILED", "SEAT_UNAVAILABLE", "PAYMENT_NOT_CAPTURED", "CERTIFICATE_REVOKED"].includes(type)) return "alert";
  if (["PAYMENT_VERIFIED", "PAYMENT_RECEIVED", "PAYMENT_CAPTURED", "INSTALLMENT_PAID", "PAYMENT_SUBMITTED", "BALANCE_ADJUSTED", "INSTALLMENT_WAIVED"].includes(type)) return "money";
  if (type.startsWith("EMAIL")) return "mail";
  if (type.startsWith("MOODLE") || type.startsWith("ENROLL") || type === "UNENROLLMENT" || type.startsWith("CERTIFICATE")) return "moodle";
  if (type === "STATUS_CHANGE" || type === "CREATED") return "status";
  if (type.startsWith("SEAT") || type === "COHORT_REASSIGNED") return "seat";
  return "default";
}

const TEMPLATE_BY_KEY = EMAIL_TEMPLATE;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Frase principal de un evento, en lenguaje de la persona que opera el panel. */
export function eventMessage(e: EventLike, ctx: { customerName: string }): string {
  const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
  const amount = num(d.amountUsdCents) ?? num(d.amountCents);
  const who = e.actorType === "ADMIN" && e.actor ? e.actor.name : null;
  switch (e.type) {
    case "CREATED":
      return `${ctx.customerName} realizó el pedido desde la tienda en línea.`;
    case "STATUS_CHANGE": {
      const to = ORDER_STATUS[e.toStatus ?? ""]?.label ?? e.toStatus;
      const from = ORDER_STATUS[e.fromStatus ?? ""]?.label ?? e.fromStatus;
      return `El pedido pasó de «${from}» a «${to}»${who ? ` (${who})` : ""}.`;
    }
    case "PAYMENT_SUBMITTED": {
      const cur = d.currency === "VES" && num(d.amountCents) != null ? `${ves(num(d.amountCents)!)} (≈ ${usd(num(d.amountUsdCents) ?? 0)})` : amount != null ? usd(amount) : "";
      return `${e.actorType === "ADMIN" ? `${who ?? "El panel"} registró` : `${ctx.customerName} registró`} un pago${cur ? ` de ${cur}` : ""}${e.note ? ` · ${e.note}` : ""}.`;
    }
    case "PAYMENT_VERIFIED": {
      const extra = e.note && !/^Pago aprobado\.?$/.test(e.note) ? ` · ${e.note.replace(/^Pago aprobado\.\s*/, "")}` : "";
      return `Pago aprobado por ${who ?? "el panel"}${extra}.`;
    }
    case "PAYMENT_REJECTED":
      return `Pago rechazado por ${who ?? "el panel"}${e.note ? `: «${e.note}»` : "."}`;
    case "PAYMENT_RECEIVED": {
      const m = /^([^:]+):/.exec(e.note ?? "");
      return `Pago recibido${amount != null ? ` de ${usd(amount)}` : ""}${m ? ` por ${m[1]}` : ""}.`;
    }
    case "PAYMENT_CAPTURED":
      return `PayPal capturó ${amount != null ? usd(amount) : "el pago"}${typeof d.captureId === "string" ? ` · captura ${d.captureId}` : ""}.`;
    case "PAYPAL_ORDER_CREATED":
      return `${ctx.customerName} inició el pago con PayPal${amount != null ? ` por ${usd(amount)}` : ""}.`;
    case "REFUND_REQUESTED":
      return `${who ?? "El panel"} solicitó a PayPal un reembolso${amount != null ? ` de ${usd(amount)}` : ""}.`;
    case "REFUND":
      return `Se reembolsaron ${amount != null ? usd(amount) : "fondos"}${d.manual ? " (registrado a mano)" : " por PayPal"}${who ? ` · ${who}` : ""}.`;
    case "EMAIL_SENT":
    case "EMAIL_FAILED": {
      const m = /^(\w+)\s*→\s*(.+)$/.exec(e.note ?? "");
      const t = m ? TEMPLATE_BY_KEY[m[1]] ?? m[1] : "Correo";
      return e.type === "EMAIL_SENT" ? `Se envió «${t}» a ${m?.[2] ?? "el cliente"}.` : `No se pudo enviar «${t}»${m ? ` a ${m[2]}` : ""}.`;
    }
    case "NOTE":
      return e.note ?? "";
    case "BALANCE_ADJUSTED":
    case "INSTALLMENT_WAIVED":
      return `${eventTitle(e.type)}${who ? ` por ${who}` : ""}${e.note ? `: «${e.note}»` : "."}`;
    case "COHORT_REASSIGNED":
      return `Cohorte reasignada${who ? ` por ${who}` : ""}${e.note ? `: «${e.note}»` : "."}`;
    default: {
      if (!e.note) return eventTitle(e.type) + ".";
      const n = e.note.replace(/\.$/, "") + ".";
      // «Cupo liberado en …», «Matriculado en …»: la nota ya lo dice; si no, se antepone el título.
      const t = eventTitle(e.type);
      return n.toLowerCase().startsWith(t.toLowerCase().slice(0, 8)) || ["ENROLLMENT", "MOODLE_USER", "MOODLE_USER_CREATE_REQUESTED", "STATUS_CHANGE"].includes(e.type) ? n : `${t}: ${n}`;
    }
  }
}

/** Detalle expandible de un evento (datos concretos, sin JSON crudo). */
export function eventDetails(e: EventLike): [string, string][] {
  const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
  const out: [string, string][] = [["Evento", eventTitle(e.type)]];
  if (e.fromStatus || e.toStatus) out.push(["Estado", `${ORDER_STATUS[e.fromStatus ?? ""]?.label ?? "—"} → ${ORDER_STATUS[e.toStatus ?? ""]?.label ?? "—"}`]);
  if (num(d.amountCents) != null && e.type.startsWith("REFUND")) out.push(["Monto", usd(num(d.amountCents)!)]);
  if (num(d.balanceCents) != null) out.push(["Saldo tras la operación", usd(num(d.balanceCents)!)]);
  const opts = d.options as Record<string, unknown> | undefined;
  if (opts && typeof opts === "object") {
    const yn = (v: unknown, def: string) => (v === true ? "sí" : v === false ? "no" : def);
    out.push(["Desmatricular", yn(opts.unenroll, "si es total")], ["Liberar cupo", yn(opts.releaseSeat, "si es total")]);
  }
  if (typeof d.exchangeRate === "number") out.push(["Tasa", `Bs. ${d.exchangeRate.toLocaleString("es-VE")} por USD`]);
  if (Array.isArray(d.courseIds) && d.courseIds.length) out.push(["Cursos de Moodle", d.courseIds.join(", ")]);
  if (e.note && e.type !== "NOTE" && !["EMAIL_SENT", "EMAIL_FAILED", "CREATED"].includes(e.type)) out.push(["Nota", e.note]);
  out.push(["Autor", e.actorType === "ADMIN" && e.actor ? `${e.actor.name} (${e.actor.email})` : ACTOR[e.actorType] ?? e.actorType]);
  return out;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
