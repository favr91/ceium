import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "../../_lib/session";
import { listProductRows, PRODUCT_CATEGORIES as CATS, PRODUCT_STATUSES as STATUSES } from "./data";
import { ProductsIndex } from "@/components/admin/products/ProductsIndex";
import { ExportButton } from "@/components/admin/ExportButton";
import { exportOptions, exportQuery } from "@/components/admin/export-options";
import { can } from "@/server/auth";
import type { Category, Status } from "@/components/admin/products/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Programas" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function ProductsPage({ searchParams }: PageProps<"/admin/products">) {
  const user = await requireAdminPage(undefined, "/admin/products");
  const sp = await searchParams;
  const status = (STATUSES as readonly string[]).includes(one(sp.status)) ? (one(sp.status) as Status | "ALL") : "ALL";
  const category = (CATS as readonly string[]).includes(one(sp.category)) ? (one(sp.category) as Category | "ALL") : "ALL";
  const q = one(sp.q);
  const sort = one(sp.sort) || "position";
  const { rows, counts, total } = await listProductRows({ q, status, category, sort });
  const canEdit = can(user, "catalog.manage");
  return (
    <div className="adm-page wide">
      <div className="adm-ph">
        <div className="grow">
          <h1>Programas</h1>
        </div>
        <div className="adm-ph-actions">
          <Link className="btn btn-gray hide-sm" href="/admin/collections">Colecciones</Link>
          <ExportButton
            title="Exportar programas"
            endpoint="/admin/products/export"
            note="Una fila por programa con su lista de precios (online y por sede) y las formas de pago."
            {...exportOptions({
              noun: ["programas", "programa"],
              filters: exportQuery({ status: status !== "ALL" && status, category: category !== "ALL" && category, q, sort: sort !== "position" && sort }),
              filtered: status !== "ALL" || category !== "ALL" || !!q.trim(),
              total: rows.length,
            })}
          />
          {canEdit ? (
            <Link className="btn btn-primary" href="/admin/products/new">Agregar programa</Link>
          ) : null}
        </div>
      </div>
      {!canEdit ? (
        <div className="banner info" role="status">
          <span>Como asistente puedes consultar el catálogo; editar programas y precios es del administrador comercial o del super administrador.</span>
        </div>
      ) : null}
      <ProductsIndex rows={rows} counts={counts} total={total} query={{ q, status, category, sort }} canEdit={canEdit} />
    </div>
  );
}
