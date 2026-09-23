// Matrícula en Moodle. Idempotente y segura ante llamadas concurrentes:
//  - Una fila Enrollment por (cliente, curso Moodle) — restricción única — nunca se matricula dos veces.
//  - Cada fila se "reclama" con un UPDATE condicional que pone un lease en nextAttemptAt; solo quien
//    gana el reclamo llama a Moodle para ese curso.
//  - Si Moodle falla: reintentos inmediatos cortos y luego backoff exponencial persistido
//    (nextAttemptAt); el job retryDueEnrollments() los retoma. Tras maxAttempts → FAILED (visible en el panel).
import type { Deps } from "@/server/deps";
import { MINUTE, readSetting, withTx } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";
import { addOrderEvent, PAID_STATES, SYSTEM, transitionOrder, type Actor } from "@/server/orders";
import { SETTING_KEYS } from "@/server/settings";
import { safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";

const LEASE_MS = 2 * MINUTE;

export interface EnrollOrderResult {
  status: "ENROLLED" | "RETRY_SCHEDULED" | "FAILED" | "IN_PROGRESS" | "SKIPPED";
  reason?: string;
  enrolledCourseIds: number[];
  pendingCourseIds: number[];
  createdMoodleUser?: boolean;
}

interface DesiredCourse {
  productId: string;
  moodleCourseId: number;
  orderItemId: string;
  title: string;
}

async function loadOrderForEnrollment(d: Deps, orderId: string) {
  return d.db.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      items: {
        include: {
          reservation: true,
          product: { include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } },
        },
      },
    },
  });
}

/** Cursos Moodle que otorga cada ítem: el curso suelto o todos los cursos del diplomado. */
function desiredCourses(order: NonNullable<Awaited<ReturnType<typeof loadOrderForEnrollment>>>): DesiredCourse[] {
  const out: DesiredCourse[] = [];
  const seen = new Set<number>();
  for (const it of order.items) {
    const courses = it.product.type === "DIPLOMA" ? it.product.diplomaCourses.map((dc) => dc.course) : [it.product];
    if (it.product.type === "DIPLOMA" && courses.length === 0) throw new DomainError("VALIDATION", `El diplomado «${it.productTitle}» no tiene cursos configurados.`);
    for (const c of courses) {
      if (c.moodleCourseId == null) throw new DomainError("VALIDATION", `El curso «${c.title}» no tiene curso de Moodle asociado.`);
      if (seen.has(c.moodleCourseId)) continue;
      seen.add(c.moodleCourseId);
      out.push({ productId: c.id, moodleCourseId: c.moodleCourseId, orderItemId: it.id, title: c.title });
    }
  }
  return out;
}

async function retryPolicy(d: Deps) {
  return readSetting(d.db, SETTING_KEYS.enrollmentRetry, { maxAttempts: 8, baseDelaySeconds: 60 });
}

export async function enrollOrder(d: Deps, orderId: string, opts: { force?: boolean; actor?: Actor } = {}): Promise<EnrollOrderResult> {
  const actor = opts.actor ?? SYSTEM;
  const now = d.now();
  const order = await loadOrderForEnrollment(d, orderId);
  if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
  const empty = { enrolledCourseIds: [], pendingCourseIds: [] };
  if (!PAID_STATES.includes(order.status)) return { status: "SKIPPED", reason: `Pedido en estado ${order.status}`, ...empty };
  for (const it of order.items) {
    if (it.modality === "SEMIPRESENCIAL" && it.reservation?.status !== "CONFIRMED") return { status: "SKIPPED", reason: "Cupo de cohorte sin confirmar", ...empty };
  }

  let desired: DesiredCourse[];
  try {
    desired = desiredCourses(order);
  } catch (e) {
    await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "ENROLLMENT_FAILED", actor, (e as Error).message));
    return { status: "FAILED", reason: (e as Error).message, ...empty };
  }

  // 1) Asegurar filas Enrollment (una por cliente+curso).
  for (const c of desired) {
    const existing = await d.db.enrollment.findUnique({ where: { customerId_moodleCourseId: { customerId: order.customerId, moodleCourseId: c.moodleCourseId } } });
    if (!existing) {
      try {
        await d.db.enrollment.create({ data: { customerId: order.customerId, productId: c.productId, orderId, orderItemId: c.orderItemId, moodleCourseId: c.moodleCourseId, status: "PENDING" } });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    } else if (existing.status === "UNENROLLED" || (existing.status === "FAILED" && opts.force)) {
      await d.db.enrollment.updateMany({
        where: { id: existing.id, status: existing.status },
        data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null, orderId, orderItemId: c.orderItemId },
      });
    }
  }

  // 2) Reclamar las filas pendientes que tocan ahora (lease).
  const lease = new Date(now.getTime() + LEASE_MS);
  const rows = await d.db.enrollment.findMany({ where: { customerId: order.customerId, moodleCourseId: { in: desired.map((c) => c.moodleCourseId) } } });
  const claimed: typeof rows = [];
  for (const r of rows) {
    if (r.status !== "PENDING") continue;
    const n = await d.db.enrollment.updateMany({
      where: { id: r.id, status: "PENDING", ...(opts.force ? {} : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }) },
      data: { nextAttemptAt: lease },
    });
    if (n.count === 1) claimed.push(r);
  }

  if (claimed.length === 0) return finalize(d, orderId, order.customerId, desired, actor, undefined);

  // 3) Usuario Moodle (por email).
  const policy = await retryPolicy(d);
  const courseIds = claimed.map((r) => r.moodleCourseId);
  let userId = order.customer.moodleUserId;
  let tempPassword: string | undefined;
  let created = false;
  let error: unknown = null;
  try {
    if (userId == null) {
      const u = await d.moodle.findOrCreateUser(order.customer.email, { firstname: order.customer.firstName, lastname: order.customer.lastName });
      userId = u.id;
      created = u.created;
      tempPassword = u.created ? u.tempPassword : undefined;
      await d.db.customer.updateMany({ where: { id: order.customerId, moodleUserId: null }, data: { moodleUserId: u.id, moodleUsername: u.username ?? order.customer.email } });
      await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "MOODLE_USER", actor, u.created ? "Cuenta de Moodle creada" : "Cuenta de Moodle existente vinculada", { moodleUserId: u.id, created: u.created }));
    }
    // 4) Matricular con reintentos inmediatos cortos.
    for (let attempt = 0; ; attempt++) {
      try {
        await d.moodle.enrol(userId!, courseIds);
        error = null;
        break;
      } catch (e) {
        error = e;
        if (attempt >= d.config.enrollInlineRetries) break;
        await d.sleep(d.config.enrollInlineDelayMs * 2 ** attempt);
      }
    }
  } catch (e) {
    error = e;
  }

  if (error) {
    const msg = String((error as Error)?.message ?? error).slice(0, 500);
    let worst: "PENDING" | "FAILED" = "PENDING";
    for (const r of claimed) {
      const attempts = r.attempts + 1;
      const failed = attempts >= policy.maxAttempts;
      if (failed) worst = "FAILED";
      await d.db.enrollment.update({
        where: { id: r.id },
        data: {
          attempts,
          lastError: msg,
          status: failed ? "FAILED" : "PENDING",
          nextAttemptAt: failed ? null : new Date(now.getTime() + policy.baseDelaySeconds * 1000 * 2 ** (attempts - 1)),
          moodleUserId: userId ?? null,
        },
      });
    }
    await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "ENROLLMENT_FAILED", actor, `Moodle: ${msg}`, { courseIds, final: worst === "FAILED" }));
    // Si la cuenta se creó ahora, la contraseña temporal no se puede volver a obtener: enviarla ya.
    if (created && tempPassword) await sendAccessEmail(d, orderId, userId!, tempPassword, true, `platform_credentials:${order.customerId}`);
    return { status: worst === "FAILED" ? "FAILED" : "RETRY_SCHEDULED", reason: msg, enrolledCourseIds: [], pendingCourseIds: courseIds, createdMoodleUser: created };
  }

  await d.db.enrollment.updateMany({
    where: { id: { in: claimed.map((r) => r.id) } },
    data: { status: "ENROLLED", enrolledAt: now, moodleUserId: userId!, lastError: null, nextAttemptAt: null, attempts: { increment: 1 } },
  });
  await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "ENROLLMENT", actor, `Matriculado en ${courseIds.length} curso(s) de Moodle`, { courseIds, moodleUserId: userId }));
  return finalize(d, orderId, order.customerId, desired, actor, { userId: userId!, tempPassword });
}

/** Si todas las matrículas del pedido están hechas: pedido → ENROLLED y correos de acceso/cohorte. */
async function finalize(d: Deps, orderId: string, customerId: string, desired: DesiredCourse[], actor: Actor, fresh?: { userId: number; tempPassword?: string }): Promise<EnrollOrderResult> {
  const rows = await d.db.enrollment.findMany({ where: { customerId, moodleCourseId: { in: desired.map((c) => c.moodleCourseId) } } });
  const enrolled = rows.filter((r) => r.status === "ENROLLED").map((r) => r.moodleCourseId);
  const pending = desired.map((c) => c.moodleCourseId).filter((id) => !enrolled.includes(id));
  if (pending.length > 0) {
    const anyFailed = rows.some((r) => r.status === "FAILED");
    return { status: anyFailed ? "FAILED" : "IN_PROGRESS", enrolledCourseIds: enrolled, pendingCourseIds: pending };
  }
  const now = d.now();
  const transitioned = await withTx(d, async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (o.status === "PAID" || o.status === "PARTIALLY_PAID") {
      await transitionOrder(tx, orderId, "ENROLLED", { actor, note: "Matrícula completada en Moodle", patch: { enrolledAt: now } });
      return true;
    }
    return false;
  });
  if (transitioned) {
    const customer = await d.db.customer.findUniqueOrThrow({ where: { id: customerId } });
    await sendAccessEmail(d, orderId, fresh?.userId ?? customer.moodleUserId!, fresh?.tempPassword, false, `platform_access:${orderId}`);
    await sendCohortEmails(d, orderId);
  }
  return { status: "ENROLLED", enrolledCourseIds: enrolled, pendingCourseIds: [] };
}

async function sendAccessEmail(d: Deps, orderId: string, _userId: number, tempPassword: string | undefined, activationPending: boolean, dedupeKey: string) {
  await safeNotify(d, "platform_access", async () => {
    const order = await d.db.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true, items: { include: { product: { include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } } } } } });
    const courses = order.items.flatMap((it) => (it.product.type === "DIPLOMA" ? [`${it.productTitle}:`, ...it.product.diplomaCourses.map((dc) => `  ${dc.course.title}`)] : [it.productTitle]));
    const rendered = T.platformAccess({
      firstName: order.customer.firstName,
      username: order.customer.moodleUsername ?? order.customer.email,
      loginUrl: d.config.moodleLoginUrl,
      tempPassword,
      courses: courses.map((c) => c.trim()),
      activationPending,
    });
    await sendEmail(d, { template: "platform_access", to: order.customer.email, rendered, dedupeKey, orderId, customerId: order.customerId });
  });
}

async function sendCohortEmails(d: Deps, orderId: string) {
  const order = await d.db.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true, items: { include: { cohort: { include: { sede: true } } } } } });
  for (const it of order.items) {
    if (it.modality !== "SEMIPRESENCIAL" || !it.cohort) continue;
    const c = it.cohort;
    await safeNotify(d, "cohort_details", async () => {
      const rendered = T.cohortDetails({
        firstName: order.customer.firstName,
        productTitle: it.productTitle,
        cohortName: c.name,
        sedeName: c.sede.name,
        sedeAddress: c.sede.address,
        startDate: c.startDate,
        endDate: c.endDate,
        sessions: Array.isArray(c.sessions) ? (c.sessions as { date: string; title?: string; startTime?: string; endTime?: string }[]) : [],
        notes: c.notes,
        orderNumber: order.number,
      });
      await sendEmail(d, { template: "cohort_details", to: order.customer.email, rendered, dedupeKey: `cohort_details:${it.id}:${c.id}`, orderId, customerId: order.customerId });
    });
  }
}

/** Reenvío manual de los datos de cohorte (p.ej. tras reasignar). */
export async function resendCohortDetails(d: Deps, orderId: string) {
  await sendCohortEmails(d, orderId);
}

/** Job: reintenta matrículas vencidas y pedidos pagados que quedaron sin matricular. */
export async function retryDueEnrollments(d: Deps): Promise<{ orders: number; enrolled: number }> {
  const now = d.now();
  const due = await d.db.enrollment.findMany({ where: { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }], orderId: { not: null } }, select: { orderId: true }, distinct: ["orderId"] });
  const orphan = await d.db.order.findMany({ where: { status: { in: ["PAID", "PARTIALLY_PAID"] }, enrollments: { none: {} } }, select: { id: true } });
  const ids = [...new Set([...due.map((r) => r.orderId!), ...orphan.map((o) => o.id)])];
  let enrolled = 0;
  for (const id of ids) {
    try {
      if ((await enrollOrder(d, id)).status === "ENROLLED") enrolled++;
    } catch (e) {
      d.log.error(`[enrollment] reintento del pedido ${id} falló`, e);
    }
  }
  return { orders: ids.length, enrolled };
}

/** Rematricular desde el panel: reinicia filas FAILED y reintenta ya. */
export async function reenrollOrder(d: Deps, orderId: string, adminId: string) {
  return enrollOrder(d, orderId, { force: true, actor: { type: "ADMIN", id: adminId } });
}

/**
 * Desmatricula los cursos que otorgó este pedido, salvo los que el cliente conserva por otro pedido
 * vigente (p.ej. compró el curso suelto y también el diplomado).
 */
export async function unenrollOrder(d: Deps, orderId: string, actor: Actor = SYSTEM): Promise<{ unenrolledCourseIds: number[]; keptCourseIds: number[] }> {
  const order = await loadOrderForEnrollment(d, orderId);
  if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
  const courses = desiredCourses(order).map((c) => c.moodleCourseId);
  const others = await d.db.order.findMany({
    where: { customerId: order.customerId, id: { not: orderId }, status: { in: [...PAID_STATES] } },
    include: { items: { include: { product: { include: { diplomaCourses: { include: { course: true } } } } } } },
  });
  const keep = new Set<number>();
  for (const o of others)
    for (const it of o.items) {
      const cs = it.product.type === "DIPLOMA" ? it.product.diplomaCourses.map((dc) => dc.course) : [it.product];
      for (const c of cs) if (c.moodleCourseId != null) keep.add(c.moodleCourseId);
    }
  const rows = await d.db.enrollment.findMany({ where: { customerId: order.customerId, moodleCourseId: { in: courses }, status: { in: ["ENROLLED", "PENDING", "FAILED"] } } });
  const toRemove = rows.filter((r) => !keep.has(r.moodleCourseId));
  const enrolledIds = toRemove.filter((r) => r.status === "ENROLLED").map((r) => r.moodleCourseId);
  const userId = order.customer.moodleUserId;
  if (enrolledIds.length && userId != null) await d.moodle.unenrol(userId, enrolledIds);
  if (toRemove.length) await d.db.enrollment.updateMany({ where: { id: { in: toRemove.map((r) => r.id) } }, data: { status: "UNENROLLED", nextAttemptAt: null } });
  const kept = rows.filter((r) => keep.has(r.moodleCourseId)).map((r) => r.moodleCourseId);
  await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "UNENROLLMENT", actor, `Desmatriculado de ${toRemove.length} curso(s)`, { courseIds: toRemove.map((r) => r.moodleCourseId), kept }));
  return { unenrolledCourseIds: toRemove.map((r) => r.moodleCourseId), keptCourseIds: kept };
}
