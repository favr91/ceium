// Vistas de lectura del panel de Pedidos (pieza a3): índice con vistas/filtros/orden/paginación y métricas,
// ficha completa (programas con imagen, pagos con reembolsos, cuotas, ajustes, matrículas, correos, historial,
// pedidos vecinos, cohortes a las que se puede reasignar) y exportación CSV. Solo lectura: toda escritura
// pasa por los servicios auditados (payments / orders / corrections / enrollment / email).
import type { Deps } from "./deps";
import type { OrderStatus, PaymentMethod, Prisma } from "./db";
import { requireAdmin, type SessionUser } from "./auth";
import { DomainError } from "./errors";
import { canonicalReference, sameBankMovement } from "./payments";

export const ORDER_STATUSES: readonly OrderStatus[] = ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "PARTIALLY_PAID", "PAID", "ENROLLED", "REJECTED", "CANCELLED", "EXPIRED", "REFUNDED"];
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["PAYPAL", "PAGO_MOVIL", "TRANSFERENCIA", "ZELLE", "EFECTIVO"];
const PAID: OrderStatus[] = ["PAID", "PARTIALLY_PAID", "ENROLLED"];

/** Vistas (pestañas) del índice. `status` (uno o varios estados exactos) es un filtro aparte. */
export const ORDER_VIEWS = {
  ALL: { label: "Todos", where: {} },
  // Por pago, no solo por estado del pedido: un pago manual en verificación sobre un pedido ya pagado (cuota o
  // saldo, o un segundo pago del médico) también espera al staff, y el aviso del índice ya lo cuenta.
  AWAITING_VERIFICATION: { label: "Por verificar", where: { OR: [{ status: "AWAITING_VERIFICATION" }, { payments: { some: { status: "AWAITING_VERIFICATION" } } }] } },
  PENDING_PAYMENT: { label: "Pago pendiente", where: { status: "PENDING_PAYMENT" } },
  BALANCE: { label: "Con saldo", where: { status: { in: PAID }, balanceCents: { gt: 0 } } },
  ENROLLED: { label: "Inscritos", where: { status: "ENROLLED" } },
  REFUNDED: { label: "Reembolsados", where: { OR: [{ status: "REFUNDED" }, { payments: { some: { refundedCents: { gt: 0 } } } }] } },
  CLOSED: { label: "Cerrados", where: { status: { in: ["REJECTED", "EXPIRED", "CANCELLED"] } } },
} satisfies Record<string, { label: string; where: Prisma.OrderWhereInput }>;
export type OrderView = keyof typeof ORDER_VIEWS;

export const ORDER_SORTS = {
  number: "Número de pedido",
  date: "Fecha",
  customer: "Cliente",
  total: "Total",
  balance: "Saldo",
} as const;
export type OrderSort = keyof typeof ORDER_SORTS;

export interface OrderIndexQuery {
  view?: OrderView;
  status?: OrderStatus[];
  method?: PaymentMethod[];
  modality?: ("ONLINE" | "SEMIPRESENCIAL")[];
  q?: string;
  sort?: OrderSort;
  dir?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

function whereOf(query: OrderIndexQuery): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];
  if (query.view && query.view !== "ALL") and.push(ORDER_VIEWS[query.view].where);
  if (query.status?.length) and.push({ status: { in: query.status } });
  if (query.method?.length) and.push({ paymentMethod: { in: query.method } });
  if (query.modality?.length) and.push({ items: { some: { modality: { in: query.modality } } } });
  const q = query.q?.trim() ?? "";
  if (q) {
    const num = /^#?\d+$/.test(q) ? Number(q.replace("#", "")) : null;
    const words = q.split(/\s+/).filter(Boolean);
    and.push({
      OR: [
        ...(num != null ? [{ number: num }] : []),
        { customer: { email: { contains: q.toLowerCase() } } },
        { customer: { cedula: { contains: q } } },
        { customer: { phone: { contains: q } } },
        { payments: { some: { reference: { contains: q } } } },
        { items: { some: { productTitle: { contains: q } } } },
        // «María Pérez»: cada palabra en el nombre o el apellido.
        { AND: words.map((w) => ({ OR: [{ customer: { firstName: { contains: w } } }, { customer: { lastName: { contains: w } } }] })) },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

function orderByOf(sort: OrderSort = "number", dir: "asc" | "desc" = "desc"): Prisma.OrderOrderByWithRelationInput[] {
  switch (sort) {
    case "date":
      return [{ placedAt: dir }, { number: dir }];
    case "customer":
      return [{ customer: { firstName: dir } }, { customer: { lastName: dir } }, { number: "desc" }];
    case "total":
      return [{ totalCents: dir }, { number: "desc" }];
    case "balance":
      return [{ balanceCents: dir }, { number: "desc" }];
    default:
      return [{ number: dir }];
  }
}

const rowInclude = {
  customer: { select: { id: true, email: true, firstName: true, lastName: true, phone: true } },
  items: {
    select: {
      productTitle: true,
      productType: true,
      modality: true,
      planKind: true,
      planLabel: true,
      totalCents: true,
      sede: { select: { name: true } },
      cohort: { select: { name: true } },
      product: { select: { slug: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true, alt: true } } } },
    },
  },
  payments: { select: { method: true, status: true, refundedCents: true } },
  enrollments: { select: { status: true } },
  installments: { select: { status: true } },
} satisfies Prisma.OrderInclude;

type RowSource = Prisma.OrderGetPayload<{ include: typeof rowInclude }>;

function toRow(o: RowSource) {
  const enr = { total: o.enrollments.length, enrolled: 0, failed: 0, unenrolled: 0, pending: 0 };
  for (const e of o.enrollments) {
    if (e.status === "ENROLLED") enr.enrolled++;
    else if (e.status === "FAILED") enr.failed++;
    else if (e.status === "UNENROLLED") enr.unenrolled++;
    else enr.pending++;
  }
  return {
    id: o.id,
    number: o.number,
    placedAt: o.placedAt.toISOString(),
    status: o.status,
    paymentMethod: o.paymentMethod,
    totalCents: o.totalCents,
    amountPaidCents: o.amountPaidCents,
    balanceCents: o.balanceCents,
    refundedCents: o.payments.reduce((a, p) => a + p.refundedCents, 0),
    awaitingVerification: o.payments.filter((p) => p.status === "AWAITING_VERIFICATION").length,
    customer: { id: o.customer.id, email: o.customer.email, name: `${o.customer.firstName} ${o.customer.lastName}`.trim(), phone: o.customer.phone },
    items: o.items.map((i) => ({
      title: i.productTitle,
      type: i.productType,
      modality: i.modality,
      plan: i.planLabel,
      planKind: i.planKind,
      sede: i.sede?.name ?? null,
      cohort: i.cohort?.name ?? null,
      totalCents: i.totalCents,
      image: i.product.images[0]?.url ?? null,
    })),
    enrollment: enr,
    installments: { total: o.installments.length, settled: o.installments.filter((i) => i.status === "PAID" || i.status === "WAIVED").length },
  };
}
export type OrderRow = ReturnType<typeof toRow>;

export async function listOrdersIndex(d: Pick<Deps, "db" | "now">, user: SessionUser, query: OrderIndexQuery = {}) {
  await requireAdmin(d.db, user, "orders.view");
  const perPage = Math.min(Math.max(query.perPage ?? 50, 1), 250);
  const where = whereOf(query);
  const total = await d.db.order.count({ where });
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(query.page ?? 1, 1), pages);
  const rows = await d.db.order.findMany({ where, orderBy: orderByOf(query.sort, query.dir), skip: (page - 1) * perPage, take: perPage, include: rowInclude });

  // Conteos por pestaña (con los filtros de búsqueda/método/modalidad, sin la pestaña).
  const base = whereOf({ ...query, view: "ALL" });
  const counts = Object.fromEntries(
    await Promise.all(
      (Object.keys(ORDER_VIEWS) as OrderView[]).map(async (k) => [k, await d.db.order.count({ where: { AND: [base, ORDER_VIEWS[k].where] } })] as const),
    ),
  ) as Record<OrderView, number>;
  return { rows: rows.map(toRow), total, page, pages, perPage, counts };
}

/** Métricas de la cabecera del índice (últimos `days` días, con serie diaria para la mini gráfica). */
export async function orderMetrics(d: Pick<Deps, "db" | "now">, user: SessionUser, days = 30) {
  await requireAdmin(d.db, user, "orders.view");
  const now = d.now();
  const dayMs = 86_400_000;
  // Días de Caracas (UTC−4, sin horario de verano).
  const caracasDay = (t: Date) => Math.floor((t.getTime() - 4 * 3_600_000) / dayMs);
  const today = caracasDay(now);
  const since = new Date((today - days + 1) * dayMs + 4 * 3_600_000);
  const [orders, captured, refunds, awaiting, balance] = await Promise.all([
    d.db.order.findMany({ where: { placedAt: { gte: since } }, select: { placedAt: true } }),
    d.db.payment.findMany({ where: { status: { in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, OR: [{ verifiedAt: { gte: since } }, { verifiedAt: null, createdAt: { gte: since } }] }, select: { amountUsdCents: true, createdAt: true, verifiedAt: true } }),
    d.db.refund.findMany({ where: { status: "COMPLETED", createdAt: { gte: since } }, select: { amountCents: true } }),
    d.db.payment.aggregate({ where: { status: "AWAITING_VERIFICATION" }, _count: { _all: true }, _sum: { amountUsdCents: true } }),
    d.db.order.aggregate({ where: { status: { in: PAID }, balanceCents: { gt: 0 } }, _count: { _all: true }, _sum: { balanceCents: true } }),
  ]);
  const series = (points: { at: Date; v: number }[]) => {
    const out = Array.from({ length: days }, () => 0);
    for (const p of points) {
      const i = caracasDay(p.at) - (today - days + 1);
      if (i >= 0 && i < days) out[i] += p.v;
    }
    return out;
  };
  return {
    days,
    orders: { count: orders.length, series: series(orders.map((o) => ({ at: o.placedAt, v: 1 }))) },
    collected: { cents: captured.reduce((a, p) => a + p.amountUsdCents, 0), series: series(captured.map((p) => ({ at: p.verifiedAt ?? p.createdAt, v: p.amountUsdCents }))) },
    refunded: { cents: refunds.reduce((a, r) => a + r.amountCents, 0), count: refunds.length },
    awaiting: { count: awaiting._count._all, cents: awaiting._sum.amountUsdCents ?? 0 },
    balance: { count: balance._count._all, cents: balance._sum.balanceCents ?? 0 },
  };
}

const METHOD_LABEL: Record<string, string> = { PAYPAL: "PayPal", PAGO_MOVIL: "Pago móvil", TRANSFERENCIA: "Transferencia", ZELLE: "Zelle", EFECTIVO: "Efectivo" };
const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Pago pendiente",
  AWAITING_VERIFICATION: "Por verificar",
  PARTIALLY_PAID: "Pagado parcialmente",
  PAID: "Pagado",
  ENROLLED: "Inscrito",
  REJECTED: "Rechazado",
  CANCELLED: "Cancelado",
  EXPIRED: "Vencido",
  REFUNDED: "Reembolsado",
};

/** CSV (separado por comas, UTF-8 con BOM para Excel) de los pedidos de la consulta o de los ids dados. */
export async function exportOrdersCsv(d: Pick<Deps, "db" | "now">, user: SessionUser, query: OrderIndexQuery & { ids?: string[] }) {
  await requireAdmin(d.db, user, "orders.view");
  const where = query.ids?.length ? { id: { in: query.ids.slice(0, 1000) } } : whereOf(query);
  const rows = (await d.db.order.findMany({ where, orderBy: orderByOf(query.sort, query.dir), take: 5000, include: { ...rowInclude, customer: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, cedula: true } } } })).map((o) => ({
    row: toRow(o),
    cedula: o.customer.cedula,
  }));
  const usd = (c: number) => (c / 100).toFixed(2);
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Pedido", "Fecha", "Estado", "Cliente", "Correo", "Cédula", "Teléfono", "Programa", "Modalidad", "Sede", "Cohorte", "Plan", "Método", "Total USD", "Pagado USD", "Reembolsado USD", "Saldo USD"];
  const lines = rows.map(({ row: r, cedula }) =>
    [
      `#${r.number}`,
      new Date(r.placedAt).toISOString(),
      STATUS_LABEL[r.status] ?? r.status,
      r.customer.name,
      r.customer.email,
      cedula ?? "",
      r.customer.phone ?? "",
      r.items.map((i) => i.title).join(" | "),
      r.items.map((i) => (i.modality === "ONLINE" ? "Online" : "Semipresencial")).join(" | "),
      r.items.map((i) => i.sede ?? "").join(" | "),
      r.items.map((i) => i.cohort ?? "").join(" | "),
      r.items.map((i) => i.plan ?? "").join(" | "),
      r.paymentMethod ? METHOD_LABEL[r.paymentMethod] : "",
      usd(r.totalCents),
      usd(r.amountPaidCents),
      usd(r.refundedCents),
      usd(Math.max(0, r.balanceCents)),
    ]
      .map(cell)
      .join(","),
  );
  return "﻿" + [head.join(","), ...lines].join("\r\n") + "\r\n";
}

// ───────────── Ficha ─────────────

export async function getOrderDetail(d: Pick<Deps, "db" | "now">, user: SessionUser, orderId: string) {
  await requireAdmin(d.db, user, "orders.view");
  const o = await d.db.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      items: {
        include: {
          cohort: { include: { sede: { select: { name: true } } } },
          sede: true,
          reservation: true,
          choice: { select: { label: true } },
          product: { select: { id: true, slug: true, type: true, moodleCourseId: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true, alt: true } } } },
          courses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, title: true, moodleCourseId: true } } } },
          certificates: { select: { id: true, code: true, status: true, issuedAt: true } },
        },
      },
      installments: { orderBy: { sequence: "asc" }, include: { course: { select: { title: true } } } },
      adjustments: { orderBy: { createdAt: "asc" }, include: { createdBy: { select: { name: true } } } },
      payments: {
        orderBy: { createdAt: "asc" },
        include: {
          verifiedBy: { select: { name: true, email: true } },
          installment: { select: { sequence: true } },
          refunds: { orderBy: { createdAt: "asc" }, include: { createdBy: { select: { name: true } } } },
        },
      },
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { actor: { select: { name: true, email: true } } } },
      emails: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, template: true, subject: true, to: true, status: true, createdAt: true, sentAt: true, lastError: true, attempts: true } },
    },
  });
  if (!o) throw new DomainError("NOT_FOUND", "El pedido no existe.");

  const [enrollments, prev, next, customerOrders, reassign] = await Promise.all([
    d.db.enrollment.findMany({
      where: { OR: [{ orderId: o.id }, { orderItem: { orderId: o.id } }] },
      orderBy: { moodleCourseId: "asc" },
      include: { product: { select: { title: true } } },
    }),
    d.db.order.findFirst({ where: { number: { lt: o.number } }, orderBy: { number: "desc" }, select: { id: true, number: true } }),
    d.db.order.findFirst({ where: { number: { gt: o.number } }, orderBy: { number: "asc" }, select: { id: true, number: true } }),
    d.db.order.count({ where: { customerId: o.customerId } }),
    // Cohortes del mismo programa a las que se puede reasignar cada ítem semipresencial.
    d.db.cohort.findMany({
      where: { productId: { in: o.items.filter((i) => i.modality === "SEMIPRESENCIAL").map((i) => i.productId) }, status: { in: ["OPEN", "IN_PROGRESS", "CLOSED"] } },
      orderBy: [{ startDate: "asc" }],
      include: { sede: { select: { name: true } } },
    }),
  ]);

  // Duplicados: la misma referencia en otro pedido (ayuda al verificar un pago manual).
  // Misma referencia con otro relleno de ceros, formato o solo los últimos dígitos (sameBankMovement): se buscan
  // candidatas por sus últimos 4 caracteres y se comparan en forma canónica.
  const refs = o.payments.filter((p) => p.reference && p.status === "AWAITING_VERIFICATION").map((p) => p.reference!);
  const tails = [...new Set(refs.map((r) => canonicalReference(r).slice(-4)).filter(Boolean))];
  const dupRefs = tails.length
    ? (
        await d.db.payment.findMany({
          where: { OR: tails.map((t) => ({ reference: { contains: t } })), orderId: { not: o.id } },
          select: { reference: true, status: true, order: { select: { id: true, number: true } } },
        })
      ).filter((x) => refs.some((r) => sameBankMovement(r, x.reference)))
    : [];

  const now = d.now();
  return {
    ...o,
    enrollments,
    prev,
    next,
    customerOrders,
    now,
    payments: o.payments.map((p) => ({
      ...p,
      exchangeRate: p.exchangeRate != null ? Number(p.exchangeRate) : null,
      providerPayload: undefined,
      hasProof: !!p.proofFile,
      proofKind: proofKind(p.proofFile),
      proofFile: undefined,
      refundableCents: p.status === "COMPLETED" || p.status === "PARTIALLY_REFUNDED" ? p.amountUsdCents - p.refundedCents : 0,
      duplicates: dupRefs.filter((x) => sameBankMovement(p.reference, x.reference)).map((x) => ({ orderId: x.order.id, number: x.order.number, status: x.status })),
    })),
    cohortOptions: reassign.map((c) => ({
      id: c.id,
      productId: c.productId,
      name: c.name,
      sede: c.sede.name,
      startDate: c.startDate,
      endDate: c.endDate,
      status: c.status,
      free: Math.max(0, c.capacity - c.seatsHeld - c.seatsConfirmed),
      capacity: c.capacity,
    })),
  };
}
export type OrderDetail = Awaited<ReturnType<typeof getOrderDetail>>;

function proofKind(file: string | null): "image" | "pdf" | null {
  if (!file) return null;
  const ext = file.toLowerCase().split(".").pop() ?? "";
  return ext === "pdf" ? "pdf" : ["jpg", "jpeg", "png", "webp"].includes(ext) ? "image" : null;
}

/** HTML de un correo del pedido para la vista previa del panel (ya sin secretos: el outbox guarda la versión redactada). */
export async function getOrderEmail(d: Pick<Deps, "db">, user: SessionUser, orderId: string, emailId: string) {
  await requireAdmin(d.db, user, "orders.view");
  const m = await d.db.emailOutbox.findUnique({ where: { id: emailId }, select: { orderId: true, html: true, subject: true } });
  if (!m || m.orderId !== orderId) throw new DomainError("NOT_FOUND", "El correo no existe.");
  return m;
}
