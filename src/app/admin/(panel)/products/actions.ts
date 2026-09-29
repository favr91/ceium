"use server";
// Acciones de Programas del panel. Toda escritura pasa por services().catalog (valida, aplica reglas del SPEC
// y deja AuditLog en la misma transacción); aquí solo se traduce el formulario y se ordenan los pasos.
import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { services } from "@/server/services";
import { DomainError, isDomainError } from "@/server/errors";
import { requireAdminAction } from "../../_lib/session";
import { parseMoney } from "@/components/admin/products/money";
import type { MediaDraft, ProductForm, SaveResult } from "@/components/admin/products/types";

type Res = { ok: true } | { ok: false; error: string };

function errMsg(e: unknown): string {
  if (isDomainError(e)) return e.message;
  console.error("[admin/products]", e);
  return "Ocurrió un error inesperado. Intenta de nuevo.";
}

function refresh(id?: string | null) {
  revalidatePath("/admin/products");
  if (id) revalidatePath(`/admin/products/${id}`);
  revalidatePath("/", "layout");
}

const opt = (s: string) => (s.trim() ? s.trim() : null);
const list = (s: string) => {
  const l = s.split("\n").map((x) => x.trim()).filter(Boolean);
  return l.length ? l : null;
};

function productFields(f: ProductForm) {
  const moodle = f.moodleCourseId.trim();
  if (moodle && !/^\d+$/.test(moodle)) throw new DomainError("VALIDATION", "El ID de curso de Moodle debe ser un número entero.");
  return {
    descriptionHtml: f.descriptionHtml,
    excerpt: opt(f.excerpt),
    offersOnline: f.offersOnline,
    offersSemipresencial: f.offersSemipresencial,
    published: f.published,
    ...(f.type === "COURSE" ? { moodleCourseId: moodle ? Number(moodle) : null } : {}),
    requirements: opt(f.requirements),
    certificateTitle: opt(f.certificateTitle),
    certificateText: opt(f.certificateText),
    endorsementTitle: opt(f.endorsementTitle),
    endorsementText: opt(f.endorsementText),
    audience: opt(f.audience),
    duration: opt(f.duration),
    eventDateText: opt(f.eventDateText),
    enrollmentNote: opt(f.enrollmentNote),
    // Día de Venezuela (UTC−4), inclusivo: quote() deja de vender al día siguiente.
    enrollmentDeadline: f.enrollmentDeadline ? new Date(`${f.enrollmentDeadline}T00:00:00-04:00`) : null,
    syllabusUrl: opt(f.syllabusUrl),
    faculty: list(f.faculty),
    benefits: list(f.benefits),
    seoTitle: opt(f.seoTitle),
    seoDescription: opt(f.seoDescription),
  };
}

/**
 * Guarda el programa completo (alta o edición): ficha → cursos del diplomado → precios → planes → colecciones →
 * multimedia (imágenes quitadas y nuevo orden). Cada paso es su propia transacción auditada; si uno falla se
 * informa la sección y lo anterior queda guardado (la página se recarga con el estado real de la BD).
 */
export async function saveProduct(form: ProductForm, media?: MediaDraft): Promise<SaveResult> {
  const user = await requireAdminAction();
  const cat = services().catalog;
  let id = form.id;
  let section = "general";
  const notes: string[] = [];
  try {
    // 1) Ficha
    const fields = productFields(form);
    if (!id) {
      const created = await cat.createProduct(user, { type: form.type, category: form.category, title: form.title, slug: form.slug.trim(), ...fields });
      id = created.id;
    } else {
      // Tipo y categoría se fijan al crear (el servicio no los edita): el formulario los muestra de solo lectura.
      await cat.updateProduct(user, id, { title: form.title, slug: form.slug.trim(), ...fields });
    }

    // 2) Cursos del diplomado (antes de los planes: «mes a mes» = una cuota por curso)
    if (form.type === "DIPLOMA") {
      section = "courses";
      const before = (await prisma.diplomaCourse.findMany({ where: { diplomaId: id }, orderBy: { position: "asc" }, select: { courseId: true } })).map((r) => r.courseId);
      const changed = before.length !== form.courseIds.length || before.some((c, i) => c !== form.courseIds[i]);
      if (changed && form.courseIds.length) {
        const r = await cat.setDiplomaCourses(user, id, form.courseIds);
        if (r.livePurchases) notes.push(`${r.livePurchases} compra(s) vigente(s) conservan la lista de cursos anterior.`);
      } else if (changed && !form.courseIds.length) {
        throw new DomainError("VALIDATION", "El diplomado necesita al menos un curso.");
      }
    }

    // 3) Matriz de precios (solo modalidades ofrecidas)
    section = "prices";
    const existing = await prisma.priceEntry.findMany({ where: { productId: id } });
    for (const c of form.prices) {
      if (c.modality === "ONLINE" && !form.offersOnline) continue;
      if (c.modality === "SEMIPRESENCIAL" && !form.offersSemipresencial) continue;
      const price = parseMoney(c.price);
      const inst = form.type === "DIPLOMA" ? parseMoney(c.installment) : null;
      const prev = existing.find((e) => e.modality === c.modality && (e.sedeId ?? null) === c.sedeId && (e.choiceId ?? null) === c.choiceId);
      if (price === null) {
        if (prev) await cat.deletePrice(user, prev.id, "Precio quitado desde la matriz");
        continue;
      }
      if (Number.isNaN(price) || (inst !== null && Number.isNaN(inst))) throw new DomainError("VALIDATION", "Hay un monto inválido en la matriz de precios (usa números, p. ej. 1420 o 1420.50).");
      if (prev && prev.priceCents === price && (prev.installmentCents ?? null) === inst && prev.active === c.active) continue;
      await cat.upsertPrice(user, { productId: id, modality: c.modality, sedeId: c.sedeId, choiceId: c.choiceId, priceCents: price, ...(form.type === "DIPLOMA" ? { installmentCents: inst } : {}), active: c.active });
    }

    // 4) Planes de pago
    section = "plans";
    const plans = await prisma.paymentPlan.findMany({ where: { productId: id } });
    // El editor lista los planes en un orden fijo (todo, mitad, mes a mes); el orden de la tienda (position: la
    // primera forma de pago es la preseleccionada en la ficha, p. ej. «Paga mes a mes» en los diplomados como en
    // ceium.net) no se toca al guardar. Un plan nuevo va al final.
    let nextPosition = plans.reduce((m, x) => Math.max(m, x.position + 1), 0);
    for (const p of form.plans) {
      const prev = plans.find((x) => x.kind === p.kind);
      const pct = p.kind === "MONTHLY" ? 0 : Number(p.discountPct || 0);
      if (!Number.isInteger(pct)) throw new DomainError("VALIDATION", "El descuento debe ser un porcentaje entero.");
      if (!p.enabled) {
        if (prev) {
          try {
            await cat.deletePlan(user, prev.id);
          } catch (e) {
            if (!isDomainError(e, "CONFLICT")) throw e;
            await cat.upsertPlan(user, { productId: id, kind: p.kind, label: prev.label, active: false });
            notes.push(`«${prev.label}» tiene pedidos: se desactivó en lugar de borrarse.`);
          }
        }
        continue;
      }
      if (prev && prev.label === p.label.trim() && prev.discountPct === pct && prev.active === p.active) continue;
      const position = prev ? prev.position : nextPosition++;
      await cat.upsertPlan(user, { productId: id, kind: p.kind, label: p.label, ...(p.kind === "MONTHLY" ? {} : { discountPct: pct }), position, active: p.active });
    }

    // 5) Colecciones
    section = "organization";
    const current = new Set((await prisma.collectionProduct.findMany({ where: { productId: id }, select: { collectionId: true } })).map((r) => r.collectionId));
    const wanted = new Set(form.collectionIds);
    const touched = [...new Set([...current, ...wanted])].filter((c) => current.has(c) !== wanted.has(c));
    for (const cid of touched) {
      const col = await prisma.collection.findUnique({ where: { id: cid }, include: { products: { orderBy: { position: "asc" }, select: { productId: true } } } });
      if (!col) continue;
      const ids = col.products.map((p) => p.productId).filter((p) => p !== id);
      if (wanted.has(cid)) ids.push(id);
      await cat.upsertCollection(user, { id: col.id, slug: col.slug, title: col.title, productIds: ids });
    }

    // 6) Multimedia: subir es inmediato; quitar y reordenar esperan a «Guardar» (se pueden descartar).
    if (media && (media.remove.length || media.order)) {
      section = "media";
      const current = (await prisma.productImage.findMany({ where: { productId: id }, orderBy: { position: "asc" }, select: { id: true } })).map((r) => r.id);
      const gone = new Set(media.remove.filter((x) => current.includes(x)));
      for (const imageId of gone) await cat.deleteProductImage(user, imageId);
      if (media.order) {
        const left = current.filter((x) => !gone.has(x));
        // Imágenes subidas mientras tanto (p. ej. desde otra pestaña) quedan al final.
        const ids = [...media.order.filter((x) => left.includes(x)), ...left.filter((x) => !media.order!.includes(x))];
        if (ids.join() !== left.join()) await cat.reorderProductImages(user, id, ids);
      }
    }
    refresh(id);
    return { ok: true, id, notes };
  } catch (e) {
    refresh(id);
    return { ok: false, id: id ?? undefined, error: errMsg(e), section, notes };
  }
}

/** Publicar / retirar varios programas (acciones masivas del listado). */
export async function setProductsPublished(ids: string[], published: boolean): Promise<Res & { changed?: number }> {
  const user = await requireAdminAction();
  let changed = 0;
  try {
    for (const id of ids) {
      if (published) await services().catalog.updateProduct(user, id, { published: true });
      else await services().catalog.archiveProduct(user, id);
      changed++;
    }
    refresh();
    return { ok: true, changed };
  } catch (e) {
    refresh();
    return { ok: false, error: errMsg(e) };
  }
}

export async function deleteProductAction(id: string): Promise<Res> {
  const user = await requireAdminAction();
  try {
    await services().catalog.deleteProduct(user, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// ───────── Multimedia (subir y el texto alternativo se guardan al instante; quitar y reordenar, con «Guardar») ─────────

export async function uploadProductImages(productId: string, formData: FormData): Promise<Res> {
  const user = await requireAdminAction();
  try {
    const files = formData.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);
    const url = String(formData.get("url") ?? "").trim();
    if (!files.length && !url) return { ok: false, error: "Elige una imagen o escribe una URL." };
    for (const f of files) await services().catalog.addProductImage(user, productId, { file: { bytes: new Uint8Array(await f.arrayBuffer()) }, alt: null });
    if (url) await services().catalog.addProductImage(user, productId, { url, alt: null });
    refresh(productId);
    return { ok: true };
  } catch (e) {
    refresh(productId);
    return { ok: false, error: errMsg(e) };
  }
}

export async function updateImageAltAction(productId: string, imageId: string, alt: string): Promise<Res> {
  const user = await requireAdminAction();
  try {
    // La imagen debe ser de este programa (el id viene del cliente).
    if (!(await prisma.productImage.findFirst({ where: { id: imageId, productId }, select: { id: true } }))) return { ok: false, error: "La imagen no es de este programa." };
    await services().catalog.updateProductImage(user, imageId, { alt: alt.trim() || null });
    refresh(productId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// ───────── Opciones de compra (cursos/talleres con variantes propias) ─────────

export async function saveChoiceAction(input: { id?: string; productId: string; groupName: string; label: string; moodleCourseIds: string }): Promise<Res> {
  const user = await requireAdminAction();
  try {
    const raw = input.moodleCourseIds.split(/[\s,;]+/).filter(Boolean);
    if (raw.some((x) => !/^\d+$/.test(x))) return { ok: false, error: "Los cursos de Moodle deben ser números separados por coma." };
    await services().catalog.upsertProductChoice(user, { ...(input.id ? { id: input.id } : {}), productId: input.productId, groupName: input.groupName, label: input.label, moodleCourseIds: raw.length ? raw.map(Number) : null });
    refresh(input.productId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function deleteChoiceAction(productId: string, choiceId: string): Promise<Res> {
  const user = await requireAdminAction();
  try {
    if (!(await prisma.productChoice.findFirst({ where: { id: choiceId, productId }, select: { id: true } }))) return { ok: false, error: "La opción no es de este programa." };
    await services().catalog.deleteProductChoice(user, choiceId);
    refresh(productId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
