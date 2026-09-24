// Datos de la ficha de producto (/products/<slug>): réplica de las fichas PageFly de ceium.net (diplomado,
// curso universitario y taller) más lo que la tienda original no tenía: elegir la cohorte (fechas y cupos en
// vivo) en semipresencial y ver el precio exacto de cada combinación modalidad × sede × forma de pago.
// Solo servidor. Todo el catálogo sale de la BD; lo editorial (iconos, llamada «Obtén tu Certificado…») tiene
// valores por defecto tomados de ceium.net y se puede sobreescribir con la Setting `store.product`.
import type { Modality, PlanKind, ProductCategory, ProductType } from "@/server/db";
import { prisma } from "@/server/db";
import { isProductEnrollmentOpen } from "@/server/quote";
import { liveHeldCounts } from "@/server/seats";
import { cohortKey, cohortScheduleHref, LISTED_COHORT_STATUSES } from "@/components/store/cohort-schedule";

export const PRODUCT_SETTING_KEY = "store.product";

const CDN = "https://cdn.shopify.com/s/files/1/0653/7986/0524/files";
const TZ = "America/Caracas";

export interface CertificateCta {
  title: string;
  text: string;
  image: string;
  items: { icon: string; title: string; text: string }[];
}

export interface ProductPageConfig {
  icons: { requirements: string; certificate: string; endorsement: string; audience: string; duration: string };
  /** Llamada final: variante universitaria (cursos y diplomados avalados por la UCLA) y la de los talleres. */
  certificate: { university: CertificateCta; workshop: CertificateCta };
}

const CTA_ITEMS: CertificateCta["items"] = [
  { icon: `${CDN}/editor_choice.svg?v=1733154715`, title: "Ofrece un servicio de excelencia", text: "Brinda a tus pacientes un diagnóstico más preciso y un tratamiento más personalizado." },
  { icon: `${CDN}/stethoscope_check.svg?v=1733155777`, title: "Amplía tus habilidades", text: "Desarrolla nuevas competencias y mejora tu desempeño profesional." },
  { icon: `${CDN}/rocket_launch.svg?v=1733155790`, title: "Potencia tu carrera", text: "Los certificados CEIUM te brindarán una ventaja competitiva en el mercado laboral y te abrirán las puertas a nuevas oportunidades." },
];

export const DEFAULT_PRODUCT_PAGE: ProductPageConfig = {
  icons: {
    requirements: `${CDN}/requisitos.svg?v=1732914360`,
    certificate: `${CDN}/certificado.svg?v=1732914460`,
    endorsement: `${CDN}/programa.svg?v=1732914502`,
    audience: `${CDN}/stethoscope.svg?v=1753223051`,
    duration: `${CDN}/duracion.svg?v=1732914619`,
  },
  certificate: {
    university: {
      title: "Obtén tu Certificado Universitario de CEIUM",
      text: "Al completar satisfactoriamente cada curso o diplomado, recibirás un certificado oficial CEIUM, respaldado por la Universidad Centrooccidental Lisandro Alvarado.",
      image: `${CDN}/diploma.jpg?v=1733155998`,
      items: CTA_ITEMS,
    },
    workshop: {
      title: "Obtén tu Certificado avalado por CEIUM",
      text: "Al completar satisfactoriamente cada curso o diplomado, recibirás un certificado oficial CEIUM.",
      image: `${CDN}/diploma.jpg?v=1733155998`,
      items: CTA_ITEMS,
    },
  },
};

// ───────────── tipos que viajan al formulario de compra (cliente) ─────────────

export interface BuyPrice {
  modality: Modality;
  sedeId: string | null;
  choiceId: string | null;
  priceCents: number;
  installmentCents: number | null;
}

export interface BuyPlan {
  kind: PlanKind;
  label: string;
  discountPct: number;
  /** Nº de cuotas: FULL 1, HALF 2, MONTHLY = nº de cursos del diplomado. */
  installments: number;
}

export type CohortPhase = "OPEN" | "SOLD_OUT" | "CLOSED";

export interface BuyCohort {
  id: string;
  sedeId: string;
  name: string;
  /** «3 oct 2026 – 25 jun 2027» / «20 y 21 nov 2026». */
  dates: string;
  /** «Sábado 3 de octubre de 2026» (inicio). */
  startLong: string;
  /** «inscripción hasta el 2 oct» (si tiene cierre propio). */
  deadline: string | null;
  capacity: number;
  available: number;
  phase: CohortPhase;
  scheduleHref: string | null;
}

export interface BuyConfig {
  productId: string;
  productType: ProductType;
  /** Inscripciones abiertas (publicado y antes del cierre del programa). */
  open: boolean;
  choiceGroup: string | null;
  choices: { id: string; label: string }[];
  modalities: Modality[];
  sedes: { id: string; name: string }[];
  prices: BuyPrice[];
  plans: BuyPlan[];
  cohorts: BuyCohort[];
  /** Diplomados: cursos en orden (el mes a mes paga uno por mes). */
  courseTitles: string[];
}

// ───────────── tipos de la página ─────────────

export interface ProductCardData {
  slug: string;
  href: string;
  title: string;
  image: { url: string; alt: string | null } | null;
}

export interface ProductPageData {
  slug: string;
  title: string;
  category: ProductCategory;
  type: ProductType;
  seoDescription: string | null;
  images: { url: string; alt: string | null; width: number | null; height: number | null }[];
  intro: string | null;
  belongsTo: { title: string; href: string } | null;
  /** «✍ Inscripciones abiertas durante todo el año.» o «Inscripciones cerradas». */
  enrollmentNote: { text: string; closed: boolean } | null;
  eventDateText: string | null;
  scheduleLinks: { label: string; href: string }[];
  info: { key: string; icon: string; title: string; text: string }[];
  benefits: string[];
  diplomaCourses: { n: number; title: string; href: string | null; highlights: string[] }[];
  topics: { title: string; lead: string | null; items: string[] }[];
  topicsTitle: string;
  syllabusUrl: string | null;
  faculty: string[];
  related: { title: string; link: { label: string; href: string } | null; products: ProductCardData[] } | null;
  certificate: CertificateCta;
  buy: BuyConfig;
}

// ───────────── helpers ─────────────

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

function parseTopics(v: unknown): ProductPageData["topics"] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const o = t as { title?: unknown; items?: unknown };
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const items = strings(o.items);
    if (!title && items.length === 0) return [];
    // «Generalidades del manejo de la imagen ecográfica:» → párrafo introductorio del tema (como ceium.net).
    const lead = items.length > 1 && items[0].endsWith(":") ? items[0] : null;
    return [{ title, lead, items: lead ? items.slice(1) : items }];
  });
}

function mergeConfig(override: unknown): ProductPageConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) return DEFAULT_PRODUCT_PAGE;
  const o = override as Partial<ProductPageConfig>;
  return {
    icons: { ...DEFAULT_PRODUCT_PAGE.icons, ...(o.icons ?? {}) },
    certificate: {
      university: { ...DEFAULT_PRODUCT_PAGE.certificate.university, ...(o.certificate?.university ?? {}) },
      workshop: { ...DEFAULT_PRODUCT_PAGE.certificate.workshop, ...(o.certificate?.workshop ?? {}) },
    },
  };
}

const dayFmt = new Intl.DateTimeFormat("es-VE", { day: "numeric", timeZone: TZ });
const monthFmt = new Intl.DateTimeFormat("es-VE", { month: "short", timeZone: TZ });
const yearFmt = new Intl.DateTimeFormat("es-VE", { year: "numeric", timeZone: TZ });
const longFmt = new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ });
const dayMonthFmt = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", timeZone: TZ });
const clean = (s: string) => s.replace(/\./g, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «3 oct 2026 – 25 jun 2027», «20 y 21 nov 2026», «2 – 9 may 2026». */
export function formatCohortDates(start: Date, end: Date): string {
  const d1 = dayFmt.format(start), m1 = clean(monthFmt.format(start)), y1 = yearFmt.format(start);
  const d2 = dayFmt.format(end), m2 = clean(monthFmt.format(end)), y2 = yearFmt.format(end);
  if (y1 === y2 && m1 === m2) {
    if (d1 === d2) return `${d1} ${m1} ${y1}`;
    const next = new Date(start.getTime() + 24 * 3600 * 1000);
    return dayFmt.format(next) === d2 && clean(monthFmt.format(next)) === m2 ? `${d1} y ${d2} ${m1} ${y1}` : `${d1} – ${d2} ${m1} ${y1}`;
  }
  if (y1 === y2) return `${d1} ${m1} – ${d2} ${m2} ${y1}`;
  return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
}

// ───────────── carga ─────────────

export async function getProductPage(slug: string, now: Date = new Date()): Promise<ProductPageData | null> {
  const [p, setting] = await Promise.all([
    prisma.product.findFirst({
      where: { slug, published: true },
      include: {
        images: { orderBy: { position: "asc" } },
        choices: { orderBy: { position: "asc" } },
        prices: { where: { active: true }, include: { sede: true } },
        plans: { where: { active: true }, orderBy: { position: "asc" } },
        diplomaCourses: { orderBy: { position: "asc" }, include: { course: { select: { slug: true, title: true, published: true } } } },
        inDiplomas: {
          where: { diploma: { published: true } },
          orderBy: { position: "asc" },
          include: { diploma: { select: { id: true, slug: true, title: true, collectionsForDiploma: { where: { published: true }, select: { slug: true } } } } },
        },
        collectionsForDiploma: { where: { published: true }, select: { slug: true, title: true } },
        cohorts: {
          where: { status: { in: [...LISTED_COHORT_STATUSES] }, sede: { active: true } },
          orderBy: [{ startDate: "asc" }, { sede: { position: "asc" } }],
          include: { sede: { select: { id: true, name: true, position: true } } },
        },
      },
    }),
    prisma.setting.findUnique({ where: { key: PRODUCT_SETTING_KEY } }),
  ]);
  if (!p) return null;
  const config = mergeConfig(setting?.value);
  const open = isProductEnrollmentOpen(p, now);

  // Precios activos cuyas sedes están activas (ONLINE no tiene sede).
  const prices = p.prices.filter((pr) => pr.modality === "ONLINE" || (pr.sede && pr.sede.active));
  const modalities = (["SEMIPRESENCIAL", "ONLINE"] as const).filter(
    (m) => (m === "ONLINE" ? p.offersOnline : p.offersSemipresencial) && prices.some((pr) => pr.modality === m),
  );
  const sedeMap = new Map<string, { id: string; name: string; position: number }>();
  for (const pr of prices) if (pr.modality === "SEMIPRESENCIAL" && pr.sede) sedeMap.set(pr.sede.id, { id: pr.sede.id, name: pr.sede.name, position: pr.sede.position });
  const sedes = [...sedeMap.values()].sort((a, b) => a.position - b.position).map(({ id, name }) => ({ id, name }));

  // Mes a mes: una cuota por curso del diplomado (quote() exige ≥ 2 cursos y tipo DIPLOMA).
  const nCourses = p.diplomaCourses.length;
  const plans: BuyPlan[] = p.plans
    .filter((pl) => pl.kind !== "MONTHLY" || (p.type === "DIPLOMA" && nCourses >= 2))
    .map((pl) => ({ kind: pl.kind, label: pl.label, discountPct: pl.discountPct, installments: pl.kind === "MONTHLY" ? nCourses : pl.kind === "HALF" ? 2 : 1 }));

  // Cohortes: solo las que admiten o admitieron inscripción (abiertas, llenas o con cierre vencido).
  const openCohorts = p.cohorts.filter((c) => c.status === "OPEN" && sedeMap.has(c.sedeId));
  const held = openCohorts.length ? await liveHeldCounts({ db: prisma, now: () => now }, openCohorts.map((c) => c.id)) : new Map<string, number>();
  const cohorts: BuyCohort[] = openCohorts.map((c) => {
    const available = Math.max(0, c.capacity - c.seatsConfirmed - (held.get(c.id) ?? 0));
    const deadlinePassed = !!c.enrollmentDeadline && c.enrollmentDeadline.getTime() < now.getTime();
    const phase: CohortPhase = deadlinePassed ? "CLOSED" : available > 0 ? "OPEN" : "SOLD_OUT";
    const sessions = Array.isArray(c.sessions) ? c.sessions.length : 0;
    return {
      id: c.id,
      sedeId: c.sedeId,
      name: c.name,
      dates: formatCohortDates(c.startDate, c.endDate),
      startLong: cap(longFmt.format(c.startDate)),
      deadline: c.enrollmentDeadline && !deadlinePassed ? `inscripción hasta el ${clean(dayMonthFmt.format(c.enrollmentDeadline))}` : null,
      capacity: c.capacity,
      available,
      phase,
      scheduleHref: sessions > 0 || c.scheduleUrl ? cohortScheduleHref(p.slug, c.name) : null,
    };
  });

  // «📅 Ver Cronograma Cohorte I - 2026» (diplomados, como ceium.net): una entrada por nombre de cohorte vigente.
  const seen = new Set<string>();
  const scheduleLinks =
    p.type === "DIPLOMA"
      ? p.cohorts
          .filter((c) => !seen.has(cohortKey(c.name)) && seen.add(cohortKey(c.name)))
          .map((c) => ({ label: `Ver Cronograma ${c.name}`, href: cohortScheduleHref(p.slug, c.name) }))
      : [];

  // Franja de datos: Requisitos · Certificado · Avalado (o Dirigido a) · Duración.
  const info: ProductPageData["info"] = [];
  const push = (key: string, icon: string, title: string | null | undefined, text: string | null | undefined) => {
    if (title?.trim() && text?.trim()) info.push({ key, icon, title: title.trim(), text: text.trim() });
  };
  push("requirements", config.icons.requirements, "Requisitos", p.requirements);
  push("certificate", config.icons.certificate, p.certificateTitle || "Certificado", p.certificateText);
  if (p.endorsementText?.trim()) push("endorsement", config.icons.endorsement, p.endorsementTitle || "Avalado por", p.endorsementText);
  else push("audience", config.icons.audience, "Dirigido a", p.audience);
  push("duration", config.icons.duration, "Tiempo de duración", p.duration);

  const diploma = p.inDiplomas[0]?.diploma ?? null;
  const diplomaCollection = diploma?.collectionsForDiploma[0]?.slug ?? null;
  const belongsTo = diploma ? { title: diploma.title, href: diplomaCollection ? `/collections/${diplomaCollection}` : `/products/${diploma.slug}` } : null;

  const note = !open ? { text: "Inscripciones cerradas", closed: true } : p.enrollmentNote?.trim() ? { text: p.enrollmentNote.trim(), closed: false } : null;

  return {
    slug: p.slug,
    title: p.title,
    category: p.category,
    type: p.type,
    seoDescription: p.seoDescription ?? p.excerpt ?? null,
    images: p.images.map((i) => ({ url: i.url, alt: i.alt, width: i.width, height: i.height })),
    intro: p.excerpt?.trim() || null,
    belongsTo,
    enrollmentNote: note,
    eventDateText: eventDate(cohorts, p.eventDateText),
    scheduleLinks,
    info,
    benefits: strings(p.benefits),
    diplomaCourses: p.diplomaCourses.map((dc, i) => ({
      n: i + 1,
      title: dc.course.title,
      href: dc.course.published ? `/products/${dc.course.slug}` : null,
      highlights: strings(dc.highlights),
    })),
    topics: parseTopics(p.topics),
    topicsTitle: p.category === "WORKSHOP" ? "Contenidos Académicos" : "Contenido del curso",
    syllabusUrl: p.syllabusUrl?.trim() || null,
    faculty: strings(p.faculty),
    related: await getRelated(p, diploma?.id ?? null),
    certificate: p.category === "WORKSHOP" ? config.certificate.workshop : config.certificate.university,
    buy: {
      productId: p.id,
      productType: p.type,
      open,
      choiceGroup: p.choices[0]?.groupName ?? null,
      choices: p.choices.map((c) => ({ id: c.id, label: c.label })),
      modalities: [...modalities],
      sedes,
      prices: prices.map((pr) => ({ modality: pr.modality, sedeId: pr.sedeId, choiceId: pr.choiceId, priceCents: pr.priceCents, installmentCents: pr.installmentCents })),
      plans,
      cohorts,
      courseTitles: p.diplomaCourses.map((dc) => dc.course.title),
    },
  };
}

/**
 * «Fecha:» de los talleres. Si hay cohortes abiertas, manda la fecha real de la cohorte (una sola fecha común a
 * todas las sedes) para no contradecir el selector; con varias fechas se omite (se eligen abajo); sin cohortes,
 * el texto del programa.
 */
function eventDate(cohorts: BuyCohort[], text: string | null): string | null {
  const open = [...new Set(cohorts.filter((c) => c.phase === "OPEN").map((c) => c.dates))];
  if (cohorts.length === 0) return text?.trim() || null;
  if (!text?.trim()) return null;
  return open.length === 1 ? open[0] : null;
}

/** Colección principal de cada categoría (la fila «relacionados» de un curso suelto o taller). */
const CATEGORY_COLLECTION: Record<ProductCategory, string> = {
  DIPLOMA: "diplomados",
  UNIVERSITY_COURSE: "cursos-universitarios",
  ADVANCED_COURSE: "cursos-avanzados",
  WORKSHOP: "talleres-especializados",
};

async function getRelated(
  p: {
    id: string;
    type: ProductType;
    category: ProductCategory;
    title: string;
    collectionsForDiploma: { slug: string; title: string }[];
  },
  diplomaId: string | null,
): Promise<ProductPageData["related"]> {
  // Diplomado → «Cursos del Diplomado …» (su colección); curso de un diplomado → los demás cursos de ese
  // diplomado; curso suelto / taller → su colección de categoría. Nunca el propio programa.
  let where: { slug: string } | { diplomaId: string };
  let title: string;
  let label = "Ver todos";
  if (p.type === "DIPLOMA") {
    where = { diplomaId: p.id };
    title = p.collectionsForDiploma[0]?.title ?? `Cursos del ${p.title}`;
    label = "Conoce más";
  } else if (diplomaId) {
    where = { diplomaId };
    title = "Cursos relacionados";
  } else {
    where = { slug: CATEGORY_COLLECTION[p.category] };
    title = p.category === "WORKSHOP" ? "Talleres y cursos relacionados" : "Cursos relacionados";
  }
  const c = await prisma.collection.findFirst({
    where: { ...where, published: true },
    select: {
      slug: true,
      products: {
        where: { product: { published: true, id: { not: p.id } } },
        orderBy: { position: "asc" },
        take: 12,
        select: { product: { select: { slug: true, title: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true, alt: true } } } } },
      },
    },
  });
  if (!c || c.products.length === 0) return null;
  return {
    title,
    link: { label, href: `/collections/${c.slug}` },
    products: c.products.map(({ product: x }) => ({ slug: x.slug, href: `/products/${x.slug}`, title: x.title, image: x.images[0] ?? null })),
  };
}
