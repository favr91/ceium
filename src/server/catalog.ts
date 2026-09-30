// Catálogo desde el panel: fichas de programa, precios, planes de pago, colecciones, sedes y cursos de
// diplomado. Toda escritura valida, aplica las reglas del SPEC y deja su registro en AuditLog en la MISMA
// transacción. El panel no debe escribir estas tablas con prisma directamente.
// Cubre: programas (alta, edición, archivo, baja), precios, planes, colecciones, sedes, cursos de diplomado,
// imágenes (subidas a public/uploads) y opciones de compra (ProductChoice).
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps, type Tx } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";
import { priceScopeKey } from "@/server/pricing";
import { sanitizeRichText } from "@/server/rich-text";
import { removeFiles, removeUploadedImage, storeOptimizedImage, UPLOADS_URL } from "@/server/uploads";

/** Pedidos que siguen su curso (en pago, pagados o matriculados). */
const LIVE_ORDER_STATES = ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"] as const;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("VALIDATION", r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join(". "), { issues: r.error.issues });
  return r.data;
}

const json = (v: unknown) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
const slug = z.string().trim().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug inválido (minúsculas, números y guiones)");
const cents = z.number().int("Monto en centavos enteros").min(0).max(100_000_000);

async function mustProduct(tx: Tx, id: string) {
  const p = await tx.product.findUnique({ where: { id } });
  if (!p) throw new DomainError("NOT_FOUND", "El programa no existe.");
  return p;
}

// ───────────── Programas ─────────────

export const updateProductSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    slug,
    descriptionHtml: z.string().max(200_000).transform(sanitizeRichText),
    excerpt: z.string().max(2000).nullable(),
    offersOnline: z.boolean(),
    offersSemipresencial: z.boolean(),
    requirements: z.string().max(5000).nullable(),
    certificateTitle: z.string().max(300).nullable(),
    certificateText: z.string().max(5000).nullable(),
    endorsementTitle: z.string().max(300).nullable(),
    endorsementText: z.string().max(5000).nullable(),
    audience: z.string().max(5000).nullable(),
    duration: z.string().max(300).nullable(),
    eventDateText: z.string().max(300).nullable(),
    enrollmentNote: z.string().max(1000).nullable(),
    /** Último día de inscripción (inclusivo). quote()/createCheckout dejan de vender al día siguiente. */
    enrollmentDeadline: z.coerce.date().nullable(),
    syllabusUrl: z.string().max(1000).regex(/^(https:\/\/|\/(?!\/))\S*$/, "El enlace del contenido descargable debe empezar por https://").nullable(),
    topics: z.array(z.object({ title: z.string(), heading: z.string().optional(), items: z.array(z.string()) })).nullable(),
    faculty: z.array(z.string()).nullable(),
    benefits: z.array(z.string()).nullable(),
    moodleCourseId: z.number().int().positive().nullable(),
    published: z.boolean(),
    position: z.number().int(),
    seoTitle: z.string().max(300).nullable(),
    seoDescription: z.string().max(1000).nullable(),
  })
  .partial()
  .strict();
export type UpdateProductInput = z.input<typeof updateProductSchema>;

export async function updateProduct(d: Deps, actor: SessionUser, productId: string, input: UpdateProductInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const patch = parse(updateProductSchema, input);
  return withTx(d, async (tx) => {
    const before = await mustProduct(tx, productId);
    if (patch.moodleCourseId != null && before.type !== "COURSE") throw new DomainError("VALIDATION", "Solo los cursos tienen curso de Moodle; un diplomado matricula los cursos que lo componen.");
    const online = patch.offersOnline ?? before.offersOnline;
    const semi = patch.offersSemipresencial ?? before.offersSemipresencial;
    if (!online && !semi) throw new DomainError("VALIDATION", "El programa debe ofrecerse en al menos una modalidad.");
    const { topics, faculty, benefits, ...rest } = patch;
    let after;
    try {
      after = await tx.product.update({
        where: { id: productId },
        data: {
          ...rest,
          ...(patch.published === true && !before.publishedAt ? { publishedAt: d.now() } : {}),
          ...(topics !== undefined ? { topics: json(topics) } : {}),
          ...(faculty !== undefined ? { faculty: json(faculty) } : {}),
          ...(benefits !== undefined ? { benefits: json(benefits) } : {}),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya existe otro programa con ese slug o curso de Moodle.");
      throw e;
    }
    await recordAudit(tx, { actor, action: "product.update", entityType: "Product", entityId: productId, before, after, note });
    return after;
  });
}

// ───────────── Precios ─────────────

export const upsertPriceSchema = z
  .object({
    productId: z.string().min(1),
    modality: z.enum(["ONLINE", "SEMIPRESENCIAL"]),
    sedeId: z.string().min(1).nullable().optional(),
    choiceId: z.string().min(1).nullable().optional(),
    priceCents: cents.refine((v) => v > 0, "El precio debe ser mayor que 0"),
    installmentCents: cents.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpsertPriceInput = z.input<typeof upsertPriceSchema>;

/** Crea o actualiza el precio de un alcance (modalidad + sede + opción). ONLINE ⇒ sin sede; SEMIPRESENCIAL ⇒ con sede. */
export async function upsertPrice(d: Deps, actor: SessionUser, input: UpsertPriceInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const p = parse(upsertPriceSchema, input);
  const sedeId = p.modality === "ONLINE" ? null : (p.sedeId ?? null);
  if (p.modality === "ONLINE" && p.sedeId) throw new DomainError("VALIDATION", "El precio online no lleva sede.");
  if (p.modality === "SEMIPRESENCIAL" && !sedeId) throw new DomainError("VALIDATION", "El precio semipresencial requiere una sede.");
  return withTx(d, async (tx) => {
    const product = await mustProduct(tx, p.productId);
    if (p.modality === "ONLINE" && !product.offersOnline) throw new DomainError("VALIDATION", "Este programa no se ofrece online.");
    if (p.modality === "SEMIPRESENCIAL" && !product.offersSemipresencial) throw new DomainError("VALIDATION", "Este programa no se ofrece semipresencial.");
    if (sedeId && !(await tx.sede.findUnique({ where: { id: sedeId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "La sede no existe.");
    if (p.choiceId && !(await tx.productChoice.findFirst({ where: { id: p.choiceId, productId: p.productId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "La opción no pertenece a este programa.");
    if (p.installmentCents != null && product.type !== "DIPLOMA") throw new DomainError("VALIDATION", "La cuota mensual solo se aplica a diplomados (plan «Paga mes a mes»).");
    const scopeKey = priceScopeKey({ modality: p.modality, sedeId, choiceId: p.choiceId ?? null });
    const before = await tx.priceEntry.findUnique({ where: { productId_scopeKey: { productId: p.productId, scopeKey } } });
    const data = { priceCents: p.priceCents, ...(p.installmentCents !== undefined ? { installmentCents: p.installmentCents } : {}), ...(p.active !== undefined ? { active: p.active } : {}) };
    const after = before
      ? await tx.priceEntry.update({ where: { id: before.id }, data })
      : await tx.priceEntry.create({ data: { productId: p.productId, modality: p.modality, sedeId, choiceId: p.choiceId ?? null, scopeKey, ...data } });
    await recordAudit(tx, { actor, action: before ? "price.update" : "price.create", entityType: "PriceEntry", entityId: after.id, before, after, note, force: !before });
    return after;
  });
}

/** Desactiva (no borra: los pedidos históricos conservan su precio en OrderItem) un precio. */
export async function setPriceActive(d: Deps, actor: SessionUser, priceId: string, active: boolean, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  return withTx(d, async (tx) => {
    const before = await tx.priceEntry.findUnique({ where: { id: priceId } });
    if (!before) throw new DomainError("NOT_FOUND", "El precio no existe.");
    const after = await tx.priceEntry.update({ where: { id: priceId }, data: { active } });
    await recordAudit(tx, { actor, action: "price.update", entityType: "PriceEntry", entityId: priceId, before, after, note });
    return after;
  });
}

// ───────────── Planes de pago ─────────────

export const upsertPlanSchema = z
  .object({
    productId: z.string().min(1),
    kind: z.enum(["FULL", "HALF", "MONTHLY"]),
    label: z.string().trim().min(1).max(200),
    discountPct: z.number().int().min(0).max(90).optional(),
    installments: z.number().int().min(1).max(36).optional(),
    position: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpsertPlanInput = z.input<typeof upsertPlanSchema>;

export async function upsertPlan(d: Deps, actor: SessionUser, input: UpsertPlanInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const p = parse(upsertPlanSchema, input);
  return withTx(d, async (tx) => {
    const product = await mustProduct(tx, p.productId);
    let installments = p.installments;
    if (p.kind === "FULL") installments = 1;
    if (p.kind === "HALF") installments = 2;
    if (p.kind === "MONTHLY") {
      if (product.type !== "DIPLOMA") throw new DomainError("VALIDATION", "«Paga mes a mes» es solo para diplomados.");
      // Una cuota por curso del diplomado (cada cuota habilita un curso).
      installments = await tx.diplomaCourse.count({ where: { diplomaId: product.id } });
      if (!installments) throw new DomainError("VALIDATION", "El diplomado no tiene cursos: agrégalos antes de habilitar «Paga mes a mes».");
      if (p.discountPct) throw new DomainError("VALIDATION", "«Paga mes a mes» no lleva descuento.");
    }
    const before = await tx.paymentPlan.findUnique({ where: { productId_kind: { productId: p.productId, kind: p.kind } } });
    const data = { label: p.label, installments: installments ?? 1, ...(p.discountPct !== undefined ? { discountPct: p.discountPct } : {}), ...(p.position !== undefined ? { position: p.position } : {}), ...(p.active !== undefined ? { active: p.active } : {}) };
    const after = before ? await tx.paymentPlan.update({ where: { id: before.id }, data }) : await tx.paymentPlan.create({ data: { productId: p.productId, kind: p.kind, ...data } });
    await recordAudit(tx, { actor, action: before ? "plan.update" : "plan.create", entityType: "PaymentPlan", entityId: after.id, before, after, note, force: !before });
    return after;
  });
}

// ───────────── Colecciones ─────────────

export const upsertCollectionSchema = z
  .object({
    id: z.string().min(1).optional(),
    slug,
    title: z.string().trim().min(1).max(300),
    descriptionHtml: z.string().max(100_000).optional(),
    imageUrl: z.string().max(1000).nullable().optional(),
    published: z.boolean().optional(),
    position: z.number().int().optional(),
    diplomaId: z.string().min(1).nullable().optional(),
    /** Orden de los programas; si se pasa reemplaza la lista completa. */
    productIds: z.array(z.string().min(1)).max(500).optional(),
  })
  .strict();
export type UpsertCollectionInput = z.input<typeof upsertCollectionSchema>;

async function collectionSnapshot(tx: Tx, id: string) {
  const c = await tx.collection.findUnique({ where: { id }, include: { products: { orderBy: { position: "asc" }, select: { productId: true } } } });
  if (!c) return null;
  const { products, ...rest } = c;
  return { ...rest, productIds: products.map((p) => p.productId) };
}

export async function upsertCollection(d: Deps, actor: SessionUser, input: UpsertCollectionInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const p = parse(upsertCollectionSchema, input);
  return withTx(d, async (tx) => {
    const before = p.id ? await collectionSnapshot(tx, p.id) : null;
    if (p.id && !before) throw new DomainError("NOT_FOUND", "La colección no existe.");
    if (p.diplomaId) {
      const dip = await tx.product.findUnique({ where: { id: p.diplomaId }, select: { type: true } });
      if (dip?.type !== "DIPLOMA") throw new DomainError("VALIDATION", "La colección debe apuntar a un diplomado.");
    }
    if (p.productIds) {
      const unique = [...new Set(p.productIds)];
      const found = await tx.product.count({ where: { id: { in: unique } } });
      if (found !== unique.length) throw new DomainError("VALIDATION", "Algún programa de la colección no existe.");
    }
    const data = {
      slug: p.slug,
      title: p.title,
      ...(p.descriptionHtml !== undefined ? { descriptionHtml: p.descriptionHtml } : {}),
      ...(p.imageUrl !== undefined ? { imageUrl: p.imageUrl } : {}),
      ...(p.published !== undefined ? { published: p.published } : {}),
      ...(p.position !== undefined ? { position: p.position } : {}),
      ...(p.diplomaId !== undefined ? { diplomaId: p.diplomaId } : {}),
    };
    let id: string;
    try {
      id = before ? (await tx.collection.update({ where: { id: before.id }, data })).id : (await tx.collection.create({ data })).id;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya existe una colección con ese slug.");
      throw e;
    }
    if (p.productIds) {
      await tx.collectionProduct.deleteMany({ where: { collectionId: id } });
      const unique = [...new Set(p.productIds)];
      for (let i = 0; i < unique.length; i++) await tx.collectionProduct.create({ data: { collectionId: id, productId: unique[i], position: i } });
    }
    const after = await collectionSnapshot(tx, id);
    await recordAudit(tx, { actor, action: before ? "collection.update" : "collection.create", entityType: "Collection", entityId: id, before, after, note, force: !before });
    return after!;
  });
}

// ───────────── Sedes ─────────────

export const upsertSedeSchema = z
  .object({
    id: z.string().min(1).optional(),
    slug,
    name: z.string().trim().min(1).max(200),
    city: z.string().max(200).nullable().optional(),
    address: z.string().max(1000).nullable().optional(),
    phone: z.string().max(100).nullable().optional(),
    mapUrl: z.string().max(1000).nullable().optional(),
    active: z.boolean().optional(),
    position: z.number().int().optional(),
  })
  .strict();
export type UpsertSedeInput = z.input<typeof upsertSedeSchema>;

export async function upsertSede(d: Deps, actor: SessionUser, input: UpsertSedeInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const { id, ...data } = parse(upsertSedeSchema, input);
  return withTx(d, async (tx) => {
    const before = id ? await tx.sede.findUnique({ where: { id } }) : null;
    if (id && !before) throw new DomainError("NOT_FOUND", "La sede no existe.");
    let after;
    try {
      after = before ? await tx.sede.update({ where: { id: before.id }, data }) : await tx.sede.create({ data });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya existe una sede con ese slug.");
      throw e;
    }
    await recordAudit(tx, { actor, action: before ? "sede.update" : "sede.create", entityType: "Sede", entityId: after.id, before, after, note, force: !before });
    return after;
  });
}

// ───────────── Cursos de un diplomado ─────────────

/**
 * Reemplaza la lista ordenada de cursos de un diplomado. Mantiene «Paga mes a mes» coherente: una cuota por
 * curso (PaymentPlan MONTHLY.installments = nº de cursos). Solo afecta a las compras NUEVAS: cada pedido
 * congela su lista al comprar (OrderItemCourse) y con ella se matricula, se comprueba la finalización y se
 * imprime el certificado; los pedidos ya creados conservan también su calendario de cuotas. Los pedidos
 * antiguos sin lista congelada se congelan aquí con la lista anterior antes de aplicar el cambio.
 * Devuelve cuántas compras vigentes conservan el programa anterior (el panel lo muestra al guardar).
 */
export async function setDiplomaCourses(d: Deps, actor: SessionUser, diplomaId: string, courseIds: string[], note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const ids = parse(z.array(z.string().min(1)).min(1, "El diplomado necesita al menos un curso").max(50), courseIds);
  if (new Set(ids).size !== ids.length) throw new DomainError("VALIDATION", "Hay cursos repetidos.");
  return withTx(d, async (tx) => {
    const dip = await mustProduct(tx, diplomaId);
    if (dip.type !== "DIPLOMA") throw new DomainError("VALIDATION", "El programa no es un diplomado.");
    const courses = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, moodleCourseId: true } });
    if (courses.length !== ids.length || courses.some((c) => c.type !== "COURSE")) throw new DomainError("VALIDATION", "Todos deben ser cursos existentes.");
    if (courses.some((c) => c.moodleCourseId == null)) throw new DomainError("VALIDATION", "Todos los cursos del diplomado deben tener curso de Moodle.");
    const before = (await tx.diplomaCourse.findMany({ where: { diplomaId }, orderBy: { position: "asc" }, select: { courseId: true } })).map((r) => r.courseId);
    // Congelar la lista anterior en las compras que aún no la tienen (pedidos previos a OrderItemCourse).
    const unfrozen = await tx.orderItem.findMany({ where: { productId: diplomaId, courses: { none: {} } }, select: { id: true } });
    if (before.length) for (const it of unfrozen) await tx.orderItemCourse.createMany({ data: before.map((courseId, i) => ({ orderItemId: it.id, courseId, position: i + 1 })) });
    const changed = before.length !== ids.length || before.some((c, i) => c !== ids[i]);
    const livePurchases = changed ? await tx.orderItem.count({ where: { productId: diplomaId, order: { status: { in: [...LIVE_ORDER_STATES] } } } }) : 0;
    const keep = new Map((await tx.diplomaCourse.findMany({ where: { diplomaId } })).map((r) => [r.courseId, r]));
    await tx.diplomaCourse.deleteMany({ where: { diplomaId, courseId: { notIn: ids } } });
    for (let i = 0; i < ids.length; i++) {
      if (keep.has(ids[i])) await tx.diplomaCourse.update({ where: { id: keep.get(ids[i])!.id }, data: { position: i + 1 } });
      else await tx.diplomaCourse.create({ data: { diplomaId, courseId: ids[i], position: i + 1 } });
    }
    const monthly = await tx.paymentPlan.findUnique({ where: { productId_kind: { productId: diplomaId, kind: "MONTHLY" } } });
    if (monthly && monthly.installments !== ids.length) {
      const updated = await tx.paymentPlan.update({ where: { id: monthly.id }, data: { installments: ids.length } });
      await recordAudit(tx, { actor, action: "plan.update", entityType: "PaymentPlan", entityId: monthly.id, before: monthly, after: updated, note: "Cuotas = n.º de cursos del diplomado" });
    }
    const frozenNote = livePurchases ? (livePurchases === 1 ? "1 compra vigente conserva" : `${livePurchases} compras vigentes conservan`) + " la lista de cursos anterior" : undefined;
    await recordAudit(tx, { actor, action: "diploma.courses", entityType: "DiplomaCourse", entityId: diplomaId, before: { courseIds: before }, after: { courseIds: ids }, note: [note, frozenNote].filter(Boolean).join(" · ") || undefined });
    return { courseIds: ids, livePurchases };
  });
}

// ───────────── Alta / baja de programas ─────────────

export const createProductSchema = z
  .object({
    type: z.enum(["COURSE", "DIPLOMA"]),
    category: z.enum(["UNIVERSITY_COURSE", "ADVANCED_COURSE", "WORKSHOP", "DIPLOMA"]),
    title: z.string().trim().min(1).max(300),
    slug,
  })
  .strict();
export type CreateProductInput = z.input<typeof createProductSchema> & UpdateProductInput;

/**
 * Alta de un programa. Nace SIN publicar (salvo `published: true` explícito): primero se cargan precios,
 * planes e imágenes. Un diplomado va con la categoría DIPLOMA y no lleva curso de Moodle propio.
 */
export async function createProduct(d: Deps, actor: SessionUser, input: CreateProductInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const { type, category, title, slug: s, ...rest } = input;
  const base = parse(createProductSchema, { type, category, title, slug: s });
  const extra = parse(updateProductSchema, rest);
  if ((base.type === "DIPLOMA") !== (base.category === "DIPLOMA")) throw new DomainError("VALIDATION", "Un diplomado usa la categoría «Diplomado» (y solo los diplomados).");
  if (base.type === "DIPLOMA" && extra.moodleCourseId != null) throw new DomainError("VALIDATION", "Solo los cursos tienen curso de Moodle; un diplomado matricula los cursos que lo componen.");
  if (extra.offersOnline === false && extra.offersSemipresencial === false) throw new DomainError("VALIDATION", "El programa debe ofrecerse en al menos una modalidad.");
  return withTx(d, async (tx) => {
    const { topics, faculty, benefits, ...fields } = extra;
    const published = extra.published ?? false;
    let after;
    try {
      after = await tx.product.create({
        data: {
          ...fields,
          ...base,
          published,
          publishedAt: published ? d.now() : null,
          ...(topics !== undefined ? { topics: json(topics) } : {}),
          ...(faculty !== undefined ? { faculty: json(faculty) } : {}),
          ...(benefits !== undefined ? { benefits: json(benefits) } : {}),
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya existe otro programa con ese slug o curso de Moodle.");
      throw e;
    }
    await recordAudit(tx, { actor, action: "product.create", entityType: "Product", entityId: after.id, before: null, after, note, force: true });
    return after;
  });
}

/** Archivar = despublicar (sale de la tienda; pedidos, matrículas y certificados siguen intactos). */
export async function archiveProduct(d: Deps, actor: SessionUser, productId: string, note?: string) {
  return updateProduct(d, actor, productId, { published: false }, note ?? "Archivado");
}

/**
 * Borra un programa que nunca se vendió ni se usó (sin pedidos, matrículas, certificados, ni como curso de un
 * diplomado). Se llevan en cascada sus precios, planes, opciones, imágenes y cohortes sin ventas. Si ya tuvo
 * uso, hay que archivarlo.
 */
export async function deleteProduct(d: Deps, actor: SessionUser, productId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const res = await withTx(d, async (tx) => {
    const before = await mustProduct(tx, productId);
    const [items, enrollments, certs, asCourse, purchasedInDiploma, installments, reservations, images] = await Promise.all([
      tx.orderItem.count({ where: { productId } }),
      tx.enrollment.count({ where: { productId } }),
      tx.certificate.count({ where: { diplomaId: productId } }),
      tx.diplomaCourse.count({ where: { courseId: productId } }),
      tx.orderItemCourse.count({ where: { courseId: productId } }),
      tx.installment.count({ where: { courseId: productId } }),
      tx.seatReservation.count({ where: { cohort: { productId } } }),
      tx.productImage.findMany({ where: { productId }, select: { url: true } }),
    ]);
    if (items || enrollments || certs || purchasedInDiploma || installments || reservations) throw new DomainError("CONFLICT", "El programa ya tiene pedidos, matrículas o certificados: archívalo (despublícalo) en lugar de borrarlo.");
    if (asCourse) throw new DomainError("CONFLICT", "El curso forma parte de un diplomado: quítalo del diplomado antes de borrarlo.");
    await tx.product.delete({ where: { id: productId } });
    await recordAudit(tx, { actor, action: "product.delete", entityType: "Product", entityId: productId, before, after: null, note, force: true });
    return { deleted: true as const, images: images.map((i) => i.url) };
  });
  for (const url of res.images) await removeUploadedFile(d, url, productId);
  return { deleted: true as const };
}

// ───────────── Baja de precios, planes y colecciones ─────────────

/** Borra un precio (OrderItem guarda su propio precio: los pedidos no se afectan). Para ocultarlo sin borrar: setPriceActive. */
export async function deletePrice(d: Deps, actor: SessionUser, priceId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  return withTx(d, async (tx) => {
    const before = await tx.priceEntry.findUnique({ where: { id: priceId } });
    if (!before) throw new DomainError("NOT_FOUND", "El precio no existe.");
    await tx.priceEntry.delete({ where: { id: priceId } });
    await recordAudit(tx, { actor, action: "price.delete", entityType: "PriceEntry", entityId: priceId, before, after: null, note, force: true });
    return { deleted: true as const };
  });
}

/** Borra un plan de pago que ningún pedido usa; si ya se usó, se desactiva (active: false vía upsertPlan). */
export async function deletePlan(d: Deps, actor: SessionUser, planId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  return withTx(d, async (tx) => {
    const before = await tx.paymentPlan.findUnique({ where: { id: planId } });
    if (!before) throw new DomainError("NOT_FOUND", "El plan no existe.");
    if (await tx.orderItem.count({ where: { paymentPlanId: planId } })) throw new DomainError("CONFLICT", "Hay pedidos con este plan: desactívalo en lugar de borrarlo.");
    await tx.paymentPlan.delete({ where: { id: planId } });
    await recordAudit(tx, { actor, action: "plan.delete", entityType: "PaymentPlan", entityId: planId, before, after: null, note, force: true });
    return { deleted: true as const };
  });
}

/** Borra una colección (los programas no se tocan). Para ocultarla sin borrar: upsertCollection con published: false. */
export async function deleteCollection(d: Deps, actor: SessionUser, collectionId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  return withTx(d, async (tx) => {
    const before = await collectionSnapshot(tx, collectionId);
    if (!before) throw new DomainError("NOT_FOUND", "La colección no existe.");
    await tx.collection.delete({ where: { id: collectionId } });
    await recordAudit(tx, { actor, action: "collection.delete", entityType: "Collection", entityId: collectionId, before, after: null, note, force: true });
    return { deleted: true as const };
  });
}

// ───────────── Imágenes de programa (public/uploads) ─────────────

const productDir = (productId: string) => productId.replace(/[^a-z0-9]/gi, "");

/** Borra los archivos de una imagen subida, solo si están en la carpeta de ESTE programa (products/<id>/). */
const removeUploadedFile = (d: Deps, url: string, productId: string) => removeUploadedImage(d, url, `products/${productDir(productId)}`);

export const productImageMetaSchema = z
  .object({
    alt: z.string().trim().max(300).nullable().optional(),
    width: z.number().int().positive().max(20_000).nullable().optional(),
    height: z.number().int().positive().max(20_000).nullable().optional(),
  })
  .strict();

export interface AddProductImageInput extends z.input<typeof productImageMetaSchema> {
  /**
   * Archivo subido desde el panel: se optimiza (ver server/images.ts) y se guarda en
   * <uploads>/products/<id>/<slug>-<hex>-w<ancho>.webp (un archivo por ancho) + <slug>-<hex>-og.jpg.
   */
  file?: { bytes: Uint8Array };
  /** O una URL ya alojada (https://… o /uploads/…). */
  url?: string;
}

/** Agrega una imagen al final de la galería del programa. */
export async function addProductImage(d: Deps, actor: SessionUser, productId: string, input: AddProductImageInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const { file, url: givenUrl, ...metaIn } = input;
  const meta = parse(productImageMetaSchema, metaIn);
  if (!!file === !!givenUrl) throw new DomainError("VALIDATION", "Sube un archivo o indica una URL (solo uno).");
  if (givenUrl && !/^(https:\/\/|\/uploads\/)[^\s]+$/.test(givenUrl)) throw new DomainError("VALIDATION", "La URL de la imagen debe empezar por https:// o /uploads/.");
  // Una imagen subida a OTRO programa no se enlaza: al quitarla de aquí se borrarían los archivos de aquel.
  if (givenUrl?.startsWith(UPLOADS_URL) && !givenUrl.startsWith(`${UPLOADS_URL}products/${productDir(productId)}/`)) {
    throw new DomainError("VALIDATION", "Esa imagen pertenece a otro programa: súbela de nuevo aquí.");
  }
  const product = await withTx(d, (tx) => mustProduct(tx, productId));

  let url = givenUrl ?? "";
  let written: string[] = [];
  if (file) {
    const img = await storeOptimizedImage(d, `products/${productDir(productId)}`, product.slug, file.bytes);
    written = img.files;
    url = img.url;
    meta.width ??= img.width;
    meta.height ??= img.height;
  }
  try {
    return await withTx(d, async (tx) => {
      await mustProduct(tx, productId);
      const last = await tx.productImage.findFirst({ where: { productId }, orderBy: { position: "desc" }, select: { position: true } });
      const after = await tx.productImage.create({ data: { productId, url, alt: meta.alt ?? null, width: meta.width ?? null, height: meta.height ?? null, position: (last?.position ?? -1) + 1 } });
      await recordAudit(tx, { actor, action: "image.create", entityType: "ProductImage", entityId: after.id, before: null, after, note, force: true });
      return after;
    });
  } catch (e) {
    await removeFiles(written);
    throw e;
  }
}

export async function updateProductImage(d: Deps, actor: SessionUser, imageId: string, input: z.input<typeof productImageMetaSchema>, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const meta = parse(productImageMetaSchema, input);
  return withTx(d, async (tx) => {
    const before = await tx.productImage.findUnique({ where: { id: imageId } });
    if (!before) throw new DomainError("NOT_FOUND", "La imagen no existe.");
    const after = await tx.productImage.update({ where: { id: imageId }, data: meta });
    await recordAudit(tx, { actor, action: "image.update", entityType: "ProductImage", entityId: imageId, before, after, note });
    return after;
  });
}

/** Reordena la galería: `imageIds` debe ser la lista COMPLETA de imágenes del programa en el orden nuevo. */
export async function reorderProductImages(d: Deps, actor: SessionUser, productId: string, imageIds: string[], note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const ids = parse(z.array(z.string().min(1)).max(200), imageIds);
  return withTx(d, async (tx) => {
    const current = await tx.productImage.findMany({ where: { productId }, orderBy: { position: "asc" }, select: { id: true } });
    const set = new Set(ids);
    if (set.size !== ids.length || ids.length !== current.length || current.some((c) => !set.has(c.id))) throw new DomainError("VALIDATION", "La lista debe contener exactamente las imágenes del programa, sin repetir.");
    for (let i = 0; i < ids.length; i++) await tx.productImage.update({ where: { id: ids[i] }, data: { position: i } });
    await recordAudit(tx, { actor, action: "image.reorder", entityType: "ProductImage", entityId: productId, before: { imageIds: current.map((c) => c.id) }, after: { imageIds: ids }, note });
    return { imageIds: ids };
  });
}

/** Quita la imagen (y su archivo si estaba en /uploads). */
export async function deleteProductImage(d: Deps, actor: SessionUser, imageId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const before = await withTx(d, async (tx) => {
    const row = await tx.productImage.findUnique({ where: { id: imageId } });
    if (!row) throw new DomainError("NOT_FOUND", "La imagen no existe.");
    await tx.productImage.delete({ where: { id: imageId } });
    await recordAudit(tx, { actor, action: "image.delete", entityType: "ProductImage", entityId: imageId, before: row, after: null, note, force: true });
    return row;
  });
  const stillUsed = await d.db.productImage.count({ where: { url: before.url } });
  if (!stillUsed) await removeUploadedFile(d, before.url, before.productId);
  return { deleted: true as const };
}

// ───────────── Opciones de compra (ProductChoice) ─────────────

export const upsertChoiceSchema = z
  .object({
    id: z.string().min(1).optional(),
    productId: z.string().min(1),
    /** Título del selector en la ficha, p.ej. "Cursos disponibles". */
    groupName: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200),
    position: z.number().int().optional(),
    /** Cursos de Moodle que otorga la opción; null → el curso del programa. */
    moodleCourseIds: z.array(z.number().int().positive()).min(1).max(20).nullable().optional(),
  })
  .strict();
export type UpsertChoiceInput = z.input<typeof upsertChoiceSchema>;

/**
 * Crea o edita una opción de compra (p.ej. taller transfontanelar: «Nivel 1» → [127], «Todo el taller» →
 * [127, 128]). Cada opción necesita luego su precio (upsertPrice con choiceId).
 */
export async function upsertProductChoice(d: Deps, actor: SessionUser, input: UpsertChoiceInput, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const p = parse(upsertChoiceSchema, input);
  if (p.moodleCourseIds && new Set(p.moodleCourseIds).size !== p.moodleCourseIds.length) throw new DomainError("VALIDATION", "Hay cursos de Moodle repetidos.");
  return withTx(d, async (tx) => {
    const product = await mustProduct(tx, p.productId);
    if (product.type !== "COURSE") throw new DomainError("VALIDATION", "Las opciones de compra son para cursos y talleres; un diplomado usa sus cursos.");
    const before = p.id ? await tx.productChoice.findUnique({ where: { id: p.id } }) : null;
    if (p.id && (!before || before.productId !== p.productId)) throw new DomainError("NOT_FOUND", "La opción no existe en este programa.");
    let position = p.position;
    if (position === undefined && !before) position = ((await tx.productChoice.findFirst({ where: { productId: p.productId }, orderBy: { position: "desc" }, select: { position: true } }))?.position ?? -1) + 1;
    const data = {
      groupName: p.groupName,
      label: p.label,
      ...(position !== undefined ? { position } : {}),
      ...(p.moodleCourseIds !== undefined ? { moodleCourseIds: json(p.moodleCourseIds) } : {}),
    };
    let after;
    try {
      after = before ? await tx.productChoice.update({ where: { id: before.id }, data }) : await tx.productChoice.create({ data: { productId: p.productId, ...data } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError("CONFLICT", "Ya existe una opción con ese nombre en este programa.");
      throw e;
    }
    await recordAudit(tx, { actor, action: before ? "choice.update" : "choice.create", entityType: "ProductChoice", entityId: after.id, before, after, note, force: !before });
    return after;
  });
}

/** Borra una opción que ningún pedido usa (se llevan sus precios). Si ya se vendió, desactiva sus precios. */
export async function deleteProductChoice(d: Deps, actor: SessionUser, choiceId: string, note?: string) {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  return withTx(d, async (tx) => {
    const before = await tx.productChoice.findUnique({ where: { id: choiceId }, include: { prices: true } });
    if (!before) throw new DomainError("NOT_FOUND", "La opción no existe.");
    if (await tx.orderItem.count({ where: { choiceId } })) throw new DomainError("CONFLICT", "Hay pedidos con esta opción: desactiva sus precios en lugar de borrarla.");
    await tx.productChoice.delete({ where: { id: choiceId } });
    await recordAudit(tx, { actor, action: "choice.delete", entityType: "ProductChoice", entityId: choiceId, before, after: null, note, force: true });
    return { deleted: true as const };
  });
}
