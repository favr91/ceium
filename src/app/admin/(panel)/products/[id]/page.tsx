import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@/server/auth";
import { requireAdminPage } from "../../../_lib/session";
import { productEditor } from "../data";
import { ProductEditor } from "@/components/admin/products/ProductEditor";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/admin/products/[id]">): Promise<Metadata> {
  const { id } = await params;
  const data = await productEditor(id);
  return { title: data?.form.title ?? "Programa" };
}

export default async function ProductPage({ params }: PageProps<"/admin/products/[id]">) {
  const { id } = await params;
  const user = await requireAdminPage(undefined, `/admin/products/${id}`);
  const data = await productEditor(id);
  if (!data) notFound();
  return <ProductEditor key={id} initial={data.form} ctx={data.ctx} canEdit={can(user, "catalog.manage")} />;
}
