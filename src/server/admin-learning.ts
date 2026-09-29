// Panel · Matrículas, progreso en Moodle y certificados (pieza a4): lecturas del Inicio, del índice de
// matrículas, de certificados y de la ficha del cliente, y las acciones que las acompañan (consultar el progreso
// en Moodle, reintentar matrículas, revisar/reenviar/revocar certificados, nota del cliente).
// Toda función recibe el SessionUser y verifica rol + usuario activo con requireAdmin: lectura = orders.view,
// Moodle = enrollments.manage, correo = emails.resend, revocar = certificates.revoke (en revokeCertificate).
import fs from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@/generated/prisma/client";
import type { Deps } from "@/server/deps";
import { withTx } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { purchasedDiplomaCourses, reenrollOrder } from "@/server/enrollment";
import { checkDiplomaCompletion, deliverCertificate, runCertificateSweep } from "@/server/certificates";
import { resendEmail } from "@/server/email";
import { at, code, CSV_MAX_ROWS, money, type CsvCell } from "@/server/csv";

type ReadDeps = Pick<Deps, "db" | "now">;
const DAY = 86_400_000;
/** Días de Caracas (UTC−4, sin horario de verano). */
const caracasDay = (t: Date) => Math.floor((t.getTime() - 4 * 3_600_000) / DAY);
const dayStart = (day: number) => new Date(day * DAY + 4 * 3_600_000);
/** Pedidos cuyo programa está vigente (dan acceso a cursos). */
const LIVE = ["PAID", "PARTIALLY_PAID", "ENROLLED"] as const;

// ───────────────────────── Estado de una matrícula ─────────────────────────

/** Estado visible de una matrícula: Moodle solo informa «completado» por curso. */
export type EnrollmentState = "COMPLETED" | "IN_PROGRESS" | "PENDING" | "FAILED" | "UNENROLLED";
export function enrollmentState(e: { status: string; completedAt: Date | null; enrolledAt: Date | null }): EnrollmentState {
  if (e.status === "ENROLLED") return e.completedAt && (!e.enrolledAt || e.completedAt >= e.enrolledAt) ? "COMPLETED" : "IN_PROGRESS";
  if (e.status === "FAILED") return "FAILED";
  if (e.status === "UNENROLLED") return "UNENROLLED";
  return "PENDING";
}

export const ENROLLMENT_VIEWS = {
  ALL: { label: "Todas", where: {} },
  IN_PROGRESS: { label: "En curso", where: { status: "ENROLLED", completedAt: null } },
  COMPLETED: { label: "Completadas", where: { status: "ENROLLED", completedAt: { not: null } } },
  PENDING: { label: "Pendientes", where: { status: "PENDING" } },
  FAILED: { label: "Con error", where: { status: "FAILED" } },
  UNENROLLED: { label: "Desmatriculadas", where: { status: "UNENROLLED" } },
} satisfies Record<string, { label: string; where: Prisma.EnrollmentWhereInput }>;
export type EnrollmentView = keyof typeof ENROLLMENT_VIEWS;

export const ENROLLMENT_SORTS = { recent: "Matrícula", student: "Médico", course: "Curso", checked: "Última consulta" } as const;
export type EnrollmentSort = keyof typeof ENROLLMENT_SORTS;

export interface EnrollmentIndexQuery {
  view?: EnrollmentView;
  q?: string;
  /** Programa: id de un diplomado (sus cursos) o de un curso. */
  program?: string;
  sort?: EnrollmentSort;
  dir?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

async function programFilter(d: ReadDeps, program?: string): Promise<Prisma.EnrollmentWhereInput> {
  if (!program) return {};
  const p = await d.db.product.findUnique({ where: { id: program }, select: { type: true } });
  if (!p) return { id: "__none__" };
  // Diplomado: matrículas originadas por una compra del diplomado.
  return p.type === "DIPLOMA" ? { orderItem: { productId: program } } : { productId: program };
}

function searchFilter(q?: string): Prisma.EnrollmentWhereInput {
  const s = q?.trim();
  if (!s) return {};
  const n = Number(s.replace(/^#/, ""));
  return {
    OR: [
      { customer: { email: { contains: s.toLowerCase() } } },
      { customer: { firstName: { contains: s } } },
      { customer: { lastName: { contains: s } } },
      { customer: { cedula: { contains: s } } },
      { product: { title: { contains: s } } },
      ...(Number.isInteger(n) && n > 0 ? [{ moodleCourseId: n }, { order: { number: n } }] : []),
    ],
  };
}

function enrollmentOrderBy(query: Pick<EnrollmentIndexQuery, "sort" | "dir">): Prisma.EnrollmentOrderByWithRelationInput[] {
  const dir = query.dir === "asc" ? "asc" : "desc";
  const by: Prisma.EnrollmentOrderByWithRelationInput[] =
    query.sort === "student" ? [{ customer: { firstName: dir } }, { customer: { lastName: dir } }]
    : query.sort === "course" ? [{ product: { title: dir } }]
    : query.sort === "checked" ? [{ completionCheckedAt: dir }]
    : [{ createdAt: dir }];
  return [...by, { id: "asc" }];
}

export async function listEnrollmentsIndex(d: ReadDeps, user: SessionUser, query: EnrollmentIndexQuery = {}) {
  await requireAdmin(d.db, user, "orders.view");
  const view: EnrollmentView = query.view && query.view in ENROLLMENT_VIEWS ? query.view : "ALL";
  const base: Prisma.EnrollmentWhereInput = { AND: [searchFilter(query.q), await programFilter(d, query.program)] };
  const where: Prisma.EnrollmentWhereInput = { AND: [base, ENROLLMENT_VIEWS[view].where] };
  const perPage = Math.min(Math.max(query.perPage ?? 50, 5), 200);
  const orderBy = enrollmentOrderBy(query);
  const total = await d.db.enrollment.count({ where });
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const [rows, counts, programs] = await Promise.all([
    d.db.enrollment.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true, moodleUserId: true } },
        product: { select: { id: true, title: true, slug: true } },
        order: { select: { id: true, number: true, status: true, balanceCents: true } },
        orderItem: { select: { productId: true, productTitle: true, productType: true, planKind: true } },
      },
    }),
    Promise.all((Object.keys(ENROLLMENT_VIEWS) as EnrollmentView[]).map(async (k) => [k, await d.db.enrollment.count({ where: { AND: [base, ENROLLMENT_VIEWS[k].where] } })] as const)),
    d.db.product.findMany({
      where: { OR: [{ type: "DIPLOMA", orderItems: { some: { enrollments: { some: {} } } } }, { type: "COURSE", enrollments: { some: {} } }] },
      orderBy: [{ type: "desc" }, { title: "asc" }],
      select: { id: true, title: true, type: true },
    }),
  ]);
  return {
    view,
    total,
    page,
    pages,
    perPage,
    counts: Object.fromEntries(counts) as Record<EnrollmentView, number>,
    programs,
    rows: rows.map((e) => ({
      id: e.id,
      state: enrollmentState(e),
      status: e.status,
      customer: { id: e.customer.id, name: `${e.customer.firstName} ${e.customer.lastName}`.trim(), email: e.customer.email, moodleUserId: e.customer.moodleUserId },
      course: e.product,
      moodleCourseId: e.moodleCourseId,
      program: e.orderItem?.productType === "DIPLOMA" ? { id: e.orderItem.productId, title: e.orderItem.productTitle, monthly: e.orderItem.planKind === "MONTHLY" } : null,
      order: e.order ? { id: e.order.id, number: e.order.number, status: e.order.status } : null,
      attempts: e.attempts,
      lastError: e.lastError,
      nextAttemptAt: e.nextAttemptAt,
      enrolledAt: e.enrolledAt,
      completedAt: e.completedAt,
      completionCheckedAt: e.completionCheckedAt,
      createdAt: e.createdAt,
    })),
  };
}
export type EnrollmentRow = Awaited<ReturnType<typeof listEnrollmentsIndex>>["rows"][number];

/** Cabecera de Matrículas: activas, completadas en 30 días, con error, pendientes, tasa de finalización. */
export async function enrollmentMetrics(d: ReadDeps, user: SessionUser) {
  await requireAdmin(d.db, user, "orders.view");
  const since = new Date(d.now().getTime() - 30 * DAY);
  const [active, completed, completed30, failed, pending, students, stale] = await Promise.all([
    d.db.enrollment.count({ where: { status: "ENROLLED" } }),
    d.db.enrollment.count({ where: { status: "ENROLLED", completedAt: { not: null } } }),
    d.db.enrollment.count({ where: { status: "ENROLLED", completedAt: { gte: since } } }),
    d.db.enrollment.count({ where: { status: "FAILED" } }),
    d.db.enrollment.count({ where: { status: "PENDING" } }),
    d.db.enrollment.groupBy({ by: ["customerId"], where: { status: "ENROLLED" } }).then((r) => r.length),
    d.db.enrollment.count({ where: { status: "ENROLLED", completedAt: null, OR: [{ completionCheckedAt: null }, { completionCheckedAt: { lt: new Date(d.now().getTime() - DAY) } }] } }),
  ]);
  return { active, completed, completed30, failed, pending, students, stale, rate: active ? completed / active : 0 };
}

// ───────────────────────── Acciones sobre matrículas ─────────────────────────

export interface ProgressRefreshResult {
  checked: number;
  completed: number;
  newlyCompleted: number;
  errors: number;
  skipped: number;
  certificatesIssued: string[];
}

/**
 * Consulta en Moodle (core_completion_get_course_completion_status) la finalización de las matrículas dadas y
 * guarda el resultado. Después revisa los diplomados afectados: si el cliente completó todos los cursos y no
 * debe nada, checkDiplomaCompletion emite el certificado (nunca antes).
 */
export async function refreshEnrollmentProgress(d: Deps, user: SessionUser, enrollmentIds: string[]): Promise<ProgressRefreshResult> {
  await requireAdmin(d.db, user, "enrollments.manage");
  const ids = [...new Set(enrollmentIds)].slice(0, 500);
  const rows = await d.db.enrollment.findMany({
    where: { id: { in: ids } },
    include: { customer: { select: { id: true, moodleUserId: true } }, orderItem: { select: { productId: true, productType: true } } },
  });
  const out: ProgressRefreshResult = { checked: 0, completed: 0, newlyCompleted: 0, errors: 0, skipped: 0, certificatesIssued: [] };
  const diplomas = new Map<string, { customerId: string; diplomaId: string }>();
  const now = d.now();
  for (const e of rows) {
    const userId = e.moodleUserId ?? e.customer.moodleUserId;
    if (e.status !== "ENROLLED" || userId == null) {
      out.skipped++;
      continue;
    }
    try {
      const { completed } = await d.moodle.getCompletion(userId, e.moodleCourseId);
      out.checked++;
      const wasDone = enrollmentState(e) === "COMPLETED";
      if (completed) out.completed++;
      if (completed && !wasDone) out.newlyCompleted++;
      await d.db.enrollment.update({ where: { id: e.id }, data: { completionCheckedAt: now, completedAt: completed ? (wasDone ? e.completedAt : now) : null } });
      if (e.orderItem?.productType === "DIPLOMA") diplomas.set(`${e.customerId}:${e.orderItem.productId}`, { customerId: e.customerId, diplomaId: e.orderItem.productId });
    } catch (err) {
      out.errors++;
      d.log.warn(`[admin-learning] no se pudo consultar el progreso de ${e.id}`, err);
    }
  }
  for (const p of diplomas.values()) {
    try {
      const r = await checkDiplomaCompletion(d, p.customerId, p.diplomaId);
      if (r.issued && !r.alreadyIssued && r.code) out.certificatesIssued.push(r.code);
    } catch (err) {
      d.log.warn(`[admin-learning] no se pudo revisar el diplomado ${p.diplomaId} de ${p.customerId}`, err);
    }
  }
  return out;
}

/** Reintenta en Moodle las matrículas de los pedidos a los que pertenecen las filas dadas (reenrollOrder). */
export async function retryEnrollments(d: Deps, user: SessionUser, enrollmentIds: string[]) {
  await requireAdmin(d.db, user, "enrollments.manage");
  const rows = await d.db.enrollment.findMany({ where: { id: { in: enrollmentIds.slice(0, 500) } }, select: { orderId: true, orderItem: { select: { orderId: true } } } });
  const orderIds = [...new Set(rows.map((r) => r.orderId ?? r.orderItem?.orderId).filter((x): x is string => !!x))];
  let enrolled = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const id of orderIds) {
    try {
      const r = await reenrollOrder(d, user, id);
      enrolled += r.enrolledCourseIds?.length ?? 0;
      if (r.status === "FAILED" || r.status === "RETRY_SCHEDULED") failed++;
    } catch (e) {
      failed++;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { orders: orderIds.length, enrolled, failed, errors };
}

// ───────────────────────── Certificados ─────────────────────────

export const CERTIFICATE_VIEWS = {
  ISSUED: "Emitidos",
  IN_PROGRESS: "En curso",
  BLOCKED: "Bloqueados por saldo",
  REVOKED: "Revocados",
} as const;
export type CertificateView = keyof typeof CERTIFICATE_VIEWS;

interface DiplomaPurchase {
  orderItemId: string;
  orderId: string;
  orderNumber: number;
  balanceCents: number;
  customer: { id: string; name: string; email: string };
  diploma: { id: string; title: string };
  monthly: boolean;
  courses: { id: string; title: string; moodleCourseId: number | null; state: EnrollmentState | "LOCKED" }[];
  completed: number;
  total: number;
  lastCheckedAt: Date | null;
}

/** Compras vigentes de diplomados sin certificado, con el avance guardado (sin llamar a Moodle). */
async function diplomaPurchasesWithoutCertificate(d: ReadDeps, where: Prisma.OrderItemWhereInput = {}): Promise<DiplomaPurchase[]> {
  const items = await d.db.orderItem.findMany({
    where: { AND: [where, { productType: "DIPLOMA", order: { status: { in: [...LIVE] } } }] },
    orderBy: { order: { placedAt: "desc" } },
    include: {
      order: { select: { id: true, number: true, balanceCents: true, customer: { select: { id: true, firstName: true, lastName: true, email: true, certificates: { select: { diplomaId: true } } } } } },
      courses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, title: true, moodleCourseId: true } } } },
      product: { select: { id: true, title: true, diplomaCourses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, title: true, moodleCourseId: true } } } } } },
    },
  });
  const pending = items.filter((it) => !it.order.customer.certificates.some((c) => c.diplomaId === it.productId));
  const customerIds = [...new Set(pending.map((it) => it.order.customer.id))];
  const enrollments = customerIds.length
    ? await d.db.enrollment.findMany({ where: { customerId: { in: customerIds } }, select: { customerId: true, moodleCourseId: true, status: true, completedAt: true, enrolledAt: true, completionCheckedAt: true } })
    : [];
  const byKey = new Map(enrollments.map((e) => [`${e.customerId}:${e.moodleCourseId}`, e]));
  // Un cliente con dos compras del mismo diplomado: se muestra una sola fila (la más reciente).
  const seen = new Set<string>();
  const out: DiplomaPurchase[] = [];
  for (const it of pending) {
    const key = `${it.order.customer.id}:${it.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let last: Date | null = null;
    const courses = purchasedDiplomaCourses({ courses: it.courses, product: it.product }).map((c) => {
      const e = c.moodleCourseId != null ? byKey.get(`${it.order.customer.id}:${c.moodleCourseId}`) : undefined;
      if (e?.completionCheckedAt && (!last || e.completionCheckedAt > last)) last = e.completionCheckedAt;
      return { id: c.id, title: c.title, moodleCourseId: c.moodleCourseId, state: e ? enrollmentState(e) : ("LOCKED" as const) };
    });
    out.push({
      orderItemId: it.id,
      orderId: it.order.id,
      orderNumber: it.order.number,
      balanceCents: it.order.balanceCents,
      customer: { id: it.order.customer.id, name: `${it.order.customer.firstName} ${it.order.customer.lastName}`.trim(), email: it.order.customer.email },
      diploma: { id: it.product.id, title: it.productTitle },
      monthly: it.planKind === "MONTHLY",
      courses,
      completed: courses.filter((c) => c.state === "COMPLETED").length,
      total: courses.length,
      lastCheckedAt: last,
    });
  }
  return out;
}

function customerSearch(q?: string) {
  const s = q?.trim();
  if (!s) return null;
  return (x: { customer: { name: string; email: string }; diploma: { title: string }; code?: string }) => {
    const t = s.toLowerCase();
    return x.customer.name.toLowerCase().includes(t) || x.customer.email.includes(t) || x.diploma.title.toLowerCase().includes(t) || (x.code ?? "").toLowerCase().includes(t);
  };
}

export async function listCertificatesIndex(d: ReadDeps, user: SessionUser, query: { view?: CertificateView; q?: string; diploma?: string } = {}) {
  await requireAdmin(d.db, user, "orders.view");
  const view: CertificateView = query.view && query.view in CERTIFICATE_VIEWS ? query.view : "ISSUED";
  const certs = await d.db.certificate.findMany({
    where: query.diploma ? { diplomaId: query.diploma } : {},
    orderBy: [{ issuedAt: "desc" }, { id: "asc" }],
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      diploma: { select: { id: true, title: true } },
      orderItem: { select: { order: { select: { id: true, number: true } } } },
    },
  });
  const emails = certs.length
    ? await d.db.emailOutbox.findMany({ where: { template: "certificate_issued", customerId: { in: [...new Set(certs.map((c) => c.customerId))] } }, orderBy: { createdAt: "desc" }, select: { id: true, dedupeKey: true, status: true, customerId: true, createdAt: true, sentAt: true } })
    : [];
  const purchases = await diplomaPurchasesWithoutCertificate(d, query.diploma ? { productId: query.diploma } : {});
  const match = customerSearch(query.q);
  const certRows = certs.map((c) => ({
    id: c.id,
    code: c.code,
    status: c.status,
    customer: { id: c.customer.id, name: `${c.customer.firstName} ${c.customer.lastName}`.trim(), email: c.customer.email },
    diploma: c.diploma,
    order: c.orderItem?.order ?? null,
    issuedAt: c.issuedAt,
    hasPdf: !!c.pdfPath,
    emailedAt: c.emailedAt,
    lastEmail: emails.find((m) => m.dedupeKey === `certificate:${c.id}`) ?? null,
    revokedAt: c.revokedAt,
    revokeReason: c.revokeReason,
  }));
  const issued = certRows.filter((c) => c.status === "ISSUED");
  const revoked = certRows.filter((c) => c.status === "REVOKED");
  const blocked = purchases.filter((p) => p.total > 0 && p.completed === p.total && p.balanceCents > 0);
  const inProgress = purchases.filter((p) => !(p.total > 0 && p.completed === p.total && p.balanceCents > 0));
  const f = <T extends { customer: { name: string; email: string }; diploma: { title: string }; code?: string }>(xs: T[]) => (match ? xs.filter(match) : xs);
  const diplomas = await d.db.product.findMany({ where: { type: "DIPLOMA" }, orderBy: { title: "asc" }, select: { id: true, title: true } });
  return {
    view,
    counts: { ISSUED: issued.length, IN_PROGRESS: inProgress.length, BLOCKED: blocked.length, REVOKED: revoked.length } as Record<CertificateView, number>,
    certificates: f(view === "REVOKED" ? revoked : issued),
    purchases: f(view === "BLOCKED" ? blocked : inProgress),
    diplomas,
    stats: {
      issued30: issued.filter((c) => c.issuedAt.getTime() >= d.now().getTime() - 30 * DAY).length,
      undelivered: issued.filter((c) => !c.hasPdf || !c.emailedAt).length,
      nearlyDone: inProgress.filter((p) => p.total > 0 && p.total - p.completed === 1).length,
    },
  };
}
export type CertificatesIndex = Awaited<ReturnType<typeof listCertificatesIndex>>;

/** «Revisar ahora»: consulta Moodle para un cliente + diplomado y emite el certificado si corresponde. */
export async function checkCertificateNow(d: Deps, user: SessionUser, customerId: string, diplomaId: string) {
  await requireAdmin(d.db, user, "enrollments.manage");
  return checkDiplomaCompletion(d, customerId, diplomaId);
}

/** «Revisar todos»: el mismo barrido del job (consulta Moodle y emite lo que corresponda), a pedido del panel. */
export async function runCertificateSweepNow(d: Deps, user: SessionUser) {
  await requireAdmin(d.db, user, "enrollments.manage");
  return runCertificateSweep(d);
}

/** Reenvía el certificado: completa la entrega si quedó a medias o reenvía el último correo con el PDF. */
export async function resendCertificate(d: Deps, user: SessionUser, certificateId: string) {
  await requireAdmin(d.db, user, "emails.resend");
  const cert = await d.db.certificate.findUnique({ where: { id: certificateId } });
  if (!cert) throw new DomainError("NOT_FOUND", "El certificado no existe.");
  if (cert.status !== "ISSUED") throw new DomainError("INVALID_STATE", "El certificado está revocado: no se puede reenviar.");
  if (!cert.pdfPath || !cert.emailedAt) {
    const r = await deliverCertificate(d, cert.id);
    if (!r.emailed) throw new DomainError("INVALID_STATE", r.error ? `No se pudo entregar: ${r.error}` : "No se pudo enviar el correo; se reintentará automáticamente.");
    return { status: "SENT" as const };
  }
  const row = await d.db.emailOutbox.findFirst({ where: { dedupeKey: `certificate:${cert.id}` } });
  if (!row) throw new DomainError("NOT_FOUND", "No encontramos el correo original del certificado.");
  const r = await resendEmail(d, user, row.id);
  if (r.status !== "SENT") throw new DomainError("INVALID_STATE", "El correo quedó en cola; se reintentará automáticamente.");
  return { status: r.status };
}

/** PDF del certificado para el panel (solo archivos bajo CERTIFICATES_DIR). Lo genera si falta. */
export async function readCertificatePdf(d: Deps, user: SessionUser, certificateId: string) {
  await requireAdmin(d.db, user, "orders.view");
  let cert = await d.db.certificate.findUnique({ where: { id: certificateId } });
  if (!cert) throw new DomainError("NOT_FOUND", "El certificado no existe.");
  const exists = async (p: string | null) => (p ? fs.stat(path.resolve(/*turbopackIgnore: true*/ p)).then(() => true, () => false) : false);
  if (cert.status === "ISSUED" && !(await exists(cert.pdfPath))) {
    await deliverCertificate(d, cert.id);
    cert = await d.db.certificate.findUniqueOrThrow({ where: { id: certificateId } });
  }
  if (!cert.pdfPath || !(await exists(cert.pdfPath))) throw new DomainError("NOT_FOUND", "El PDF del certificado no está disponible.");
  const root = path.resolve(/*turbopackIgnore: true*/ d.config.certificatesDir);
  const file = path.resolve(/*turbopackIgnore: true*/ cert.pdfPath);
  if (!file.startsWith(root + path.sep)) throw new DomainError("NOT_FOUND", "El PDF del certificado no está disponible.");
  return { code: cert.code, status: cert.status, bytes: await fs.readFile(file) };
}

// ───────────────────────── Ficha del cliente ─────────────────────────

export async function getCustomerDetail(d: ReadDeps & Pick<Deps, "config">, user: SessionUser, customerId: string) {
  await requireAdmin(d.db, user, "orders.view");
  const c = await d.db.customer.findUnique({
    where: { id: customerId },
    include: {
      orders: {
        orderBy: { placedAt: "desc" },
        include: {
          items: {
            include: {
              product: { select: { id: true, slug: true, type: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true, alt: true } }, diplomaCourses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, title: true, moodleCourseId: true } } } } } },
              courses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, title: true, moodleCourseId: true } } } },
              cohort: { select: { name: true, startDate: true, endDate: true } },
              sede: { select: { name: true } },
              choice: { select: { label: true } },
            },
          },
          installments: { orderBy: { sequence: "asc" }, select: { id: true, sequence: true, courseId: true, status: true, amountCents: true, paidCents: true, dueDate: true } },
          events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 80, include: { actor: { select: { name: true, email: true } } } },
        },
      },
      enrollments: { include: { product: { select: { id: true, title: true } } } },
      certificates: { orderBy: { issuedAt: "desc" }, include: { diploma: { select: { id: true, title: true } } } },
      emails: { orderBy: { createdAt: "desc" }, take: 12, select: { id: true, template: true, subject: true, status: true, createdAt: true, sentAt: true, orderId: true } },
    },
  });
  if (!c) throw new DomainError("NOT_FOUND", "El cliente no existe.");
  const [prev, next] = await Promise.all([
    d.db.customer.findFirst({ where: { createdAt: { gt: c.createdAt } }, orderBy: { createdAt: "asc" }, select: { id: true } }),
    d.db.customer.findFirst({ where: { createdAt: { lt: c.createdAt } }, orderBy: { createdAt: "desc" }, select: { id: true } }),
  ]);
  const enrByCourse = new Map(c.enrollments.map((e) => [e.moodleCourseId, e]));
  const usedEnrollments = new Set<string>();
  const live = c.orders.filter((o) => (LIVE as readonly string[]).includes(o.status));

  // Programas del cliente: un diplomado por compra (cursos congelados) y los cursos sueltos.
  const programs = live.flatMap((o) =>
    o.items.map((it) => {
      const isDiploma = it.productType === "DIPLOMA";
      const list = isDiploma
        ? purchasedDiplomaCourses({ courses: it.courses, product: it.product })
        : c.enrollments.filter((e) => e.orderItemId === it.id).map((e) => ({ id: e.product.id, title: e.product.title, moodleCourseId: e.moodleCourseId as number | null }));
      if (!isDiploma && list.length === 0) list.push({ id: it.product.id, title: it.productTitle, moodleCourseId: null });
      const courses = list.map((course, i) => {
        const e = course.moodleCourseId != null ? enrByCourse.get(course.moodleCourseId) : undefined;
        if (e) usedEnrollments.add(e.id);
        const inst = it.planKind === "MONTHLY" ? o.installments.find((x) => x.courseId === course.id) : undefined;
        return {
          position: i + 1,
          id: course.id,
          title: course.title,
          moodleCourseId: course.moodleCourseId,
          enrollmentId: e?.id ?? null,
          state: e ? enrollmentState(e) : ("LOCKED" as const),
          enrolledAt: e?.enrolledAt ?? null,
          completedAt: e?.completedAt ?? null,
          completionCheckedAt: e?.completionCheckedAt ?? null,
          lastError: e?.lastError ?? null,
          installment: inst ? { sequence: inst.sequence, status: inst.status, amountCents: inst.amountCents, dueDate: inst.dueDate } : null,
        };
      });
      const cert = isDiploma ? c.certificates.find((x) => x.diplomaId === it.productId) ?? null : null;
      return {
        orderItemId: it.id,
        order: { id: o.id, number: o.number, status: o.status, balanceCents: o.balanceCents },
        product: { id: it.productId, title: it.productTitle, type: it.productType, image: it.product.images[0] ?? null },
        modality: it.modality,
        sede: it.sede?.name ?? null,
        cohort: it.cohort,
        choice: it.choice?.label ?? null,
        planKind: it.planKind,
        planLabel: it.planLabel,
        courses,
        completed: courses.filter((x) => x.state === "COMPLETED").length,
        certificate: cert ? { id: cert.id, code: cert.code, status: cert.status, issuedAt: cert.issuedAt, emailedAt: cert.emailedAt, revokeReason: cert.revokeReason } : null,
      };
    }),
  );
  // Matrículas que no cuelgan de un programa vigente (pedido reembolsado, etc.).
  const otherEnrollments = c.enrollments
    .filter((e) => !usedEnrollments.has(e.id))
    .map((e) => ({ id: e.id, title: e.product.title, moodleCourseId: e.moodleCourseId, state: enrollmentState(e), lastError: e.lastError }));

  const paid = c.orders.reduce((a, o) => a + Math.max(0, o.amountPaidCents), 0);
  const events = c.orders
    .flatMap((o) => o.events.map((e) => ({ ...e, order: { id: o.id, number: o.number } })))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, 120);
  const moodleBase = d.config.moodleLoginUrl.replace(/\/login\/index\.php$/, "");
  return {
    now: d.now(),
    customer: {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      cedula: c.cedula,
      phone: c.phone,
      specialty: c.specialty,
      city: c.city,
      country: c.country,
      moodleUserId: c.moodleUserId,
      moodleUsername: c.moodleUsername,
      moodleProfileUrl: c.moodleUserId && moodleBase ? `${moodleBase}/user/profile.php?id=${c.moodleUserId}` : null,
      notes: c.notes,
      createdAt: c.createdAt,
    },
    prev: prev?.id ?? null,
    next: next?.id ?? null,
    stats: {
      paidCents: paid,
      orders: c.orders.length,
      balanceCents: live.reduce((a, o) => a + o.balanceCents, 0),
      coursesCompleted: c.enrollments.filter((e) => enrollmentState(e) === "COMPLETED").length,
      coursesActive: c.enrollments.filter((e) => e.status === "ENROLLED").length,
    },
    lastOrder: c.orders[0]
      ? {
          id: c.orders[0].id,
          number: c.orders[0].number,
          status: c.orders[0].status,
          placedAt: c.orders[0].placedAt,
          totalCents: c.orders[0].totalCents,
          amountPaidCents: c.orders[0].amountPaidCents,
          balanceCents: c.orders[0].balanceCents,
          paymentMethod: c.orders[0].paymentMethod,
          items: c.orders[0].items.map((it) => ({ id: it.id, title: it.productTitle, image: it.product.images[0] ?? null, modality: it.modality, sede: it.sede?.name ?? null, planLabel: it.planLabel, totalCents: it.totalCents })),
        }
      : null,
    orders: c.orders.map((o) => ({ id: o.id, number: o.number, status: o.status, placedAt: o.placedAt, totalCents: o.totalCents, balanceCents: o.balanceCents, items: o.items.length })),
    programs,
    otherEnrollments,
    certificates: c.certificates.map((x) => ({ id: x.id, code: x.code, status: x.status, issuedAt: x.issuedAt, emailedAt: x.emailedAt, hasPdf: !!x.pdfPath, diploma: x.diploma, revokeReason: x.revokeReason })),
    emails: c.emails,
    events,
  };
}
export type CustomerDetail = Awaited<ReturnType<typeof getCustomerDetail>>;

/** Nota interna del cliente (tarjeta «Notas»), con registro de auditoría. */
export async function updateCustomerNote(d: Deps, user: SessionUser, customerId: string, note: string) {
  const admin = await requireAdmin(d.db, user, "orders.note");
  const text = note.trim().slice(0, 5000) || null;
  return withTx(d, async (tx) => {
    const before = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, notes: true } });
    if (!before) throw new DomainError("NOT_FOUND", "El cliente no existe.");
    const after = await tx.customer.update({ where: { id: customerId }, data: { notes: text }, select: { id: true, notes: true } });
    await recordAudit(tx, { actor: admin, action: "customer.note", entityType: "Customer", entityId: customerId, before, after });
    return after;
  });
}

// ───────────────────────── Inicio ─────────────────────────

export const HOME_RANGES = { 7: "Últimos 7 días", 30: "Últimos 30 días", 90: "Últimos 90 días" } as const;

/**
 * Inicio del panel (réplica del Home de Shopify): métricas del periodo contra el periodo anterior con serie
 * diaria (cobrado, pedidos, matrículas nuevas, cursos completados, certificados), pendientes del día y avance por
 * diplomado.
 */
export async function homeDashboard(d: ReadDeps, user: SessionUser, days = 30) {
  await requireAdmin(d.db, user, "orders.view");
  const now = d.now();
  const today = caracasDay(now);
  const first = today - days + 1;
  const since = dayStart(first - days); // periodo actual + anterior
  const [payments, orders, enrollments, completions, certs] = await Promise.all([
    d.db.payment.findMany({ where: { status: { in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, OR: [{ verifiedAt: { gte: since } }, { verifiedAt: null, createdAt: { gte: since } }] }, select: { amountUsdCents: true, createdAt: true, verifiedAt: true } }),
    d.db.order.findMany({ where: { placedAt: { gte: since }, status: { notIn: ["EXPIRED", "CANCELLED"] } }, select: { placedAt: true } }),
    d.db.enrollment.findMany({ where: { enrolledAt: { gte: since } }, select: { enrolledAt: true } }),
    d.db.enrollment.findMany({ where: { completedAt: { gte: since }, status: "ENROLLED" }, select: { completedAt: true } }),
    d.db.certificate.findMany({ where: { issuedAt: { gte: since } }, select: { issuedAt: true } }),
  ]);
  const metric = (points: { at: Date; v: number }[]) => {
    const cur = Array.from({ length: days }, () => 0);
    const prev = Array.from({ length: days }, () => 0);
    for (const p of points) {
      const i = caracasDay(p.at) - first;
      if (i >= 0 && i < days) cur[i] += p.v;
      else if (i >= -days && i < 0) prev[i + days] += p.v;
    }
    const total = cur.reduce((a, b) => a + b, 0);
    const prevTotal = prev.reduce((a, b) => a + b, 0);
    return { total, prevTotal, series: cur, prevSeries: prev };
  };
  const labels = Array.from({ length: days }, (_, i) => dayStart(first + i).toISOString());

  const [awaiting, failed, pendingEnr, overdue, underpaid, attention, undelivered, diplomas] = await Promise.all([
    d.db.payment.aggregate({ where: { status: "AWAITING_VERIFICATION" }, _count: { _all: true }, _sum: { amountUsdCents: true } }),
    d.db.enrollment.count({ where: { status: "FAILED" } }),
    d.db.enrollment.count({ where: { status: "PENDING" } }),
    d.db.installment.aggregate({ where: { status: "OVERDUE", order: { status: { in: [...LIVE] } } }, _count: { _all: true }, _sum: { amountCents: true } }),
    d.db.order.count({ where: { status: "PENDING_PAYMENT", amountPaidCents: { gt: 0 } } }),
    d.db.orderEvent.count({ where: { type: "ATTENTION", createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
    d.db.certificate.count({ where: { status: "ISSUED", OR: [{ pdfPath: null }, { emailedAt: null }] } }),
    d.db.product.findMany({ where: { type: "DIPLOMA" }, orderBy: { position: "asc" }, select: { id: true, title: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true } } } }),
  ]);
  const purchases = await diplomaPurchasesWithoutCertificate(d);
  const certCounts = await d.db.certificate.groupBy({ by: ["diplomaId"], where: { status: "ISSUED" }, _count: { _all: true } });
  const blocked = purchases.filter((p) => p.total > 0 && p.completed === p.total && p.balanceCents > 0).length;

  const programs = diplomas.map((dp) => {
    const ps = purchases.filter((p) => p.diploma.id === dp.id);
    const issued = certCounts.find((x) => x.diplomaId === dp.id)?._count._all ?? 0;
    const done = ps.reduce((a, p) => a + p.completed, 0);
    const total = ps.reduce((a, p) => a + p.total, 0);
    // Distribución del avance: cuántos médicos van en cada curso (0..N completados).
    const n = Math.max(0, ...ps.map((p) => p.total));
    const buckets = Array.from({ length: n + 1 }, (_, k) => ps.filter((p) => p.completed === k).length);
    return { id: dp.id, title: dp.title, image: dp.images[0]?.url ?? null, students: ps.length, issued, completedCourses: done, totalCourses: total, rate: total ? done / total : 0, buckets, courses: n };
  });

  const recent = await d.db.orderEvent.findMany({
    where: { type: { in: ["ENROLLMENT", "ENROLLMENT_FAILED", "CERTIFICATE_ISSUED", "CERTIFICATE_REVOKED", "PAYMENT_VERIFIED", "PAYMENT_CAPTURED", "UNENROLLMENT"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 8,
    include: { order: { select: { id: true, number: true, customer: { select: { id: true, firstName: true, lastName: true } } } } },
  });

  return {
    days,
    now,
    labels,
    metrics: {
      collected: metric(payments.map((p) => ({ at: p.verifiedAt ?? p.createdAt, v: p.amountUsdCents }))),
      orders: metric(orders.map((o) => ({ at: o.placedAt, v: 1 }))),
      enrollments: metric(enrollments.map((e) => ({ at: e.enrolledAt!, v: 1 }))),
      completions: metric(completions.map((e) => ({ at: e.completedAt!, v: 1 }))),
      certificates: metric(certs.map((c) => ({ at: c.issuedAt, v: 1 }))),
    },
    todo: {
      awaiting: { count: awaiting._count._all, cents: awaiting._sum.amountUsdCents ?? 0 },
      failedEnrollments: failed,
      pendingEnrollments: pendingEnr,
      overdue: { count: overdue._count._all, cents: overdue._sum.amountCents ?? 0 },
      underpaid,
      attention,
      blockedCertificates: blocked,
      undeliveredCertificates: undelivered,
      nearlyDone: purchases.filter((p) => p.total > 0 && p.total - p.completed === 1 && p.balanceCents <= 0).length,
    },
    programs,
    recent: recent.map((e) => ({
      id: e.id,
      type: e.type,
      note: e.note,
      createdAt: e.createdAt,
      order: { id: e.order.id, number: e.order.number },
      customer: { id: e.order.customer.id, name: `${e.order.customer.firstName} ${e.order.customer.lastName}`.trim() },
    })),
  };
}
export type HomeDashboard = Awaited<ReturnType<typeof homeDashboard>>;

// ───────────── Exportaciones CSV (mismos filtros que cada índice) ─────────────

const ENROLLMENT_STATE_LABEL: Record<EnrollmentState, string> = { COMPLETED: "Completado", IN_PROGRESS: "En curso", PENDING: "Pendiente", FAILED: "Con error", UNENROLLED: "Desmatriculado" };
const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
interface ExportScope { ids?: string[] | null; page?: number | null; perPage?: number }
const pageOf = (scope: ExportScope) => (scope.page && !scope.ids?.length ? { skip: (scope.page - 1) * (scope.perPage ?? 50), take: scope.perPage ?? 50 } : { skip: 0, take: CSV_MAX_ROWS });

/** Búsqueda de Clientes por nombre, correo, cédula o teléfono (índice y exportación). */
export function customerSearchWhere(q: string): Prisma.CustomerWhereInput {
  const s = q.trim();
  return s ? { OR: [{ email: { contains: s.toLowerCase() } }, { firstName: { contains: s } }, { lastName: { contains: s } }, { cedula: { contains: s } }, { phone: { contains: s } }] } : {};
}

export async function exportCustomersTable(d: ReadDeps, user: SessionUser, query: ExportScope & { q?: string }) {
  await requireAdmin(d.db, user, "orders.view");
  const rows = await d.db.customer.findMany({
    where: query.ids?.length ? { id: { in: query.ids } } : customerSearchWhere(query.q ?? ""),
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    ...pageOf(query),
    include: { orders: { select: { amountPaidCents: true, balanceCents: true, status: true } }, _count: { select: { certificates: { where: { status: "ISSUED" } } } } },
  });
  const head = ["Nombre", "Apellido", "Correo", "Cédula", "Teléfono", "Especialidad", "Ciudad", "País", "Pedidos", "Pagado USD", "Saldo pendiente USD", "Certificados", "Cuenta de Moodle", "Usuario de Moodle", "Cliente desde", "Nota interna"];
  return {
    head,
    rows: rows.map((c): CsvCell[] => [
      c.firstName,
      c.lastName,
      c.email,
      code(c.cedula),
      code(c.phone),
      c.specialty,
      c.city,
      c.country === "VE" ? "Venezuela" : c.country,
      c.orders.length,
      money(c.orders.reduce((a, o) => a + Math.max(0, o.amountPaidCents), 0)),
      money(c.orders.filter((o) => (LIVE as readonly string[]).includes(o.status)).reduce((a, o) => a + Math.max(0, o.balanceCents), 0)),
      c._count.certificates,
      !!c.moodleUserId,
      c.moodleUsername,
      at(c.createdAt),
      c.notes,
    ]),
  };
}

export async function exportEnrollmentsTable(d: ReadDeps, user: SessionUser, query: Omit<EnrollmentIndexQuery, "page"> & ExportScope) {
  await requireAdmin(d.db, user, "orders.view");
  const view: EnrollmentView = query.view && query.view in ENROLLMENT_VIEWS ? query.view : "ALL";
  const where: Prisma.EnrollmentWhereInput = query.ids?.length
    ? { id: { in: query.ids } }
    : { AND: [searchFilter(query.q), await programFilter(d, query.program), ENROLLMENT_VIEWS[view].where] };
  const rows = await d.db.enrollment.findMany({
    where,
    orderBy: enrollmentOrderBy(query),
    ...pageOf(query),
    include: {
      customer: { select: { firstName: true, lastName: true, email: true, cedula: true } },
      product: { select: { title: true } },
      order: { select: { number: true } },
      orderItem: { select: { productTitle: true, productType: true } },
    },
  });
  const head = ["Médico", "Correo", "Cédula", "Curso", "Curso en Moodle", "Diplomado", "Pedido", "Estado", "Matriculado el", "Completado el", "Última consulta a Moodle", "Intentos", "Último error"];
  return {
    head,
    rows: rows.map((e): CsvCell[] => [
      fullName(e.customer),
      e.customer.email,
      code(e.customer.cedula),
      e.product.title,
      e.moodleCourseId,
      e.orderItem?.productType === "DIPLOMA" ? e.orderItem.productTitle : "",
      e.order ? `#${e.order.number}` : "",
      ENROLLMENT_STATE_LABEL[enrollmentState(e)],
      at(e.enrolledAt),
      at(e.completedAt),
      at(e.completionCheckedAt),
      e.attempts,
      e.lastError,
    ]),
  };
}

/** Certificados de la vista: emitidos/revocados (uno por certificado) o compras en curso/bloqueadas por saldo. */
export async function exportCertificatesTable(d: ReadDeps, user: SessionUser, query: { view?: CertificateView; q?: string; diploma?: string }) {
  const idx = await listCertificatesIndex(d, user, query);
  if (idx.view === "ISSUED" || idx.view === "REVOKED") {
    const cedulas = new Map(
      (await d.db.customer.findMany({ where: { id: { in: idx.certificates.map((c) => c.customer.id) } }, select: { id: true, cedula: true } })).map((c) => [c.id, c.cedula]),
    );
    return {
      head: ["Código", "Médico", "Correo", "Cédula", "Diplomado", "Pedido", "Estado", "Emitido el", "PDF generado", "Enviado por correo el", "Revocado el", "Motivo de la revocación"],
      rows: idx.certificates.map((c): CsvCell[] => [
        c.code,
        c.customer.name,
        c.customer.email,
        code(cedulas.get(c.customer.id) ?? null),
        c.diploma.title,
        c.order ? `#${c.order.number}` : "",
        c.status === "REVOKED" ? "Revocado" : "Emitido",
        at(c.issuedAt),
        c.hasPdf,
        at(c.emailedAt),
        at(c.revokedAt),
        c.revokeReason,
      ]),
    };
  }
  return {
    head: ["Médico", "Correo", "Diplomado", "Pedido", "Cursos completados", "Cursos del diplomado", "Faltan", "Saldo pendiente USD", "Paga mes a mes", "Última consulta a Moodle"],
    rows: idx.purchases.map((p): CsvCell[] => [
      p.customer.name,
      p.customer.email,
      p.diploma.title,
      `#${p.orderNumber}`,
      p.completed,
      p.total,
      p.courses.filter((c) => c.state !== "COMPLETED").map((c) => c.title).join(" | "),
      money(Math.max(0, p.balanceCents)),
      p.monthly,
      at(p.lastCheckedAt),
    ]),
  };
}
