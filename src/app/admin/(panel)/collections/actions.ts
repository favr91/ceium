"use server";
// Acciones de Colecciones del panel: toda escritura pasa por services().catalog (valida, deja AuditLog).
import { revalidatePath } from "next/cache";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { requireAdminAction } from "../../_lib/session";

export type CollectionResult = { ok: true; id?: string } | { ok: false; error: string };

export interface CollectionInput {
  id?: string;
  title: string;
  slug: string;
  descriptionHtml: string;
  published: boolean;
  productIds: string[];
}

function fail(e: unknown): CollectionResult {
  if (isDomainError(e)) return { ok: false, error: e.message };
  console.error("[admin/collections]", e);
  return { ok: false, error: "Ocurrió un error inesperado. Intenta de nuevo." };
}
function refresh() {
  revalidatePath("/admin/collections");
  revalidatePath("/", "layout");
}

export async function saveCollection(input: CollectionInput): Promise<CollectionResult> {
  const user = await requireAdminAction();
  try {
    const c = await services().catalog.upsertCollection(user, {
      ...(input.id ? { id: input.id } : {}),
      title: input.title.trim(),
      slug: input.slug.trim(),
      descriptionHtml: input.descriptionHtml,
      published: input.published,
      productIds: input.productIds,
    });
    refresh();
    return { ok: true, id: c.id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteCollectionAction(id: string): Promise<CollectionResult> {
  const user = await requireAdminAction();
  try {
    await services().catalog.deleteCollection(user, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
