// Cupos por cohorte. Invariante: Cohort.seatsHeld + Cohort.seatsConfirmed <= capacity, siempre.
// Toda toma de cupo es un UPDATE condicional atómico (… WHERE seatsHeld + seatsConfirmed < capacity):
// si dos compradores compiten por el último cupo, solo uno obtiene filas afectadas = 1. No hay
// "leer y luego escribir" que permita sobreventa, ni en SQLite (lock de escritura) ni en Postgres
// (el UPDATE re-evalúa la condición sobre la fila bloqueada).
// Las reservas HELD vencidas se liberan antes de intentar tomar cupo, así el conteo es
// CONFIRMED + HELD vivas. Las reservas de pedidos AWAITING_VERIFICATION (comprobante ya enviado)
// no vencen: se liberan solo si el admin rechaza el pago.
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

/** Libera reservas HELD vencidas de una cohorte (dentro de la transacción). Devuelve cuántas. */
export async function releaseExpiredForCohort(tx: Tx, cohortId: string, now: Date): Promise<number> {
  const stale = await tx.seatReservation.findMany({
    where: { cohortId, status: "HELD", expiresAt: { lt: now }, order: { status: { not: "AWAITING_VERIFICATION" } } },
    select: { id: true },
  });
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

/** Job: libera todas las reservas HELD vencidas (excepto pedidos con comprobante en verificación). */
export async function expireStaleReservations(d: Deps): Promise<number> {
  const now = d.now();
  const stale = await d.db.seatReservation.findMany({
    where: { status: "HELD", expiresAt: { lt: now }, order: { status: { not: "AWAITING_VERIFICATION" } } },
    select: { id: true },
  });
  let released = 0;
  for (const s of stale) {
    if (await withTx(d, (tx) => releaseReservation(tx, s.id, "EXPIRED", now))) released++;
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
    where: { cohortId, status: "HELD", OR: [{ expiresAt: { gte: now } }, { order: { status: "AWAITING_VERIFICATION" } }] },
  });
  const available = Math.max(0, c.capacity - c.seatsConfirmed - held);
  const deadlineOk = !c.enrollmentDeadline || c.enrollmentDeadline.getTime() >= now.getTime();
  return { capacity: c.capacity, confirmed: c.seatsConfirmed, held, available, purchasable: c.status === "OPEN" && deadlineOk && available > 0 };
}

/**
 * Corrección manual: mueve el cupo de un ítem a otra cohorte (misma venta). Si el cupo original estaba
 * confirmado, el nuevo se toma confirmado; si no, retenido con el mismo vencimiento.
 */
export async function reassignItemCohort(tx: Tx, orderItemId: string, newCohortId: string, now: Date) {
  const item = await tx.orderItem.findUniqueOrThrow({ where: { id: orderItemId }, include: { reservation: true, order: true } });
  const newCohort = await tx.cohort.findUnique({ where: { id: newCohortId } });
  if (!newCohort) throw new DomainError("NOT_FOUND", "La cohorte destino no existe.");
  if (newCohort.productId !== item.productId) throw new DomainError("VALIDATION", "La cohorte destino es de otro programa.");
  if (item.cohortId === newCohortId) throw new DomainError("VALIDATION", "El ítem ya está en esa cohorte.");
  const old = item.reservation;
  const wasConfirmed = old?.status === "CONFIRMED";
  if (!(await acquireSeat(tx, newCohortId, wasConfirmed ? "CONFIRMED" : "HELD", { requireOpen: false })))
    throw new DomainError("SOLD_OUT", "La cohorte destino no tiene cupos disponibles.");
  if (old) {
    await releaseReservation(tx, old.id, "REASSIGNED", now);
    await tx.seatReservation.update({ where: { id: old.id }, data: { orderItemId: null } });
  }
  const created = await tx.seatReservation.create({
    data: {
      cohortId: newCohortId,
      orderId: item.orderId,
      orderItemId: item.id,
      status: wasConfirmed ? "CONFIRMED" : "HELD",
      confirmedAt: wasConfirmed ? now : null,
      expiresAt: old?.expiresAt ?? item.order.expiresAt ?? now,
    },
  });
  await tx.orderItem.update({ where: { id: item.id }, data: { cohortId: newCohortId, sedeId: newCohort.sedeId } });
  return { from: item.cohortId, to: newCohortId, reservation: created };
}
