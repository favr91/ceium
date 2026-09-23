// Cupos por cohorte. Invariante: Cohort.seatsHeld + Cohort.seatsConfirmed <= capacity, siempre.
// Toda toma de cupo es un UPDATE condicional atómico (… WHERE seatsHeld + seatsConfirmed < capacity):
// si dos compradores compiten por el último cupo, solo uno obtiene filas afectadas = 1. No hay
// "leer y luego escribir" que permita sobreventa, ni en SQLite (lock de escritura) ni en Postgres
// (el UPDATE re-evalúa la condición sobre la fila bloqueada).
// Las reservas HELD vencidas se liberan antes de intentar tomar cupo, así el conteo es
// CONFIRMED + HELD vivas. Una reserva HELD NO vence (aunque pase su expiresAt) si el pedido tiene dinero
// en camino o ya cobrado (ver PROTECTED_ORDER_STATUSES / expirableReservationWhere):
//  - AWAITING_VERIFICATION: comprobante enviado; se libera solo si el admin rechaza el pago.
//  - PAID / PARTIALLY_PAID / ENROLLED: el primer pago ya se confirmó.
//  - un pago PayPal PENDING con providerStatus CAPTURE_PENDING: PayPal retuvo la captura (el cliente
//    ve "Tu cupo se mantiene"); el cupo se sostiene hasta que PayPal complete o niegue la captura.
import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import { withTx } from "@/server/deps";
import { DomainError } from "@/server/errors";

export type ReleaseReason = "EXPIRED" | "REJECTED" | "REFUNDED" | "CANCELLED" | "REASSIGNED";

/** Toma 1 cupo (HELD o CONFIRMED) si hay capacidad. Devuelve false si no hay cupo o la cohorte no admite ventas. */
export async function acquireSeat(tx: Tx, cohortId: string, kind: "HELD" | "CONFIRMED", opts: { requireOpen: boolean }): Promise<boolean> {
  const n =
    kind === "HELD"
      ? opts.requireOpen
        ? await tx.$executeRaw`UPDATE "Cohort" SET "seatsHeld" = "seatsHeld" + 1 WHERE "id" = ${cohortId} AND "status" = 'OPEN' AND "seatsHeld" + "seatsConfirmed" < "capacity"`
        : await tx.$executeRaw`UPDATE "Cohort" SET "seatsHeld" = "seatsHeld" + 1 WHERE "id" = ${cohortId} AND "status" <> 'CANCELLED' AND "seatsHeld" + "seatsConfirmed" < "capacity"`
      : opts.requireOpen
        ? await tx.$executeRaw`UPDATE "Cohort" SET "seatsConfirmed" = "seatsConfirmed" + 1 WHERE "id" = ${cohortId} AND "status" = 'OPEN' AND "seatsHeld" + "seatsConfirmed" < "capacity"`
        : await tx.$executeRaw`UPDATE "Cohort" SET "seatsConfirmed" = "seatsConfirmed" + 1 WHERE "id" = ${cohortId} AND "status" <> 'CANCELLED' AND "seatsHeld" + "seatsConfirmed" < "capacity"`;
  return n === 1;
}

async function decrement(tx: Tx, cohortId: string, field: "seatsHeld" | "seatsConfirmed", by = 1) {
  if (by <= 0) return;
  if (field === "seatsHeld") await tx.$executeRaw`UPDATE "Cohort" SET "seatsHeld" = CASE WHEN "seatsHeld" > ${by} THEN "seatsHeld" - ${by} ELSE 0 END WHERE "id" = ${cohortId}`;
  else await tx.$executeRaw`UPDATE "Cohort" SET "seatsConfirmed" = CASE WHEN "seatsConfirmed" > ${by} THEN "seatsConfirmed" - ${by} ELSE 0 END WHERE "id" = ${cohortId}`;
}

/** Pedidos cuyas reservas HELD no vencen por tiempo (hay un pago en verificación o ya confirmado). */
export const PROTECTED_ORDER_STATUSES: readonly OrderStatus[] = ["AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"];

/** Condición sobre el pedido: no está protegido (sin pago en verificación/confirmado ni captura PayPal retenida). */
function unprotectedOrderWhere(): Prisma.OrderWhereInput {
  return {
    status: { notIn: [...PROTECTED_ORDER_STATUSES] },
    payments: { none: { method: "PAYPAL", status: "PENDING", providerStatus: "CAPTURE_PENDING" } },
  };
}

/** Reservas HELD que el job (o la limpieza al reservar) puede liberar: vencidas y de pedidos no protegidos. */
export function expirableReservationWhere(now: Date): Prisma.SeatReservationWhereInput {
  return { status: "HELD", expiresAt: { lt: now }, order: unprotectedOrderWhere() };
}

/** Libera reservas HELD vencidas de una cohorte (dentro de la transacción). Devuelve cuántas. */
export async function releaseExpiredForCohort(tx: Tx, cohortId: string, now: Date): Promise<number> {
  const stale = await tx.seatReservation.findMany({ where: { cohortId, ...expirableReservationWhere(now) }, select: { id: true } });
  let released = 0;
  for (const s of stale) if (await releaseReservation(tx, s.id, "EXPIRED", now)) released++;
  return released;
}

export interface ReserveInput {
  cohortId: string;
  orderId: string;
  orderItemId?: string | null;
  ttlMs: number;
  now: Date;
}

/**
 * Reserva atómica de un cupo. Lanza SOLD_OUT si no hay cupo y COHORT_UNAVAILABLE si la cohorte
 * no está abierta o venció el plazo de inscripción. Debe llamarse dentro de una transacción.
 */
export async function reserveSeat(tx: Tx, input: ReserveInput) {
  const { cohortId, now } = input;
  const cohort = await tx.cohort.findUnique({ where: { id: cohortId }, select: { id: true, status: true, enrollmentDeadline: true, name: true } });
  if (!cohort) throw new DomainError("NOT_FOUND", "La cohorte no existe.");
  if (cohort.status !== "OPEN") throw new DomainError("COHORT_UNAVAILABLE", "Esta cohorte no tiene inscripciones abiertas.", { cohortId });
  if (cohort.enrollmentDeadline && cohort.enrollmentDeadline.getTime() < now.getTime())
    throw new DomainError("COHORT_UNAVAILABLE", "El plazo de inscripción de esta cohorte ya cerró.", { cohortId });

  let ok = await acquireSeat(tx, cohortId, "HELD", { requireOpen: true });
  if (!ok && (await releaseExpiredForCohort(tx, cohortId, now)) > 0) ok = await acquireSeat(tx, cohortId, "HELD", { requireOpen: true });
  if (!ok) throw new DomainError("SOLD_OUT", "No quedan cupos disponibles en esta cohorte.", { cohortId });

  return tx.seatReservation.create({
    data: { cohortId, orderId: input.orderId, orderItemId: input.orderItemId ?? null, status: "HELD", expiresAt: new Date(now.getTime() + input.ttlMs) },
  });
}

export type ConfirmResult = { ok: true; reacquired: boolean } | { ok: false; reason: "NO_CAPACITY" | "NOT_FOUND" };

/**
 * Convierte la reserva en cupo ocupado. Si la reserva ya se había liberado (venció antes de que llegara
 * el pago), intenta volver a tomar cupo; si la cohorte se llenó devuelve ok:false (requiere intervención).
 */
export async function confirmReservation(tx: Tx, reservationId: string, now: Date): Promise<ConfirmResult> {
  const res = await tx.seatReservation.findUnique({ where: { id: reservationId } });
  if (!res) return { ok: false, reason: "NOT_FOUND" };
  if (res.status === "CONFIRMED") return { ok: true, reacquired: false };
  if (res.status === "HELD") {
    const n = await tx.seatReservation.updateMany({ where: { id: res.id, status: "HELD" }, data: { status: "CONFIRMED", confirmedAt: now } });
    if (n.count === 1) {
      await tx.$executeRaw`UPDATE "Cohort" SET "seatsHeld" = CASE WHEN "seatsHeld" > 0 THEN "seatsHeld" - 1 ELSE 0 END, "seatsConfirmed" = "seatsConfirmed" + 1 WHERE "id" = ${res.cohortId}`;
      return { ok: true, reacquired: false };
    }
    return confirmReservation(tx, reservationId, now);
  }
  // RELEASED → reintentar tomar cupo (pago tardío). No exige cohorte OPEN: el pago ya se hizo.
  if (!(await acquireSeat(tx, res.cohortId, "CONFIRMED", { requireOpen: false }))) return { ok: false, reason: "NO_CAPACITY" };
  await tx.seatReservation.update({ where: { id: res.id }, data: { status: "CONFIRMED", confirmedAt: now, releasedAt: null, releasedReason: null } });
  return { ok: true, reacquired: true };
}

/** Libera la reserva (HELD o CONFIRMED) y devuelve el cupo. Idempotente: false si ya estaba liberada. */
export async function releaseReservation(tx: Tx, reservationId: string, reason: ReleaseReason, now: Date): Promise<boolean> {
  const res = await tx.seatReservation.findUnique({ where: { id: reservationId } });
  if (!res || res.status === "RELEASED") return false;
  const n = await tx.seatReservation.updateMany({ where: { id: res.id, status: res.status }, data: { status: "RELEASED", releasedAt: now, releasedReason: reason } });
  if (n.count !== 1) return false;
  await decrement(tx, res.cohortId, res.status === "HELD" ? "seatsHeld" : "seatsConfirmed");
  return true;
}

/** Libera todas las reservas vivas de un pedido. */
export async function releaseOrderReservations(tx: Tx, orderId: string, reason: ReleaseReason, now: Date): Promise<number> {
  const rs = await tx.seatReservation.findMany({ where: { orderId, status: { in: ["HELD", "CONFIRMED"] } }, select: { id: true } });
  let n = 0;
  for (const r of rs) if (await releaseReservation(tx, r.id, reason, now)) n++;
  return n;
}

/**
 * Job: libera las reservas HELD vencidas de pedidos no protegidos (ver expirableReservationWhere). La
 * condición se vuelve a comprobar dentro de la transacción: si entretanto llegó un comprobante o PayPal
 * retuvo la captura, la reserva se conserva.
 */
export async function expireStaleReservations(d: Deps): Promise<number> {
  const now = d.now();
  const stale = await d.db.seatReservation.findMany({ where: expirableReservationWhere(now), select: { id: true } });
  let released = 0;
  for (const s of stale) {
    const ok = await withTx(d, async (tx) => {
      const still = await tx.seatReservation.count({ where: { id: s.id, ...expirableReservationWhere(now) } });
      return still === 1 && (await releaseReservation(tx, s.id, "EXPIRED", now));
    });
    if (ok) released++;
  }
  return released;
}

export interface CohortAvailability {
  capacity: number;
  confirmed: number;
  held: number;
  available: number;
  purchasable: boolean;
}

/** Disponibilidad en vivo (cuenta HELD vivas, no el contador, por si el job aún no pasó). */
export async function getCohortAvailability(d: Pick<Deps, "db" | "now">, cohortId: string): Promise<CohortAvailability> {
  const now = d.now();
  const c = await d.db.cohort.findUniqueOrThrow({ where: { id: cohortId } });
  const held = await d.db.seatReservation.count({
    where: { cohortId, status: "HELD", NOT: { expiresAt: { lt: now }, order: unprotectedOrderWhere() } },
  });
  const available = Math.max(0, c.capacity - c.seatsConfirmed - held);
  const deadlineOk = !c.enrollmentDeadline || c.enrollmentDeadline.getTime() >= now.getTime();
  return { capacity: c.capacity, confirmed: c.seatsConfirmed, held, available, purchasable: c.status === "OPEN" && deadlineOk && available > 0 };
}

export interface ReassignOptions {
  /** Vigencia de una reserva HELD nueva (pedidos aún sin pagar). */
  ttlMs: number;
}

export interface ReassignResult {
  from: string | null;
  to: string;
  reservation: Awaited<ReturnType<Tx["seatReservation"]["create"]>>;
  /** El nuevo cupo quedó ocupado (CONFIRMED): el pedido ya tenía el primer pago confirmado. */
  confirmed: boolean;
  /** El ítem no tenía cupo (reserva liberada: p.ej. pago PayPal tardío con la cohorte llena) y ahora sí. */
  seatRestored: boolean;
}

const CLOSED_FOR_REASSIGN: readonly OrderStatus[] = ["CANCELLED", "REFUNDED", "EXPIRED", "REJECTED"];

/**
 * Corrección manual: mueve el cupo de un ítem a otra cohorte del mismo programa, o vuelve a tomar cupo en
 * la MISMA cohorte si la reserva estaba liberada (p.ej. el pago llegó cuando la cohorte ya estaba llena y
 * luego se abrió un cupo).
 *  - Pedido con el primer pago confirmado (PAID/PARTIALLY_PAID/ENROLLED) o cupo que ya estaba confirmado:
 *    el nuevo cupo se toma CONFIRMED (nunca vence) y el llamador debe disparar la matrícula.
 *  - Pedido sin pagar: HELD con un plazo nuevo (máx. entre el vencimiento actual y ahora + ttl); el
 *    vencimiento del pedido se extiende igual para que no venza antes que su reserva.
 * No exige cohorte OPEN (es una corrección del admin), pero sí que no esté cancelada y tenga cupo.
 */
export async function reassignItemCohort(tx: Tx, orderItemId: string, newCohortId: string, now: Date, opts: ReassignOptions): Promise<ReassignResult> {
  const item = await tx.orderItem.findUnique({ where: { id: orderItemId }, include: { reservation: true, order: true } });
  if (!item) throw new DomainError("NOT_FOUND", "El ítem del pedido no existe.");
  if (item.modality !== "SEMIPRESENCIAL") throw new DomainError("VALIDATION", "Solo los ítems semipresenciales tienen cohorte.");
  if (CLOSED_FOR_REASSIGN.includes(item.order.status)) throw new DomainError("INVALID_STATE", `El pedido está ${item.order.status}: no se puede reasignar la cohorte.`);
  const newCohort = await tx.cohort.findUnique({ where: { id: newCohortId } });
  if (!newCohort) throw new DomainError("NOT_FOUND", "La cohorte destino no existe.");
  if (newCohort.productId !== item.productId) throw new DomainError("VALIDATION", "La cohorte destino es de otro programa.");
  if (newCohort.status === "CANCELLED") throw new DomainError("COHORT_UNAVAILABLE", "La cohorte destino está cancelada.");

  const old = item.reservation;
  const sameCohort = item.cohortId === newCohortId;
  if (sameCohort && old && old.status !== "RELEASED") throw new DomainError("VALIDATION", "El ítem ya tiene cupo en esa cohorte.");

  const orderPaid = (["PAID", "PARTIALLY_PAID", "ENROLLED"] as OrderStatus[]).includes(item.order.status);
  const confirmed = orderPaid || old?.status === "CONFIRMED";
  const seatRestored = !old || old.status === "RELEASED";
  if (!(await acquireSeat(tx, newCohortId, confirmed ? "CONFIRMED" : "HELD", { requireOpen: false })))
    throw new DomainError("SOLD_OUT", "La cohorte destino no tiene cupos disponibles.");

  let expiresAt = new Date(now.getTime() + opts.ttlMs);
  for (const t of [old?.expiresAt, item.order.expiresAt]) if (t && t.getTime() > expiresAt.getTime()) expiresAt = t;

  if (old) {
    await releaseReservation(tx, old.id, "REASSIGNED", now);
    await tx.seatReservation.update({ where: { id: old.id }, data: { orderItemId: null } });
  }
  const created = await tx.seatReservation.create({
    data: { cohortId: newCohortId, orderId: item.orderId, orderItemId: item.id, status: confirmed ? "CONFIRMED" : "HELD", confirmedAt: confirmed ? now : null, expiresAt },
  });
  await tx.orderItem.update({ where: { id: item.id }, data: { cohortId: newCohortId, sedeId: newCohort.sedeId } });
  if (!confirmed && item.order.status === "PENDING_PAYMENT" && (!item.order.expiresAt || item.order.expiresAt.getTime() < expiresAt.getTime())) {
    await tx.order.update({ where: { id: item.orderId }, data: { expiresAt } });
  }
  return { from: item.cohortId, to: newCohortId, reservation: created, confirmed, seatRestored };
}
