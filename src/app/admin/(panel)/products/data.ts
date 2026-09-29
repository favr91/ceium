// Lecturas de las páginas de Programas (solo lectura: las escrituras pasan por services().catalog).
import { prisma } from "@/server/db";
import { sanitizeRichText } from "@/server/rich-text";
import { at, money, type CsvCell } from "@/server/csv";
import {
  CATEGORY_LABEL,
  STATUS_LABEL,
  statusOf,
  type Category,
  type EditorContext,
  type PlanKind,
  type PlanRow,
  type PriceCell,
  type ProductForm,
  type ProductRow,
  type ProductType,
  type Status,
} from "@/components/admin/products/types";
import { centsToInput } from "@/components/admin/products/money";

const LIVE = ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"] as const;

export interface ListQuery { q?: string; status?: Status | "ALL"; category?: Category | "ALL"; sort?: string }

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export async function listProductRows(query: ListQuery = {}) {
  const products = await prisma.product.findMany({
    orderBy: [{ position: "asc" }, { title: "asc" }],
    include: {
      images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
      prices: { select: { priceCents: true, active: true } },
      collections: { include: { collection: { select: { title: true } } } },
      _count: { select: { diplomaCourses: true } },
      cohorts: { where: { status: "OPEN" }, select: { id: true } },
    },
  });
  const all: ProductRow[] = products.map((p) => {
    const active = p.prices.filter((x) => x.active).map((x) => x.priceCents);
    return {
      id: p.id,
      title: p.title,
      slug: p.slug,
      type: p.type as ProductType,
      category: p.category as Category,
      status: statusOf(p),
      image: p.images[0]?.url ?? null,
      priceMinCents: active.length ? Math.min(...active) : null,
      priceMaxCents: active.length ? Math.max(...active) : null,
      priceCount: active.length,
      online: p.offersOnline,
      semi: p.offersSemipresencial,
      courseCount: p._count.diplomaCourses,
      moodleCourseId: p.moodleCourseId,
      cohortsOpen: p.cohorts.length,
      collections: p.collections.map((c) => c.collection.title),
      updatedAt: p.updatedAt.toISOString(),
    };
  });
  const counts = { ALL: all.length, ACTIVE: 0, DRAFT: 0, ARCHIVED: 0 } as Record<Status | "ALL", number>;
  for (const r of all) counts[r.status]++;
  let rows = all;
  if (query.status && query.status !== "ALL") rows = rows.filter((r) => r.status === query.status);
  if (query.category && query.category !== "ALL") rows = rows.filter((r) => r.category === query.category);
  if (query.q?.trim()) {
    const terms = norm(query.q).split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const hay = norm(`${r.title} ${r.slug} ${r.moodleCourseId ?? ""} ${r.collections.join(" ")}`);
      return terms.every((t) => hay.includes(t));
    });
  }
  const s = query.sort ?? "position";
  const by: Record<string, (a: ProductRow, b: ProductRow) => number> = {
    "title-asc": (a, b) => a.title.localeCompare(b.title, "es"),
    "title-desc": (a, b) => b.title.localeCompare(a.title, "es"),
    "updated-desc": (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    "price-asc": (a, b) => (a.priceMinCents ?? Infinity) - (b.priceMinCents ?? Infinity),
    "price-desc": (a, b) => (b.priceMaxCents ?? -1) - (a.priceMaxCents ?? -1),
  };
  if (by[s]) rows = [...rows].sort(by[s]);
  return { rows, counts, total: all.length };
}

export const PRODUCT_STATUSES = ["ALL", "ACTIVE", "DRAFT", "ARCHIVED"] as const;
export const PRODUCT_CATEGORIES = ["ALL", "DIPLOMA", "UNIVERSITY_COURSE", "ADVANCED_COURSE", "WORKSHOP"] as const;

/**
 * Tabla de exportación de Programas con su lista de precios: precio (y cuota mensual de los diplomados) online y
 * por sede semipresencial, formas de pago activas y colecciones. Solo precios activos (los que se venden).
 */
export async function productsTable(rows: ProductRow[]) {
  const ids = rows.map((r) => r.id);
  const [prices, plans, sedes] = await Promise.all([
    prisma.priceEntry.findMany({ where: { productId: { in: ids }, choiceId: null, active: true }, select: { productId: true, modality: true, sedeId: true, priceCents: true, installmentCents: true } }),
    prisma.paymentPlan.findMany({ where: { productId: { in: ids }, active: true }, orderBy: { position: "asc" }, select: { productId: true, label: true } }),
    prisma.sede.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
  ]);
  const price = (pid: string, modality: "ONLINE" | "SEMIPRESENCIAL", sedeId: string | null) => prices.find((x) => x.productId === pid && x.modality === modality && x.sedeId === sedeId);
  const head = [
    "Programa", "Categoría", "Estado", "Modalidades", "Cursos del diplomado", "Curso en Moodle", "Identificador (URL)", "Colecciones", "Cohortes abiertas",
    "Precio online USD", "Cuota mensual online USD",
    ...sedes.flatMap((s) => [`Precio ${s.name} USD`, `Cuota mensual ${s.name} USD`]),
    "Formas de pago", "Actualizado el",
  ];
  return {
    head,
    rows: rows.map((r): CsvCell[] => {
      const on = r.online ? price(r.id, "ONLINE", null) : undefined;
      return [
        r.title,
        CATEGORY_LABEL[r.category],
        STATUS_LABEL[r.status],
        [r.online ? "Online" : "", r.semi ? "Semipresencial" : ""].filter(Boolean).join(" y "),
        r.type === "DIPLOMA" ? r.courseCount : null,
        r.moodleCourseId,
        r.slug,
        r.collections.join(" | "),
        r.cohortsOpen,
        money(on?.priceCents),
        money(on?.installmentCents),
        ...sedes.flatMap((s) => {
          const x = r.semi ? price(r.id, "SEMIPRESENCIAL", s.id) : undefined;
          return [money(x?.priceCents), money(x?.installmentCents)];
        }),
        plans.filter((p) => p.productId === r.id).map((p) => p.label).join(" | "),
        at(r.updatedAt),
      ];
    }),
  };
}

const DEFAULT_PLANS: Record<ProductType, { kind: PlanKind; label: string; discountPct: number }[]> = {
  COURSE: [
    { kind: "FULL", label: "Paga todo el curso", discountPct: 0 },
    { kind: "HALF", label: "Paga la mitad", discountPct: 0 },
  ],
  DIPLOMA: [
    { kind: "FULL", label: "Paga todo (10% de descuento)", discountPct: 10 },
    { kind: "HALF", label: "Paga la mitad (5% de descuento)", discountPct: 5 },
    { kind: "MONTHLY", label: "Paga mes a mes", discountPct: 0 },
  ],
};

export function planRows(type: ProductType, existing: { id: string; kind: PlanKind; label: string; discountPct: number; installments: number; active: boolean }[], courseCount: number, isNew: boolean): PlanRow[] {
  const kinds: PlanKind[] = type === "DIPLOMA" ? ["FULL", "HALF", "MONTHLY"] : ["FULL", "HALF"];
  return kinds.map((kind) => {
    const e = existing.find((x) => x.kind === kind);
    const d = DEFAULT_PLANS[type].find((x) => x.kind === kind)!;
    if (e) return { id: e.id, kind, label: e.label, discountPct: String(e.discountPct), installments: kind === "MONTHLY" ? courseCount : e.installments, active: e.active, enabled: true };
    return { id: null, kind, label: d.label, discountPct: String(d.discountPct), installments: kind === "MONTHLY" ? courseCount : kind === "HALF" ? 2 : 1, active: true, enabled: isNew && kind !== "MONTHLY" };
  });
}

/** Una celda por alcance posible (online + cada sede) × opción de compra; las que no existen van vacías. */
export function priceGrid(
  sedes: { id: string }[],
  choices: { id: string }[],
  existing: { id: string; modality: string; sedeId: string | null; choiceId: string | null; priceCents: number; installmentCents: number | null; active: boolean }[],
): PriceCell[] {
  const choiceIds: (string | null)[] = choices.length ? choices.map((c) => c.id) : [null];
  const cells: PriceCell[] = [];
  const known = new Set<string>();
  const key = (m: string, s: string | null, c: string | null) => `${m}:${s ?? "-"}:${c ?? "-"}`;
  const push = (modality: "ONLINE" | "SEMIPRESENCIAL", sedeId: string | null, choiceId: string | null) => {
    const e = existing.find((x) => x.modality === modality && (x.sedeId ?? null) === sedeId && (x.choiceId ?? null) === choiceId);
    known.add(key(modality, sedeId, choiceId));
    cells.push({ id: e?.id ?? null, modality, sedeId, choiceId, price: centsToInput(e?.priceCents), installment: centsToInput(e?.installmentCents), active: e?.active ?? true });
  };
  for (const c of choiceIds) {
    push("ONLINE", null, c);
    for (const s of sedes) push("SEMIPRESENCIAL", s.id, c);
  }
  // Precios de sedes inactivas / opciones borradas: se muestran igual para poder quitarlos.
  for (const e of existing) if (!known.has(key(e.modality, e.sedeId, e.choiceId))) cells.push({ id: e.id, modality: e.modality as "ONLINE" | "SEMIPRESENCIAL", sedeId: e.sedeId, choiceId: e.choiceId, price: centsToInput(e.priceCents), installment: centsToInput(e.installmentCents), active: e.active });
  return cells;
}

/** Fecha (día de Venezuela, UTC−4) para <input type="date">. */
const dateInput = (d: Date | null) => (d ? new Date(d.getTime() - 4 * 3600_000).toISOString().slice(0, 10) : "");
const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join("\n") : "");

async function editorContextBase() {
  const [sedes, courses, collections] = await Promise.all([
    prisma.sede.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, name: true, active: true } }),
    prisma.product.findMany({ where: { type: "COURSE" }, orderBy: [{ position: "asc" }, { title: "asc" }], select: { id: true, title: true, moodleCourseId: true, published: true, publishedAt: true, category: true } }),
    prisma.collection.findMany({ orderBy: [{ position: "asc" }, { title: "asc" }], select: { id: true, title: true, slug: true, diplomaId: true } }),
  ]);
  return {
    sedes,
    courses: courses.map((c) => ({ id: c.id, title: c.title, moodleCourseId: c.moodleCourseId, status: statusOf(c), category: c.category as Category })),
    collections,
  };
}

export async function newProductEditor(type: ProductType, category: Category): Promise<{ form: ProductForm; ctx: EditorContext }> {
  const base = await editorContextBase();
  const form: ProductForm = {
    id: null, type, category, title: "", slug: "", descriptionHtml: "", excerpt: "",
    offersOnline: true, offersSemipresencial: true, published: false, publishedAt: null, moodleCourseId: "",
    requirements: "", certificateTitle: "", certificateText: "", endorsementTitle: "", endorsementText: "", audience: "",
    duration: "", eventDateText: "", enrollmentNote: "", enrollmentDeadline: "", syllabusUrl: "", faculty: "", benefits: "",
    seoTitle: "", seoDescription: "",
    prices: priceGrid(base.sedes.filter((s) => s.active), [], []),
    plans: planRows(type, [], 0, true),
    courseIds: [],
    collectionIds: [],
  };
  return {
    form,
    ctx: { ...base, choices: [], images: [], stats: { orders: 0, liveOrders: 0, cohorts: 0, cohortsOpen: 0, enrollments: 0, inDiplomas: [] }, audit: [], prevId: null, nextId: null, createdAt: null, updatedAt: null, defaultPlans: { COURSE: planRows("COURSE", [], 0, true), DIPLOMA: planRows("DIPLOMA", [], 0, true) } },
  };
}

export async function productEditor(id: string): Promise<{ form: ProductForm; ctx: EditorContext } | null> {
  const p = await prisma.product.findUnique({
    where: { id },
    include: {
      images: { orderBy: { position: "asc" } },
      prices: true,
      plans: { orderBy: { position: "asc" } },
      choices: { orderBy: { position: "asc" } },
      diplomaCourses: { orderBy: { position: "asc" }, select: { courseId: true } },
      collections: { select: { collectionId: true } },
      inDiplomas: { include: { diploma: { select: { id: true, title: true } } } },
    },
  });
  if (!p) return null;
  const [base, orders, liveOrders, cohorts, cohortsOpen, enrollments, audit, siblings] = await Promise.all([
    editorContextBase(),
    prisma.orderItem.count({ where: { productId: id } }),
    prisma.orderItem.count({ where: { productId: id, order: { status: { in: [...LIVE] } } } }),
    prisma.cohort.count({ where: { productId: id } }),
    prisma.cohort.count({ where: { productId: id, status: "OPEN" } }),
    prisma.enrollment.count({ where: { productId: id } }),
    prisma.auditLog.findMany({
      where: { OR: [{ entityId: id }, { entityType: "PriceEntry", entityId: { in: p.prices.map((x) => x.id) } }, { entityType: "PaymentPlan", entityId: { in: p.plans.map((x) => x.id) } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
      include: { actor: { select: { name: true } } },
    }),
    prisma.product.findMany({ orderBy: [{ position: "asc" }, { title: "asc" }], select: { id: true } }),
  ]);
  const idx = siblings.findIndex((s) => s.id === id);
  const choices = p.choices.map((c) => ({ id: c.id, groupName: c.groupName, label: c.label, moodleCourseIds: Array.isArray(c.moodleCourseIds) ? (c.moodleCourseIds as number[]) : null }));
  const form: ProductForm = {
    id: p.id,
    type: p.type as ProductType,
    category: p.category as Category,
    title: p.title,
    slug: p.slug,
    // Lo guardado antes de sanear (o importado de ceium.net) también se limpia antes de llegar al editor (innerHTML).
    descriptionHtml: sanitizeRichText(p.descriptionHtml),
    excerpt: p.excerpt ?? "",
    offersOnline: p.offersOnline,
    offersSemipresencial: p.offersSemipresencial,
    published: p.published,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    moodleCourseId: p.moodleCourseId != null ? String(p.moodleCourseId) : "",
    requirements: p.requirements ?? "",
    certificateTitle: p.certificateTitle ?? "",
    certificateText: p.certificateText ?? "",
    endorsementTitle: p.endorsementTitle ?? "",
    endorsementText: p.endorsementText ?? "",
    audience: p.audience ?? "",
    duration: p.duration ?? "",
    eventDateText: p.eventDateText ?? "",
    enrollmentNote: p.enrollmentNote ?? "",
    enrollmentDeadline: dateInput(p.enrollmentDeadline),
    syllabusUrl: p.syllabusUrl ?? "",
    faculty: lines(p.faculty),
    benefits: lines(p.benefits),
    seoTitle: p.seoTitle ?? "",
    seoDescription: p.seoDescription ?? "",
    prices: priceGrid(base.sedes.filter((s) => s.active), choices, p.prices),
    plans: planRows(p.type as ProductType, p.plans as never, p.diplomaCourses.length, false),
    courseIds: p.diplomaCourses.map((d) => d.courseId),
    collectionIds: p.collections.map((c) => c.collectionId),
  };
  return {
    form,
    ctx: {
      ...base,
      choices,
      images: p.images.map((i) => ({ id: i.id, url: i.url, alt: i.alt })),
      stats: { orders, liveOrders, cohorts, cohortsOpen, enrollments, inDiplomas: p.inDiplomas.map((d) => d.diploma) },
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        when: a.createdAt.toISOString(),
        who: a.actor?.name ?? a.actorEmail ?? null,
        note: a.note,
        fields: Array.isArray(a.changes) ? (a.changes as { field?: string }[]).map((c) => c.field ?? "").filter(Boolean) : [],
      })),
      prevId: idx > 0 ? siblings[idx - 1].id : null,
      nextId: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1].id : null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    },
  };
}
