// Matrícula en Moodle. Idempotente y segura ante llamadas concurrentes:
//  - Una fila Enrollment por (cliente, curso Moodle) — restricción única — nunca se matricula dos veces.
//  - Cada fila se "reclama" con un UPDATE condicional que pone un lease en nextAttemptAt; solo quien
//    gana el reclamo llama a Moodle para ese curso.
//  - Si Moodle falla: reintentos inmediatos cortos y luego backoff exponencial persistido
//    (nextAttemptAt); el job retryDueEnrollments() los retoma. Tras maxAttempts → FAILED (visible en el panel).
//    Un error PERMANENTE (MoodleError.retryable === false: datos inválidos, token inválido…) pasa a FAILED
//    de inmediato y deja un evento ATTENTION: reintentar no lo arregla.
//  - Qué cursos otorga cada ítem: curso suelto / opción, o los cursos del diplomado. En el plan MES A MES
//    solo los cursos cuya cuota está pagada (Installment.courseId): cada cuota habilita el siguiente curso.
import { Prisma } from "@/generated/prisma/client";
import type { Deps } from "@/server/deps";
import { MINUTE, readSetting, withTx } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";
import { addOrderEvent, PAID_STATES, SYSTEM, transitionOrder, type Actor } from "@/server/orders";
import { SETTING_KEYS } from "@/server/settings";
import { safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import { requireAdmin, type SessionUser } from "@/server/auth";

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
  /** Texto para el correo de acceso ("Curso X — Diplomado Y"). */
  label: string;
}

/** Conflicto de datos local que reintentar no resuelve (p.ej. cuenta Moodle de otro cliente). */
export class PermanentEnrollmentError extends Error {
  readonly retryable = false;
  get short() {
    return this.message;
  }
}

/** Error que no se arregla reintentando (MoodleError.retryable === false). */
export function isPermanentError(e: unknown): boolean {
  const r = (e as { retryable?: unknown } | null)?.retryable;
  return typeof r === "boolean" && !r;
}

async function loadOrderForEnrollment(d: Deps, orderId: string) {
  return d.db.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      items: {
        include: {
          reservation: true,
          choice: true,
          installments: { select: { courseId: true, status: true } },
          courses: { orderBy: { position: "asc" }, include: { course: true } },
          product: { include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } },
        },
      },
    },
  });
}

type CourseLike = { id: string; title: string; moodleCourseId: number | null };
interface ItemLike {
  id?: string;
  productTitle: string;
  planKind?: string | null;
  product: CourseLike & { type: string; diplomaCourses: { course: CourseLike }[] };
  /** Lista de cursos congelada al comprar el diplomado (OrderItemCourse). Vacía solo en pedidos antiguos. */
  courses?: { course: CourseLike }[];
  choice?: { moodleCourseIds: unknown } | null;
  /** Necesario en diplomados mes a mes: qué cursos tienen su cuota pagada. */
  installments?: { courseId: string | null; status: string }[];
}

/**
 * Cursos Moodle que otorga un ítem: los del diplomado, los de la opción elegida (p.ej. "Nivel 1" del
 * taller transfontanelar) o el curso del producto. Diplomado MES A MES: solo los cursos con su cuota
 * pagada (o condonada), salvo `all` (p.ej. para desmatricular todo lo que otorgó el pedido).
 */
/**
 * Cursos de un diplomado COMPRADO: los congelados en el pedido (OrderItemCourse). Si el administrador edita
 * el diplomado después, este cliente conserva el programa que pagó. Pedidos anteriores a la congelación
 * (sin filas) usan la lista actual.
 */
export function purchasedDiplomaCourses<C>(it: { courses?: { course: C }[]; product: { diplomaCourses: { course: C }[] } }): C[] {
  return (it.courses?.length ? it.courses : it.product.diplomaCourses).map((x) => x.course);
}

export function itemMoodleCourses(it: ItemLike, opts: { all?: boolean } = {}): { productId: string; moodleCourseId: number | null; title: string }[] {
  if (it.product.type === "DIPLOMA") {
    let courses = purchasedDiplomaCourses(it).map((c) => ({ productId: c.id, moodleCourseId: c.moodleCourseId, title: c.title }));
    if (!opts.all && it.planKind === "MONTHLY") {
      const paid = new Set((it.installments ?? []).filter((i) => i.courseId && (i.status === "PAID" || i.status === "WAIVED")).map((i) => i.courseId));
      courses = courses.filter((c) => paid.has(c.productId));
    }
    return courses;
  }
  const ids = Array.isArray(it.choice?.moodleCourseIds) ? (it.choice!.moodleCourseIds as unknown[]).filter((x): x is number => Number.isInteger(x)) : [];
  if (ids.length) return ids.map((id) => ({ productId: it.product.id, moodleCourseId: id, title: it.productTitle }));
  return [{ productId: it.product.id, moodleCourseId: it.product.moodleCourseId, title: it.product.title }];
}

/** Cursos Moodle que otorga cada ítem del pedido (sin repetir). */
function desiredCourses(order: NonNullable<Awaited<ReturnType<typeof loadOrderForEnrollment>>>, opts: { all?: boolean } = {}): DesiredCourse[] {
  const out: DesiredCourse[] = [];
  const seen = new Set<number>();
  for (const it of order.items) {
    if (it.product.type === "DIPLOMA" && purchasedDiplomaCourses(it).length === 0) throw new DomainError("VALIDATION", `El diplomado «${it.productTitle}» no tiene cursos configurados.`);
    const courses = itemMoodleCourses(it, opts);
    for (const c of courses) {
      if (c.moodleCourseId == null) throw new DomainError("VALIDATION", `El curso «${c.title}» no tiene curso de Moodle asociado.`);
      if (seen.has(c.moodleCourseId)) continue;
      seen.add(c.moodleCourseId);
      const label = it.product.type === "DIPLOMA" ? `${c.title} — ${it.productTitle}` : it.choice ? `${it.productTitle} — ${it.choice.label}` : it.productTitle;
      out.push({ productId: c.productId, moodleCourseId: c.moodleCourseId, orderItemId: it.id, title: c.title, label });
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
  if (desired.length === 0) return { status: "SKIPPED", reason: "No hay cursos pagados para matricular", ...empty };

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
        // Ciclo de matrícula nuevo: la finalización registrada en el ciclo anterior deja de valer.
        data: { status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null, orderId, orderItemId: c.orderItemId, enrolledAt: null, completedAt: null, completionCheckedAt: null },
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
  let createRequested = false;
  try {
    if (userId == null) {
      const u = await d.moodle.findOrCreateUser(
        order.customer.email,
        { firstname: order.customer.firstName, lastname: order.customer.lastName },
        {
          beforeCreate: async () => {
            createRequested = true;
            await d.db.$transaction((tx) => addOrderEvent(tx, orderId, MOODLE_CREATE_REQUESTED, actor, "Creando la cuenta de Moodle", { email: order.customer.email }));
          },
        },
      );
      created = u.created;
      tempPassword = u.created ? u.tempPassword : undefined;
      // La cuenta Moodle ya pertenece a OTRO cliente (IDs de Moodle reciclados, cuenta compartida…): no se
      // matricula en la cuenta ajena y reintentar no lo arregla → error permanente + ATTENTION.
      const owner = await d.db.customer.findFirst({ where: { moodleUserId: u.id, id: { not: order.customerId } }, select: { email: true } });
      if (owner) throw new PermanentEnrollmentError(`la cuenta de Moodle #${u.id} (${u.username ?? "?"}) ya está vinculada a otro cliente (${owner.email})`);
      let linked: number;
      try {
        linked = (await d.db.customer.updateMany({ where: { id: order.customerId, moodleUserId: null }, data: { moodleUserId: u.id, moodleUsername: u.username ?? order.customer.email } })).count;
      } catch (e) {
        if (isUniqueViolation(e)) throw new PermanentEnrollmentError(`la cuenta de Moodle #${u.id} ya está vinculada a otro cliente`);
        throw e;
      }
      // La cuenta ya existía, pero la creamos NOSOTROS en un intento cuya respuesta se perdió (Moodle la creó y
      // no supimos el resultado): el médico nunca recibió su contraseña. Solo quien la vincula (linked === 1)
      // fija una contraseña temporal nueva; si Moodle no responde, se deshace el vínculo para reintentarlo.
      let recovered = false;
      if (!u.created && linked === 1 && (await ownCreationWithoutCredentials(d, order.customerId, now))) {
        try {
          tempPassword = await d.moodle.resetTempPassword(u.id);
          recovered = true;
        } catch (e) {
          await d.db.customer.updateMany({ where: { id: order.customerId, moodleUserId: u.id }, data: { moodleUserId: null, moodleUsername: null } });
          throw e;
        }
      }
      userId = u.id;
      await d.db.$transaction((tx) =>
        addOrderEvent(
          tx,
          orderId,
          "MOODLE_USER",
          actor,
          u.created ? "Cuenta de Moodle creada" : recovered ? "Cuenta de Moodle creada en un intento anterior sin respuesta: se generó una contraseña temporal nueva" : "Cuenta de Moodle existente vinculada",
          { moodleUserId: u.id, created: u.created, ...(recovered ? { credentialsReset: true } : {}) },
        ),
      );
    }
    // 4) Matricular con reintentos inmediatos cortos.
    for (let attempt = 0; ; attempt++) {
      try {
        await d.moodle.enrol(userId!, courseIds);
        error = null;
        break;
      } catch (e) {
        error = e;
        if (isPermanentError(e) || attempt >= d.config.enrollInlineRetries) break;
        await d.sleep(d.config.enrollInlineDelayMs * 2 ** attempt);
      }
    }
  } catch (e) {
    error = e;
    // core_user_create_users se llamó y no supimos el resultado (timeout, 5xx, respuesta ilegible): la cuenta
    // pudo quedar creada sin que el médico reciba su contraseña. El próximo intento la recupera.
    if (createRequested && userId == null) {
      await d.db.$transaction((tx) => addOrderEvent(tx, orderId, MOODLE_CREATE_UNCONFIRMED, SYSTEM, "Moodle no confirmó la creación de la cuenta; el siguiente intento lo verificará", { email: order.customer.email })).catch(() => {});
    }
  }

  if (error) {
    const msg = String((error as { short?: string })?.short ?? (error as Error)?.message ?? error).slice(0, 500);
    const permanent = isPermanentError(error);
    let worst: "PENDING" | "FAILED" = "PENDING";
    for (const r of claimed) {
      const attempts = r.attempts + 1;
      const failed = permanent || attempts >= policy.maxAttempts;
      if (failed) worst = "FAILED";
      // Solo si sigue PENDING: un reembolso pudo desmatricularla (UNENROLLED) mientras Moodle respondía.
      await d.db.enrollment.updateMany({
        where: { id: r.id, status: "PENDING" },
        data: {
          attempts,
          lastError: msg,
          status: failed ? "FAILED" : "PENDING",
          nextAttemptAt: failed ? null : new Date(now.getTime() + policy.baseDelaySeconds * 1000 * 2 ** (attempts - 1)),
          moodleUserId: userId ?? null,
        },
      });
    }
    await d.db.$transaction(async (tx) => {
      await addOrderEvent(tx, orderId, "ENROLLMENT_FAILED", actor, `Moodle: ${msg}`, { courseIds, final: worst === "FAILED", permanent });
      if (worst === "FAILED") {
        await addOrderEvent(
          tx,
          orderId,
          "ATTENTION",
          SYSTEM,
          permanent
            ? `Moodle rechazó la matrícula (${msg}). Reintentar no lo resuelve: corrige los datos (usuario/correo del cliente, curso) y usa «Rematricular».`
            : `La matrícula en Moodle falló ${policy.maxAttempts} veces (${msg}). Revisa Moodle y usa «Rematricular».`,
          { courseIds },
        );
      }
    });
    // Si la cuenta se creó (o su contraseña se fijó) ahora, la contraseña temporal no se guarda: enviarla ya.
    if (tempPassword && userId != null) await sendAccessEmail(d, orderId, userId, tempPassword, true, `platform_credentials:${order.customerId}`, desired.map((c) => c.label));
    return { status: worst === "FAILED" ? "FAILED" : "RETRY_SCHEDULED", reason: msg, enrolledCourseIds: [], pendingCourseIds: courseIds, createdMoodleUser: created };
  }

  const done = await d.db.enrollment.updateMany({
    where: { id: { in: claimed.map((r) => r.id) }, status: "PENDING" },
    data: { status: "ENROLLED", enrolledAt: now, moodleUserId: userId!, lastError: null, nextAttemptAt: null, attempts: { increment: 1 } },
  });
  if (done.count < claimed.length) {
    // Un reembolso desmatriculó (UNENROLLED) alguna fila mientras Moodle matriculaba: se deshace en Moodle para
    // que el médico reembolsado no conserve el acceso. Si Moodle falla, queda para el job de desmatrículas.
    const undone = await d.db.enrollment.findMany({ where: { id: { in: claimed.map((r) => r.id) }, status: "UNENROLLED" }, select: { moodleCourseId: true } });
    const ids = undone.map((r) => r.moodleCourseId);
    if (ids.length) {
      try {
        await d.moodle.unenrol(userId!, ids);
        await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "UNENROLLMENT", SYSTEM, `Matrícula concurrente con un reembolso deshecha en ${ids.length} curso(s)`, { courseIds: ids }));
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        await d.db.$transaction((tx) => addOrderEvent(tx, orderId, UNENROLLMENT_FAILED, SYSTEM, `No se pudo deshacer en Moodle una matrícula concurrente con un reembolso: ${msg}`, { courseIds: ids, error: msg }));
      }
      if (done.count === 0) return { status: "SKIPPED", reason: "Pedido desmatriculado durante la matrícula", enrolledCourseIds: [], pendingCourseIds: [] };
    }
  }
  await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "ENROLLMENT", actor, `Matriculado en ${courseIds.length} curso(s) de Moodle`, { courseIds, moodleUserId: userId }));
  return finalize(d, orderId, order.customerId, desired, actor, { userId: userId!, tempPassword, newlyEnrolled: courseIds });
}

/**
 * Si todas las matrículas del pedido están hechas: pedido → ENROLLED y correos de acceso/cohorte. Si el
 * pedido ya estaba ENROLLED (mes a mes: se pagó la cuota del siguiente curso), avisa del curso nuevo.
 */
async function finalize(
  d: Deps,
  orderId: string,
  customerId: string,
  desired: DesiredCourse[],
  actor: Actor,
  fresh?: { userId: number; tempPassword?: string; newlyEnrolled?: number[] },
): Promise<EnrollOrderResult> {
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
  const customer = await d.db.customer.findUniqueOrThrow({ where: { id: customerId } });
  if (transitioned) {
    await sendAccessEmail(d, orderId, fresh?.userId ?? customer.moodleUserId!, fresh?.tempPassword, false, `platform_access:${orderId}`, desired.map((c) => c.label));
    await sendCohortEmails(d, orderId);
  } else if (fresh?.newlyEnrolled?.length) {
    const ids = [...fresh.newlyEnrolled].sort((a, b) => a - b);
    const labels = desired.filter((c) => ids.includes(c.moodleCourseId)).map((c) => c.label);
    await sendAccessEmail(d, orderId, fresh.userId, fresh.tempPassword, false, `course_access:${orderId}:${ids.join(",")}`, labels);
  }
  return { status: "ENROLLED", enrolledCourseIds: enrolled, pendingCourseIds: [] };
}

/** Intento de alta en Moodle (antes de core_user_create_users) y alta sin confirmar (respuesta perdida). */
export const MOODLE_CREATE_REQUESTED = "MOODLE_USER_CREATE_REQUESTED";
export const MOODLE_CREATE_UNCONFIRMED = "MOODLE_USER_CREATE_UNCONFIRMED";

/**
 * ¿La cuenta Moodle que encontramos la creamos nosotros sin entregar nunca la contraseña? Sí cuando:
 *  - la app no la genera Moodle (modo "moodle-email": Moodle ya envió las credenciales al crearla);
 *  - hubo un core_user_create_users nuestro para este cliente cuyo resultado no conocimos: marcado como sin
 *    confirmar, o pedido hace más que el lease (el proceso murió a mitad). Un alta EN CURSO de otra llamada
 *    no cuenta: esa llamada recibirá la contraseña y la enviará;
 *  - nunca se le envió un correo de acceso con contraseña temporal.
 * Una cuenta que ya existía antes (alta manual, otra plataforma) nunca pasa por core_user_create_users, así
 * que su contraseña no se toca.
 */
async function ownCreationWithoutCredentials(d: Deps, customerId: string, now: Date): Promise<boolean> {
  if (d.moodle.sendsOwnCredentials) return false;
  const marker = await d.db.orderEvent.findFirst({
    where: {
      order: { customerId },
      OR: [{ type: MOODLE_CREATE_UNCONFIRMED }, { type: MOODLE_CREATE_REQUESTED, createdAt: { lte: new Date(now.getTime() - LEASE_MS) } }],
    },
    select: { id: true },
  });
  if (!marker) return false;
  const delivered = await d.db.emailOutbox.findFirst({ where: { customerId, template: "platform_access", secretRef: { not: Prisma.DbNull } }, select: { id: true } });
  return !delivered;
}

async function sendAccessEmail(d: Deps, orderId: string, userId: number, tempPassword: string | undefined, activationPending: boolean, dedupeKey: string, courses: string[]) {
  await safeNotify(d, "platform_access", async () => {
    const order = await d.db.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
    const rendered = T.platformAccess({
      firstName: order.customer.firstName,
      username: order.customer.moodleUsername ?? order.customer.email,
      loginUrl: d.config.moodleLoginUrl,
      tempPassword,
      courses,
      activationPending,
    });
    // La contraseña temporal solo viaja en el correo: la bandeja guarda un marcador (ver sendEmail).
    await sendEmail(d, {
      template: "platform_access",
      to: order.customer.email,
      rendered,
      dedupeKey,
      orderId,
      customerId: order.customerId,
      secret: tempPassword ? { kind: "moodle_temp_password", moodleUserId: userId, value: tempPassword } : undefined,
    });
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
  // Mes a mes: cuotas pagadas cuyo curso aún no tiene fila de matrícula (p.ej. el proceso se cortó).
  const paidIns = await d.db.installment.findMany({
    where: { status: { in: ["PAID", "WAIVED"] }, moodleCourseId: { not: null }, order: { status: { in: [...PAID_STATES] } } },
    select: { orderId: true, moodleCourseId: true, order: { select: { customerId: true } } },
  });
  const unlocked: string[] = [];
  for (const i of paidIns) {
    const enr = await d.db.enrollment.findUnique({ where: { customerId_moodleCourseId: { customerId: i.order.customerId, moodleCourseId: i.moodleCourseId! } }, select: { status: true } });
    if (!enr || enr.status === "UNENROLLED") unlocked.push(i.orderId);
  }
  const ids = [...new Set([...due.map((r) => r.orderId!), ...orphan.map((o) => o.id), ...unlocked])];
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
export async function reenrollOrder(d: Deps, actor: SessionUser, orderId: string) {
  const admin = await requireAdmin(d.db, actor, "enrollments.manage");
  return enrollOrder(d, orderId, { force: true, actor: { type: "ADMIN", id: admin.id } });
}

/** Desmatricular desde el panel (unenrollOrder es interno: lo usan los reembolsos con su propio actor). */
export async function adminUnenrollOrder(d: Deps, actor: SessionUser, orderId: string) {
  const admin = await requireAdmin(d.db, actor, "enrollments.manage");
  return unenrollOrder(d, orderId, { type: "ADMIN", id: admin.id });
}

/**
 * Desmatricula los cursos que otorgó este pedido, salvo los que el cliente conserva por otro pedido
 * vigente (p.ej. compró el curso suelto y también el diplomado).
 */
export async function unenrollOrder(d: Deps, orderId: string, actor: Actor = SYSTEM): Promise<{ unenrolledCourseIds: number[]; keptCourseIds: number[] }> {
  const order = await loadOrderForEnrollment(d, orderId);
  if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
  const courses = desiredCourses(order, { all: true }).map((c) => c.moodleCourseId);
  const others = await d.db.order.findMany({
    where: { customerId: order.customerId, id: { not: orderId }, status: { in: [...PAID_STATES] } },
    include: { items: { include: { choice: true, installments: { select: { courseId: true, status: true } }, courses: { orderBy: { position: "asc" }, include: { course: true } }, product: { include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: true } } } } } } },
  });
  const keep = new Set<number>();
  for (const o of others)
    for (const it of o.items) for (const c of itemMoodleCourses(it)) if (c.moodleCourseId != null) keep.add(c.moodleCourseId);
  const rows = await d.db.enrollment.findMany({ where: { customerId: order.customerId, moodleCourseId: { in: courses }, status: { in: ["ENROLLED", "PENDING", "FAILED"] } } });
  const toRemove = rows.filter((r) => !keep.has(r.moodleCourseId));
  // No solo las ENROLLED: una fila PENDING/FAILED puede estar matriculada en Moodle aunque la app no lo sepa
  // (Moodle ejecutó enrol_manual_enrol_users y la respuesta se perdió, o un intento sigue en curso). Desmatricular
  // a quien no está matriculado es inocuo en Moodle, así que se piden también las que ya se intentaron.
  const unenrolIds = toRemove.filter((r) => r.status === "ENROLLED" || r.attempts > 0 || r.nextAttemptAt != null).map((r) => r.moodleCourseId);
  const userId = order.customer.moodleUserId;
  if (unenrolIds.length && userId != null) await d.moodle.unenrol(userId, unenrolIds);
  if (toRemove.length) await d.db.enrollment.updateMany({ where: { id: { in: toRemove.map((r) => r.id) } }, data: { status: "UNENROLLED", nextAttemptAt: null, completedAt: null, completionCheckedAt: null } });
  const kept = rows.filter((r) => keep.has(r.moodleCourseId)).map((r) => r.moodleCourseId);
  await d.db.$transaction((tx) => addOrderEvent(tx, orderId, "UNENROLLMENT", actor, `Desmatriculado de ${toRemove.length} curso(s)`, { courseIds: toRemove.map((r) => r.moodleCourseId), kept }));
  return { unenrolledCourseIds: toRemove.map((r) => r.moodleCourseId), keptCourseIds: kept };
}

/** Evento del pedido: la desmatrícula pedida (reembolso) falló en Moodle; el job la reintenta. */
export const UNENROLLMENT_FAILED = "UNENROLLMENT_FAILED";

/**
 * Job: reintenta las desmatrículas que fallaron (Moodle caído o lento al reembolsar). Sin esto el médico
 * reembolsado conservaría el acceso al aula para siempre. Un pedido se reintenta mientras no haya, después de
 * su último fallo, una desmatrícula (hecha) ni una matrícula (el panel lo volvió a matricular a propósito).
 */
export async function retryFailedUnenrollments(d: Deps): Promise<{ orders: number; unenrolled: number }> {
  const since = new Date(d.now().getTime() - 30 * 24 * 60 * MINUTE);
  const fails = await d.db.orderEvent.findMany({ where: { type: UNENROLLMENT_FAILED, createdAt: { gte: since } }, select: { orderId: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  const latest = new Map<string, Date>();
  for (const f of fails) if (!latest.has(f.orderId)) latest.set(f.orderId, f.createdAt);
  let orders = 0;
  let unenrolled = 0;
  for (const [orderId, at] of latest) {
    const settled = await d.db.orderEvent.count({ where: { orderId, type: { in: ["UNENROLLMENT", "ENROLLMENT"] }, createdAt: { gt: at } } });
    if (settled > 0) continue;
    orders++;
    try {
      await unenrollOrder(d, orderId, SYSTEM);
      unenrolled++;
    } catch (e) {
      d.log.warn(`[enrollment] reintento de desmatrícula del pedido ${orderId} falló; se volverá a intentar`, e);
    }
  }
  return { orders, unenrolled };
}
