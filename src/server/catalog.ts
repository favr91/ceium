// Catálogo desde el panel: fichas de programa, precios, planes de pago, colecciones, sedes y cursos de
// diplomado. Toda escritura valida, aplica las reglas del SPEC y deja su registro en AuditLog en la MISMA
// transacción. El panel no debe escribir estas tablas con prisma directamente.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { assertCan, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps, type Tx } from "@/server/deps";
import { DomainError, isUniqueViolation } from "@/server/errors";
import { priceScopeKey } from "@/server/pricing";

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
    descriptionHtml: z.string().max(200_000),
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
    syllabusUrl: z.string().max(1000).nullable(),
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
  assertCan(actor, "catalog.manage");
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
  assertCan(actor, "catalog.manage");
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
    if (p.installmentCents != null && product.type !== "DIPLOMA") throw new DomainError("VALIDATION", "La cuota mensual solo aplica a diplomados (plan «Paga mes a mes»).");
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
  assertCan(actor, "catalog.manage");
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
  assertCan(actor, "catalog.manage");
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
  assertCan(actor, "catalog.manage");
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
  assertCan(actor, "catalog.manage");
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
 * curso (PaymentPlan MONTHLY.installments = nº de cursos). Los pedidos ya creados conservan su calendario.
 */
export async function setDiplomaCourses(d: Deps, actor: SessionUser, diplomaId: string, courseIds: string[], note?: string) {
  assertCan(actor, "catalog.manage");
  const ids = parse(z.array(z.string().min(1)).min(1, "El diplomado necesita al menos un curso").max(50), courseIds);
  if (new Set(ids).size !== ids.length) throw new DomainError("VALIDATION", "Hay cursos repetidos.");
  return withTx(d, async (tx) => {
    const dip = await mustProduct(tx, diplomaId);
    if (dip.type !== "DIPLOMA") throw new DomainError("VALIDATION", "El programa no es un diplomado.");
    const courses = await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, moodleCourseId: true } });
    if (courses.length !== ids.length || courses.some((c) => c.type !== "COURSE")) throw new DomainError("VALIDATION", "Todos deben ser cursos existentes.");
    if (courses.some((c) => c.moodleCourseId == null)) throw new DomainError("VALIDATION", "Todos los cursos del diplomado deben tener curso de Moodle.");
    const before = (await tx.diplomaCourse.findMany({ where: { diplomaId }, orderBy: { position: "asc" }, select: { courseId: true } })).map((r) => r.courseId);
    const keep = new Map((await tx.diplomaCourse.findMany({ where: { diplomaId } })).map((r) => [r.courseId, r]));
    await tx.diplomaCourse.deleteMany({ where: { diplomaId, courseId: { notIn: ids } } });
    for (let i = 0; i < ids.length; i++) {
      if (keep.has(ids[i])) await tx.diplomaCourse.update({ where: { id: keep.get(ids[i])!.id }, data: { position: i + 1 } });
      else await tx.diplomaCourse.create({ data: { diplomaId, courseId: ids[i], position: i + 1 } });
    }
    const monthly = await tx.paymentPlan.findUnique({ where: { productId_kind: { productId: diplomaId, kind: "MONTHLY" } } });
    if (monthly && monthly.installments !== ids.length) {
      const updated = await tx.paymentPlan.update({ where: { id: monthly.id }, data: { installments: ids.length } });
      await recordAudit(tx, { actor, action: "plan.update", entityType: "PaymentPlan", entityId: monthly.id, before: monthly, after: updated, note: "Cuotas = nº de cursos del diplomado" });
    }
    await recordAudit(tx, { actor, action: "diploma.courses", entityType: "DiplomaCourse", entityId: diplomaId, before: { courseIds: before }, after: { courseIds: ids }, note });
    return { courseIds: ids };
  });
}
