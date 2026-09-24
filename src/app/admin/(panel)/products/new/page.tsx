import type { Metadata } from "next";
import { requireAdminPage } from "../../../_lib/session";
import { newProductEditor } from "../data";
import { ProductEditor } from "@/components/admin/products/ProductEditor";
import { CATEGORY_ORDER, type Category } from "@/components/admin/products/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Agregar programa" };

export default async function NewProductPage({ searchParams }: PageProps<"/admin/products/new">) {
  await requireAdminPage("catalog.manage", "/admin/products/new");
  const sp = await searchParams;
  const raw = typeof sp.category === "string" ? sp.category : "";
  const category: Category = (CATEGORY_ORDER as string[]).includes(raw) ? (raw as Category) : "UNIVERSITY_COURSE";
  const data = await newProductEditor(category === "DIPLOMA" ? "DIPLOMA" : "COURSE", category);
  return <ProductEditor initial={data.form} ctx={data.ctx} canEdit />;
}
