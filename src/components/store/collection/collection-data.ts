// Datos de las páginas de colección (/collections/<slug>), réplica de las plantillas de ceium.net. Solo servidor.
// Tres plantillas, como en la tienda original:
//   - "diplomas": tarjetas anchas PageFly (imagen + modalidad + título + nota + extracto + «Inscríbete»);
//   - "cards":    rejilla PageFly de tarjetas blancas (4 / 3 / 2 columnas) con antetítulo «¡Inscripciones abiertas!»;
//   - "grid":     plantilla de colección de Dawn (tarjeta cuadrada + «A partir de $… USD»), como los talleres.
// El catálogo (título de la colección, productos, orden, notas de inscripción, precios) sale SIEMPRE de la BD.
// Lo editorial (plantilla, antetítulo, texto de apoyo) tiene valores por defecto tomados de ceium.net y se puede
// sobreescribir por colección con la Setting `store.collections` ({ "<slug>": Partial<CollectionPageConfig> }).
import { prisma } from "@/server/db";
import { computePlanAmounts } from "@/server/pricing";
import { isProductEnrollmentOpen } from "@/server/quote";

export const COLLECTIONS_SETTING_KEY = "store.collections";

export type CollectionTemplate = "diplomas" | "cards" | "grid";

export interface CollectionPageConfig {
  template: CollectionTemplate;
  /** Antetítulo en mayúsculas sobre el título (plantilla "cards"). */
  eyebrow: string | null;
  /** Texto de apoyo junto al título; solo si la colección no tiene descripción propia en la BD. */
  description: string | null;
  /**
   * Nota bajo el título de cada tarjeta: "product" = la del programa (nota de inscripción / fechas / fecha límite);
   * "status" = solo el estado de inscripción («✍ Inscripciones abiertas.» o «Inscripciones cerradas»).
   */
  note: "product" | "status";
}

/** Plantilla por defecto de una colección sin configuración: diplomados → "diplomas", el resto → "cards". */
const BASE: Omit<CollectionPageConfig, "template"> = { eyebrow: "¡Inscripciones abiertas!", description: null, note: "product" };

export const DEFAULT_COLLECTION_PAGES: Record<string, Partial<CollectionPageConfig>> = {
  diplomados: {
    template: "diplomas",
    eyebrow: null,
    description:
      "Nuestros diplomados te capacitarán para dominar la ecografía en cualquier órgano o sistema, convirtiéndote en un profesional versátil y altamente demandado en el mercado.",
  },
  "cursos-avanzados": { note: "status" },
  "talleres-especializados": { template: "grid", eyebrow: null },
};

export const NOTE_OPEN_STATUS = "✍ Inscripciones abiertas.";
export const NOTE_CLOSED = "Inscripciones cerradas";

export type CollectionNote =
  | { kind: "text"; text: string }
  | { kind: "deadline"; label: string; date: string; iso: string }
  | { kind: "closed"; text: string };

export interface CollectionProduct {
  slug: string;
  title: string;
  href: string;
  image: { url: string; alt: string | null; width: number | null; height: number | null } | null;
  note: CollectionNote | null;
  open: boolean;
  /** Extracto (tarjetas de diplomados). */
  excerpt: string | null;
  /** "Online y semipresencial" / "Online" / "Semipresencial". */
  modality: string;
  /** Menor monto con el que se puede inscribir (primer pago del plan más barato), como el «A partir de» de Shopify. */
  fromPriceCents: number | null;
}

export interface CollectionPage {
  slug: string;
  title: string;
  config: CollectionPageConfig;
  /** Texto de apoyo (descripción de la colección en la BD o el editorial por defecto). */
  description: string | null;
  products: CollectionProduct[];
}

function modalityLabel(online: boolean, semi: boolean): string {
  if (online && semi) return "Online y semipresencial";
  if (online) return "Online";
  if (semi) return "Semipresencial";
  return "Presencial";
}

function formatDeadline(d: Date): string {
  // Fechas de inscripción guardadas a las 00:00 de Venezuela (UTC-4).
  return new Intl.DateTimeFormat("es-VE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Caracas" }).format(d);
}

/** Texto plano de un fragmento HTML de la BD (descripciones): sin etiquetas y con las entidades básicas resueltas. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function readOverrides(value: unknown): Record<string, Partial<CollectionPageConfig>> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Partial<CollectionPageConfig>>) : {};
}

const TEMPLATES: CollectionTemplate[] = ["diplomas", "cards", "grid"];

export function resolveConfig(
  slug: string,
  productTypes: string[],
  override: Partial<CollectionPageConfig> | undefined,
): CollectionPageConfig {
  const auto: CollectionTemplate = productTypes.length > 0 && productTypes.every((t) => t === "DIPLOMA") ? "diplomas" : "cards";
  const merged = { template: auto, ...BASE, ...DEFAULT_COLLECTION_PAGES[slug], ...(override ?? {}) };
  if (!TEMPLATES.includes(merged.template)) merged.template = auto;
  if (merged.note !== "status") merged.note = "product";
  return merged;
}

export function noteFor(
  p: { enrollmentNote: string | null; eventDateText: string | null; enrollmentDeadline: Date | null },
  open: boolean,
  mode: "product" | "status",
): CollectionNote | null {
  if (!open) return { kind: "closed", text: NOTE_CLOSED };
  if (mode === "status") return { kind: "text", text: NOTE_OPEN_STATUS };
  const text = p.enrollmentNote?.trim() || p.eventDateText?.trim();
  if (text) return { kind: "text", text };
  if (p.enrollmentDeadline) {
    return { kind: "deadline", label: "Inscripción hasta:", date: formatDeadline(p.enrollmentDeadline), iso: p.enrollmentDeadline.toISOString() };
  }
  return null;
}

/**
 * «A partir de»: el menor primer pago posible (precio × plan activo), como el menor precio de variante de Shopify
 * (p. ej. taller de $280 con «Paga la mitad» → $140). Sin planes, el precio de lista.
 */
export function fromPriceCents(
  prices: { priceCents: number; installmentCents: number | null }[],
  plans: { kind: "FULL" | "HALF" | "MONTHLY"; discountPct: number; installments: number }[],
  diplomaCourses = 0,
): number | null {
  const amounts = prices.flatMap((price) =>
    plans.length
      ? plans.map(
          (plan) =>
            computePlanAmounts(price, {
              kind: plan.kind,
              discountPct: plan.discountPct,
              // Mes a mes: una cuota por curso del diplomado.
              installments: plan.kind === "MONTHLY" ? Math.max(1, diplomaCourses || plan.installments) : plan.installments,
            }).dueNowCents,
        )
      : [price.priceCents],
  );
  return amounts.length ? Math.min(...amounts) : null;
}

export async function getCollectionPage(slug: string, now: Date = new Date()): Promise<CollectionPage | null> {
  const [collection, setting] = await Promise.all([
    prisma.collection.findUnique({
      where: { slug },
      select: {
        slug: true,
        title: true,
        descriptionHtml: true,
        published: true,
        products: {
          where: { product: { published: true } },
          orderBy: { position: "asc" },
          select: {
            product: {
              select: {
                slug: true,
                type: true,
                title: true,
                excerpt: true,
                descriptionHtml: true,
                published: true,
                enrollmentNote: true,
                eventDateText: true,
                enrollmentDeadline: true,
                offersOnline: true,
                offersSemipresencial: true,
                images: { orderBy: { position: "asc" }, take: 1, select: { url: true, alt: true, width: true, height: true } },
                prices: { where: { active: true }, select: { priceCents: true, installmentCents: true } },
                plans: { where: { active: true }, select: { kind: true, discountPct: true, installments: true } },
                _count: { select: { diplomaCourses: true } },
              },
            },
          },
        },
      },
    }),
    prisma.setting.findUnique({ where: { key: COLLECTIONS_SETTING_KEY } }),
  ]);
  if (!collection || !collection.published) return null;

  const override = readOverrides(setting?.value)[slug];
  const config = resolveConfig(
    slug,
    collection.products.map((cp) => cp.product.type),
    override,
  );
  const ownDescription = htmlToText(collection.descriptionHtml);

  const products = collection.products.map(({ product: p }): CollectionProduct => {
    const open = isProductEnrollmentOpen(p, now);
    return {
      slug: p.slug,
      title: p.title,
      href: `/products/${p.slug}`,
      image: p.images[0] ?? null,
      note: noteFor(p, open, config.note),
      open,
      excerpt: p.excerpt?.trim() || htmlToText(p.descriptionHtml) || null,
      modality: modalityLabel(p.offersOnline, p.offersSemipresencial),
      fromPriceCents: fromPriceCents(p.prices, p.plans, p._count.diplomaCourses),
    };
  });

  return {
    slug: collection.slug,
    title: collection.title,
    config,
    description: ownDescription || config.description || null,
    products,
  };
}
