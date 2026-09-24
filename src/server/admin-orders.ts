// Lectura de pedidos para el panel (listado, ficha con pagos/comprobantes/historial/correos/matrículas) y
// descarga del comprobante de un pago manual. Solo lectura: las escrituras son adminVerifyPayment,
// refundPayment, cancelOrder… (payments.ts / orders.ts), que registran su OrderEvent.
import fs from "node:fs/promises";
import path from "node:path";
import type { Deps } from "./deps";
import type { OrderStatus, Prisma } from "./db";
import { requireAdmin, type SessionUser } from "./auth";
import { DomainError } from "./errors";

export interface AdminOrderQuery {
  status?: OrderStatus | "ALL";
  /** Número de pedido, correo, nombre o cédula. */
  q?: string;
  take?: number;
}

export async function listAdminOrders(d: Pick<Deps, "db">, user: SessionUser, query: AdminOrderQuery = {}) {
  await requireAdmin(d.db, user, "orders.view");
  const q = query.q?.trim() ?? "";
  const num = /^#?\d+$/.test(q) ? Number(q.replace("#", "")) : null;
  const where: Prisma.OrderWhereInput = {
    ...(query.status && query.status !== "ALL" ? { status: query.status } : {}),
    ...(q
      ? {
          OR: [
            ...(num != null ? [{ number: num }] : []),
            { customer: { email: { contains: q.toLowerCase() } } },
            { customer: { firstName: { contains: q } } },
            { customer: { lastName: { contains: q } } },
            { customer: { cedula: { contains: q } } },
            { payments: { some: { reference: { contains: q } } } },
          ],
        }
      : {}),
  };
  const [rows, grouped] = await Promise.all([
    d.db.order.findMany({
      where,
      orderBy: { placedAt: "desc" },
      take: Math.min(Math.max(query.take ?? 100, 1), 500),
      include: {
        customer: { select: { email: true, firstName: true, lastName: true } },
        items: { select: { productTitle: true, modality: true, sede: { select: { name: true } }, cohort: { select: { name: true } } } },
        payments: { select: { method: true, status: true } },
      },
    }),
    d.db.order.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Partial<Record<OrderStatus, number>>;
  return {
    counts,
    rows: rows.map((o) => ({
      id: o.id,
      number: o.number,
      placedAt: o.placedAt,
      status: o.status,
      paymentMethod: o.paymentMethod,
      totalCents: o.totalCents,
      amountPaidCents: o.amountPaidCents,
      balanceCents: o.balanceCents,
      customer: o.customer,
      items: o.items.map((i) => ({ title: i.productTitle, modality: i.modality, sede: i.sede?.name ?? null, cohort: i.cohort?.name ?? null })),
      awaitingVerification: o.payments.filter((p) => p.status === "AWAITING_VERIFICATION").length,
    })),
  };
}

export async function getAdminOrder(d: Pick<Deps, "db">, user: SessionUser, orderId: string) {
  await requireAdmin(d.db, user, "orders.view");
  const o = await d.db.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      items: { include: { cohort: true, sede: true, reservation: true, product: { select: { id: true, slug: true, type: true, moodleCourseId: true } } } },
      installments: { orderBy: { sequence: "asc" }, include: { course: { select: { title: true } } } },
      payments: {
        orderBy: { createdAt: "asc" },
        include: { verifiedBy: { select: { name: true, email: true } }, refunds: { orderBy: { createdAt: "asc" }, include: { createdBy: { select: { name: true } } } } },
      },
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { actor: { select: { name: true, email: true } } } },
      emails: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, template: true, subject: true, to: true, status: true, createdAt: true, sentAt: true } },
    },
  });
  if (!o) throw new DomainError("NOT_FOUND", "El pedido no existe.");
  const enrollments = await d.db.enrollment.findMany({
    where: { OR: [{ orderId: o.id }, { orderItem: { orderId: o.id } }] },
    orderBy: { moodleCourseId: "asc" },
    include: { product: { select: { title: true } } },
  });
  return {
    ...o,
    enrollments,
    payments: o.payments.map((p) => ({ ...p, hasProof: !!p.proofFile, proofKind: proofKind(p.proofFile) })),
  };
}

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

function proofKind(file: string | null): "image" | "pdf" | null {
  if (!file) return null;
  const ext = path.extname(file).toLowerCase();
  // HEIC (comprobantes antiguos) no es "image": Chrome/Firefox no lo muestran; el panel ofrece el enlace de descarga.
  return ext === ".pdf" ? "pdf" : TYPES[ext] && ext !== ".heic" ? "image" : null;
}

/**
 * Comprobante de un pago manual (solo panel: el archivo vive fuera de public/). Solo sirve archivos dentro de
 * PRIVATE_FILES_DIR/proofs/.
 */
export async function readPaymentProof(d: Pick<Deps, "db" | "config">, user: SessionUser, paymentId: string) {
  await requireAdmin(d.db, user, "orders.view");
  const p = await d.db.payment.findUnique({ where: { id: paymentId }, select: { id: true, orderId: true, proofFile: true } });
  if (!p?.proofFile) throw new DomainError("NOT_FOUND", "Este pago no tiene comprobante.");
  const root = path.resolve(d.config.privateFilesDir, "proofs");
  const file = path.resolve(p.proofFile);
  if (!file.startsWith(root + path.sep)) throw new DomainError("NOT_FOUND", "Comprobante no disponible.");
  const ext = path.extname(file).toLowerCase();
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch {
    throw new DomainError("NOT_FOUND", "No encontramos el archivo del comprobante.");
  }
  return { orderId: p.orderId, bytes, contentType: TYPES[ext] ?? "application/octet-stream", filename: `comprobante-${p.id}${ext}` };
}
