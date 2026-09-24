// Colecciones (réplica de Productos › Colecciones de Shopify): las colecciones de la tienda (diplomados, cursos
// universitarios, talleres, «cursos del diplomado X»…) con sus programas en orden. Todo sale de la BD.
import type { Metadata } from "next";
import { can } from "@/server/auth";
import { services } from "@/server/services";
import { CollectionsManager, type CollectionRow } from "@/components/admin/collections/CollectionsManager";
import { requireAdminPage } from "../../_lib/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Colecciones" };

export default async function CollectionsPage() {
  const user = await requireAdminPage("orders.view", "/admin/collections");
  const db = services().deps.db;
  const [cols, products] = await Promise.all([
    db.collection.findMany({
      orderBy: [{ position: "asc" }, { title: "asc" }],
      include: { diploma: { select: { title: true } }, products: { orderBy: { position: "asc" }, select: { productId: true } } },
    }),
    db.product.findMany({ orderBy: [{ type: "asc" }, { title: "asc" }], select: { id: true, title: true, published: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true } } } }),
  ]);
  const rows: CollectionRow[] = cols.map((c) => ({
    id: c.id,
    title: c.title,
    slug: c.slug,
    descriptionHtml: c.descriptionHtml,
    published: c.published,
    diplomaTitle: c.diploma?.title ?? null,
    productIds: c.products.map((p) => p.productId),
  }));
  return (
    <div className="adm-page">
      <CollectionsManager
        collections={rows}
        products={products.map((p) => ({ id: p.id, title: p.title, published: p.published, image: p.images[0]?.url ?? null }))}
        canEdit={can(user, "catalog.manage")}
      />
    </div>
  );
}
