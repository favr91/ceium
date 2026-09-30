// Clientes (réplica del listado de Clientes de Shopify): búsqueda por nombre, correo o cédula; pedidos, total pagado,
// cuenta de Moodle y certificados de cada médico. Cada fila abre su ficha (/admin/customers/[id]).
import type { Metadata } from "next";
import Link from "next/link";
import { customerSearchWhere } from "@/server/admin-learning";
import { services } from "@/server/services";
import { Icon } from "@/components/admin/Icon";
import { ExportButton } from "@/components/admin/ExportButton";
import { exportOptions, exportQuery } from "@/components/admin/export-options";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Clientes" };

const PER_PAGE = 50;
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type SP = Record<string, string | string[] | undefined>;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdminPage("orders.view", "/admin/customers");
  const sp = await searchParams;
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim() ?? "";
  const page = Math.max(1, Number(Array.isArray(sp.page) ? sp.page[0] : sp.page) || 1);
  const db = services().deps.db;
  const where = customerSearchWhere(q);
  const [total, rows] = await Promise.all([
    db.customer.count({ where }),
    db.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        cedula: true,
        city: true,
        specialty: true,
        moodleUserId: true,
        createdAt: true,
        orders: { select: { amountPaidCents: true, status: true } },
        _count: { select: { certificates: { where: { status: "ISSUED" } } } },
      },
    }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const link = (p: number) => `/admin/customers?${new URLSearchParams({ ...(q ? { q } : {}), ...(p > 1 ? { page: String(p) } : {}) })}`;

  return (
    <div className="adm-page">
      <div className="adm-ph">
        <div className="grow">
          <h1>Clientes</h1>
          <div className="meta">{total === 1 ? "1 médico" : `${total} médicos`} con pedidos en la tienda</div>
        </div>
        <div className="adm-ph-actions">
          <ExportButton
            title="Exportar clientes"
            endpoint="/admin/customers/export"
            {...exportOptions({ noun: ["clientes", "cliente"], filters: exportQuery({ q }), filtered: !!q, total, page, pages })}
          />
        </div>
      </div>
      <div className="card card-flush">
        <form className="ix-filters" role="search" action="/admin/customers">
          <div className="ix-search">
            <Icon name="search" />
            <input className="inp" type="search" name="q" defaultValue={q} placeholder="Buscar por nombre, correo, cédula o teléfono" aria-label="Buscar clientes" />
          </div>
          {q ? <Link className="btn btn-plain" href="/admin/customers">Borrar</Link> : null}
        </form>
        {rows.length === 0 ? (
          <div className="ix-empty">
            <Icon name="customer" size={40} />
            <h3>{q ? "No se encontraron clientes" : "Aún no hay clientes"}</h3>
            <p className="muted">{q ? "Prueba con otro nombre, correo o cédula." : "Cada médico que compra en la tienda aparece aquí."}</p>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
            <table className="ix" aria-label="Clientes">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="h-md">Cédula</th>
                  <th className="h-md">Especialidad</th>
                  <th className="num">Pedidos</th>
                  <th className="num">Pagado</th>
                  <th>Aula virtual</th>
                  <th className="num h-md">Certificados</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const paid = c.orders.reduce((a, o) => a + Math.max(0, o.amountPaidCents), 0);
                  return (
                    <tr key={c.id} data-customer={c.email}>
                      <td className="c-title">
                        <Link className="title" href={`/admin/customers/${c.id}`}>{`${c.firstName} ${c.lastName}`.trim() || c.email}</Link>
                        <div className="sub">{c.email}</div>
                      </td>
                      <td className="h-md">{c.cedula ?? <span className="subdued">—</span>}</td>
                      <td className="h-md">{c.specialty ?? <span className="subdued">—</span>}</td>
                      <td className="num mono">{c.orders.length}</td>
                      <td className="num mono">{usd(paid)}</td>
                      <td>{c.moodleUserId ? <span className="badge success">Con cuenta</span> : <span className="badge">Sin cuenta</span>}</td>
                      <td className="num mono h-md">{c._count.certificates || <span className="subdued">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
            <ul className="ix-list" aria-label="Clientes">
              {rows.map((c) => (
                <li key={c.id}>
                  <Link href={`/admin/customers/${c.id}`} style={{ flex: 1, minWidth: 0 }}>
                    <span className="t">{`${c.firstName} ${c.lastName}`.trim() || c.email}</span>
                    <span className="s">{c.email}</span>
                    <span className="s">
                      {c.orders.length === 1 ? "1 pedido" : `${c.orders.length} pedidos`} · {usd(c.orders.reduce((a, o) => a + Math.max(0, o.amountPaidCents), 0))}
                    </span>
                    <span className="b">{c.moodleUserId ? <span className="badge success">Con cuenta en Moodle</span> : <span className="badge">Sin cuenta en Moodle</span>}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="card-foot">
          <span>{rows.length === total ? `${total} ${total === 1 ? "cliente" : "clientes"}` : `${(page - 1) * PER_PAGE + 1}–${(page - 1) * PER_PAGE + rows.length} de ${total} clientes`}</span>
          {pages > 1 ? (
            <nav className="adm-pager" aria-label="Paginación">
              {page > 1 ? <Link href={link(page - 1)} aria-label="Página anterior"><Icon name="prev" size={16} /></Link> : <span aria-disabled="true"><Icon name="prev" size={16} /></span>}
              {page < pages ? <Link href={link(page + 1)} aria-label="Página siguiente"><Icon name="next" size={16} /></Link> : <span aria-disabled="true"><Icon name="next" size={16} /></span>}
            </nav>
          ) : null}
        </div>
      </div>
    </div>
  );
}
