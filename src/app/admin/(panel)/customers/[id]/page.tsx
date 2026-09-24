// Ficha del cliente (panel): resumen, último pedido, programas con avance en Moodle curso a curso y certificado,
// cronología de todos sus pedidos, contacto, aula virtual, certificados, pedidos y nota interna.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@/server/auth";
import { getCustomerDetail } from "@/server/admin-learning";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { CustomerView } from "@/components/admin/learning/CustomerView";
import "@/components/admin/orders/orders.css";
import "@/components/admin/learning/learning.css";
import { requireAdminPage } from "../../../_lib/session";

export const dynamic = "force-dynamic";

// Tipos explícitos (no PageProps<…>): los tipos de rutas generados dependen del build dir de cada carril.
type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const c = await services().deps.db.customer.findUnique({ where: { id }, select: { firstName: true, lastName: true } });
  return { title: c ? `${c.firstName} ${c.lastName}`.trim() : "Cliente" };
}

export default async function CustomerPage({ params }: Params) {
  const { id } = await params;
  const user = await requireAdminPage("orders.view", `/admin/customers/${id}`);
  let c: Awaited<ReturnType<typeof getCustomerDetail>>;
  try {
    c = await getCustomerDetail(services().deps, user, id);
  } catch (e) {
    if (isDomainError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  return <CustomerView c={c} perms={{ manage: can(user, "enrollments.manage"), resend: can(user, "emails.resend"), note: can(user, "orders.note") }} />;
}
