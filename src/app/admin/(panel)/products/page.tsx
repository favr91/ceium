import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminPage } from "../../_lib/session";
import { listProductRows } from "./data";
import { ProductsIndex } from "@/components/admin/products/ProductsIndex";
import { can } from "@/server/auth";
import type { Category, Status } from "@/components/admin/products/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Programas" };

const STATUSES = ["ALL", "ACTIVE", "DRAFT", "ARCHIVED"] as const;
const CATS = ["ALL", "DIPLOMA", "UNIVERSITY_COURSE", "ADVANCED_COURSE", "WORKSHOP"] as const;
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
          {canEdit ? (
            <Link className="btn btn-primary" href="/admin/products/new">Agregar programa</Link>
          ) : null}
        </div>
      </div>
      {!canEdit ? (
        <div className="banner info" role="status">
          <span>Tu rol (personal) puede consultar el catálogo, pero solo un administrador puede editar programas y precios.</span>
        </div>
      ) : null}
      <ProductsIndex rows={rows} counts={counts} total={total} query={{ q, status, category, sort }} canEdit={canEdit} />
    </div>
  );
}
