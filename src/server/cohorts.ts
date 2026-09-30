// Cohortes desde el panel: alta, edición (cupo, fechas, sesiones, estado) y baja, con auditoría.
// Invariante de seats.ts: seatsHeld + seatsConfirmed <= capacity, SIEMPRE. El cupo nunca se escribe con un
// update "ciego": se usa un UPDATE condicional (… WHERE seatsHeld + seatsConfirmed <= :nuevo) en la misma
// transacción que la auditoría, así una reserva concurrente no puede dejar el cupo por debajo de lo ocupado.
// Los contadores seatsHeld/seatsConfirmed solo los mueve seats.ts: aquí no se aceptan.
import { z } from "zod";
import { Prisma, type CohortStatus } from "@/generated/prisma/client";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps, type Tx } from "@/server/deps";
import { DomainError } from "@/server/errors";

const COHORT_STATUSES = ["DRAFT", "OPEN", "CLOSED", "IN_PROGRESS", "FINISHED", "CANCELLED"] as const satisfies readonly CohortStatus[];

const sessionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha de sesión inválida (AAAA-MM-DD)"),
  title: z.string().trim().min(1).max(200),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  courseSlug: z.string().optional(),
});

const baseFields = {
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  enrollmentDeadline: z.coerce.date().nullable().optional(),
  capacity: z.number().int("El cupo debe ser un número entero").min(0, "El cupo no puede ser negativo").max(10_000),
  status: z.enum(COHORT_STATUSES),
  sessions: z.array(sessionSchema).max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  // Enlace público en la ficha: solo https:// o una ruta del propio sitio (nada de javascript:, data: ni http).
  scheduleUrl: z.string().max(1000).regex(/^(https:\/\/|\/(?!\/))\S*$/, "El enlace del cronograma debe empezar por https://").nullable().optional(),
  isSample: z.boolean().optional(),
};

export const createCohortSchema = z.object({ productId: z.string().min(1), sedeId: z.string().min(1), ...baseFields, status: baseFields.status.default("DRAFT") });
export const updateCohortSchema = z.object(baseFields).partial().strict();
export type CreateCohortInput = z.input<typeof createCohortSchema>;
export type UpdateCohortInput = z.input<typeof updateCohortSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("VALIDATION", r.error.issues.map((i) => i.message).join(". "), { issues: r.error.issues });
  return r.data;
}

function checkDates(c: { startDate: Date; endDate: Date; enrollmentDeadline?: Date | null }) {
  if (c.endDate.getTime() < c.startDate.getTime()) throw new DomainError("VALIDATION", "La fecha de fin no puede ser anterior a la de inicio.");
  if (c.enrollmentDeadline && c.enrollmentDeadline.getTime() > c.endDate.getTime()) throw new DomainError("VALIDATION", "El cierre de inscripciones no puede ser posterior al fin de la cohorte.");
}

async function loadCohort(tx: Tx, id: string) {
  const c = await tx.cohort.findUnique({ where: { id } });
  if (!c) throw new DomainError("NOT_FOUND", "La cohorte no existe.");
  return c;
}

export async function createCohort(d: Deps, actor: SessionUser, input: CreateCohortInput) {
  actor = await requireAdmin(d.db, actor, "cohorts.manage");
  const data = parse(createCohortSchema, input);
  checkDates(data);
  return withTx(d, async (tx) => {
    const product = await tx.product.findUnique({ where: { id: data.productId }, select: { id: true, offersSemipresencial: true } });
    if (!product) throw new DomainError("NOT_FOUND", "El programa no existe.");
    if (!product.offersSemipresencial) throw new DomainError("VALIDATION", "Las cohortes son solo para programas semipresenciales.");
    const sede = await tx.sede.findUnique({ where: { id: data.sedeId }, select: { id: true } });
    if (!sede) throw new DomainError("NOT_FOUND", "La sede no existe.");
    const created = await tx.cohort.create({
      data: {
        productId: data.productId,
        sedeId: data.sedeId,
        name: data.name,
        startDate: data.startDate,
        endDate: data.endDate,
        enrollmentDeadline: data.enrollmentDeadline ?? null,
        capacity: data.capacity,
        status: data.status,
        sessions: (data.sessions ?? undefined) as Prisma.InputJsonValue | undefined,
        notes: data.notes ?? null,
        scheduleUrl: data.scheduleUrl ?? null,
        isSample: data.isSample ?? false,
      },
    });
    await recordAudit(tx, { actor, action: "cohort.create", entityType: "Cohort", entityId: created.id, before: null, after: created, force: true });
    return created;
  });
}

/**
 * Edita una cohorte. El cupo se valida contra lo ocupado de forma atómica: si el nuevo cupo es menor que
 * seatsHeld + seatsConfirmed (leídos dentro del mismo UPDATE) → CONFLICT y no cambia nada.
 */
export async function updateCohort(d: Deps, actor: SessionUser, cohortId: string, input: UpdateCohortInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "cohorts.manage");
  const patch = parse(updateCohortSchema, input);
  return withTx(d, async (tx) => {
    const before = await loadCohort(tx, cohortId);
    checkDates({
      startDate: patch.startDate ?? before.startDate,
      endDate: patch.endDate ?? before.endDate,
      enrollmentDeadline: patch.enrollmentDeadline !== undefined ? patch.enrollmentDeadline : before.enrollmentDeadline,
    });
    if (patch.status === "CANCELLED" && before.status !== "CANCELLED" && before.seatsHeld + before.seatsConfirmed > 0) {
      throw new DomainError("CONFLICT", `No se puede cancelar: la cohorte tiene ${before.seatsConfirmed} cupo(s) confirmado(s) y ${before.seatsHeld} reservado(s). Reasigna o reembolsa esos pedidos primero.`, {
        seatsHeld: before.seatsHeld,
        seatsConfirmed: before.seatsConfirmed,
      });
    }
    if (patch.capacity !== undefined && patch.capacity !== before.capacity) {
      const n = await tx.$executeRaw`UPDATE "Cohort" SET "capacity" = ${patch.capacity} WHERE "id" = ${cohortId} AND "seatsHeld" + "seatsConfirmed" <= ${patch.capacity}`;
      if (n !== 1) {
        const now = await loadCohort(tx, cohortId);
        throw new DomainError("CONFLICT", `El cupo no puede ser menor que los cupos ocupados (${now.seatsConfirmed} ${now.seatsConfirmed === 1 ? "confirmado" : "confirmados"} + ${now.seatsHeld} ${now.seatsHeld === 1 ? "reservado" : "reservados"} = ${now.seatsConfirmed + now.seatsHeld}).`, {
          capacity: patch.capacity,
          seatsHeld: now.seatsHeld,
          seatsConfirmed: now.seatsConfirmed,
        });
      }
    }
    const { capacity: _capacity, sessions, ...rest } = patch;
    void _capacity;
    const after = await tx.cohort.update({
      where: { id: cohortId },
      data: { ...rest, ...(sessions !== undefined ? { sessions: sessions === null ? Prisma.DbNull : (sessions as Prisma.InputJsonValue) } : {}) },
    });
    await recordAudit(tx, { actor, action: patch.status && patch.status !== before.status ? "cohort.status" : "cohort.update", entityType: "Cohort", entityId: cohortId, before, after, note });
    return after;
  });
}

export async function setCohortStatus(d: Deps, actor: SessionUser, cohortId: string, status: CohortStatus, note?: string) {
  return updateCohort(d, actor, cohortId, { status }, note);
}

/** Borra una cohorte que nunca se vendió (sin reservas ni pedidos). Si ya tuvo ventas: cancelarla/cerrarla. */
export async function deleteCohort(d: Deps, actor: SessionUser, cohortId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "cohorts.manage");
  return withTx(d, async (tx) => {
    const before = await loadCohort(tx, cohortId);
    const [reservations, items] = await Promise.all([tx.seatReservation.count({ where: { cohortId } }), tx.orderItem.count({ where: { cohortId } })]);
    if (reservations || items || before.seatsHeld || before.seatsConfirmed) {
      throw new DomainError("CONFLICT", "La cohorte tiene pedidos o reservas: ciérrala o cancélala en lugar de borrarla.");
    }
    await tx.cohort.delete({ where: { id: cohortId } });
    await recordAudit(tx, { actor, action: "cohort.delete", entityType: "Cohort", entityId: cohortId, before, after: null, note, force: true });
    return { deleted: true };
  });
}
