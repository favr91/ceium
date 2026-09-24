// Ficha del pedido (panel): programas con cupo y cursos, pago (resumen, cuotas, transacciones con comprobante,
// verificación y reembolso), cronología con comentarios, cliente, Moodle y correos. Las correcciones manuales
// (reasignar cohorte, ajustar saldo, condonar, rematricular, reenviar, cancelar) pasan por los servicios de dominio.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@/server/auth";
import { getOrderDetail } from "@/server/admin-order-views";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { OrderDetailView } from "@/components/admin/orders/OrderDetailView";
import "@/components/admin/orders/orders.css";
import { requireAdminPage } from "../../../_lib/session";

export const dynamic = "force-dynamic";

// Tipos explícitos (no PageProps<…>): los tipos de rutas generados dependen del build dir de cada carril.
type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const o = await services().deps.db.order.findUnique({ where: { id }, select: { number: true } });
  return { title: o ? `Pedido #${o.number}` : "Pedido" };
}

export default async function OrderDetailPage({ params }: Params) {
  const { id } = await params;
  const user = await requireAdminPage("orders.view", `/admin/orders/${id}`);
  let o: Awaited<ReturnType<typeof getOrderDetail>>;
  try {
    o = await getOrderDetail(services().deps, user, id);
  } catch (e) {
    if (isDomainError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const perms = {
    verify: can(user, "payments.verify"),
    refund: can(user, "payments.refund"),
    adjust: can(user, "orders.adjustBalance"),
    cancel: can(user, "orders.cancel"),
    reassign: can(user, "orders.reassignCohort"),
    enroll: can(user, "enrollments.manage"),
    resend: can(user, "emails.resend"),
    note: can(user, "orders.note"),
  };
  return <OrderDetailView o={o} perms={perms} adminName={user.name} />;
}
