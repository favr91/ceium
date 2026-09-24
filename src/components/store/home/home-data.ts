// Datos de la home de la tienda (réplica de la home PageFly de ceium.net). Solo servidor.
// El catálogo (diplomados, carruseles por colección, notas de inscripción, cronogramas de cohortes) sale
// SIEMPRE de la BD. Lo editorial (hero, aliados, galería, llamada final) tiene valores por defecto tomados de
// ceium.net y se puede sobreescribir con la Setting `store.home` (mismo formato que DEFAULT_HOME, parcial).
import { prisma } from "@/server/db";

export const HOME_SETTING_KEY = "store.home";

const CDN = "https://cdn.shopify.com/s/files/1/0653/7986/0524/files";

export interface HomeLink {
  label: string;
  url: string;
}

/** Fila de productos de una colección (carrusel). */
export interface HomeCollectionRowConfig {
  slug: string;
  /** Emoji que precede al título de la colección. */
  emoji?: string;
  /** Texto del enlace a la colección. `{count}` = nº de productos publicados de la colección. */
  linkLabel?: string;
  /** "compact": tarjetas estrechas (≈4,4 visibles); "wide": 4 columnas que llenan el ancho. */
  layout?: "compact" | "wide";
}

export interface HomeConfig {
  hero: {
    title: string;
    subtitle: string;
    slides: { desktop: string; mobile: string }[];
    /** Índice de la diapositiva inicial. */
    start: number;
    primary: HomeLink & { mobileLabel: string };
    secondary: HomeLink & { mobileLabel: string };
  };
  partners: { title: string; logos: { src: string; alt: string }[] };
  diplomas: { title: string; text: string; collection: string };
  rows: HomeCollectionRowConfig[];
  trust: { title: string; cta: HomeLink };
  gallery: { title: string; images: { src: string; alt: string }[] };
  closing: { eyebrow: string; title: string; text: string; image: string; cta: HomeLink };
}

export const DEFAULT_HOME: HomeConfig = {
  hero: {
    title: "Centro de Enseñanza e Investigación de Ultrasonido en Medicina",
    subtitle: "Tu aprendizaje es una garantía.",
    slides: [1, 2, 3, 4].map((n) => ({
      desktop: `${CDN}/slide-0${n}.webp`,
      mobile: `${CDN}/slide-0${n}-mobile.${n === 1 ? "webp" : "jpg"}`,
    })),
    start: 2,
    primary: { label: "Conoce los diplomados", mobileLabel: "Diplomados", url: "/collections/diplomados" },
    secondary: { label: "Conoce los cursos", mobileLabel: "Cursos", url: "/pages/cursos" },
  },
  partners: {
    title: "Nuestros aliados",
    logos: [
      { src: `${CDN}/UCLA_1.webp?v=1738166729`, alt: "Logo Universidad Centroocidental Lisandro Alvarado" },
      { src: `${CDN}/psj_f22f1bf9-5d59-4e98-9d1f-31d3eec276bc.svg?v=1738163656`, alt: "Logo Policlínica San Javier" },
      { src: `${CDN}/mediexpert_424764f5-8fe2-4153-afac-8208817d307e.svg?v=1738163630`, alt: "Logo Mediexpert" },
      { src: `${CDN}/yano_1f30da04-11aa-4e62-8084-5c5c97900f2a.svg?v=1738163568`, alt: "Logo Yano" },
      { src: `${CDN}/midoctor24h_e523f04a-5d55-43fd-ad4a-ee4bc6c901f1.svg?v=1738163584`, alt: "Logo Midoctor24h" },
    ],
  },
  diplomas: {
    title: "Diplomados",
    text: "Tenemos un equipo experimentado de especialistas en medicina y educación superior que ofrecen una excelente labor docente con respeto y compromiso.",
    collection: "diplomados",
  },
  rows: [
    { slug: "cursos-y-talleres-de-marzo-a-junio-2026", emoji: "🥇", linkLabel: "Ver todos", layout: "compact" },
    { slug: "cursos-universitarios", emoji: "🎓", linkLabel: "Explora {count} cursos más", layout: "compact" },
    { slug: "cursos-avanzados", emoji: "✨", layout: "wide" },
    { slug: "talleres-especializados", emoji: "🧑‍🏫", layout: "wide" },
  ],
  trust: { title: "Más de 6000 profesionales han confiado en CEIUM", cta: { label: "Empieza ya", url: "/pages/cursos" } },
  gallery: {
    title: "Viviendo la Experiencia CEIUM",
    images: [
      "galeria-_1.webp?v=1736283738",
      "galeria-_1_.1.webp?v=1736283755",
      "galeria-_2.webp?v=1736283765",
      "galeria-_2_.1.webp?v=1736283782",
      "galeria-_3.webp?v=1736283795",
      "galeria-_15.jpg?v=1736283272",
      "galeria-_16.jpg?v=1736283326",
      "galeria-_6.webp?v=1736283830",
      "galeria-_9.webp?v=1736283847",
      "galeria-_10.webp?v=1736283869",
      "galeria-_8.webp?v=1736283889",
    ].map((f, i) => ({ src: `${CDN}/${f}`, alt: `Experiencia CEIUM ${i + 1}` })),
  },
  closing: {
    eyebrow: "¡Inscripciones abiertas!",
    title: "Capacitación en\nUltrasonido a tu alcance",
    text: "Da el primer paso, inscríbete ahora.",
    image: `${CDN}/Frame_27.png?v=1732743002`,
    cta: { label: "Incríbete ya", url: "/pages/cursos" },
  },
};

/** Producto tal como lo pinta una tarjeta de la home. */
export interface HomeProduct {
  slug: string;
  title: string;
  image: { url: string; alt: string | null } | null;
  /** "✍ Inscripciones abiertas." / fechas del taller / "Inscripción hasta: dd/mm/aaaa". */
  note: string | null;
}

export interface HomeDiploma extends HomeProduct {
  excerpt: string | null;
  modality: string;
  schedules: { label: string; url: string }[];
}

export interface HomeRow {
  slug: string;
  title: string;
  href: string;
  linkLabel: string | null;
  layout: "compact" | "wide";
  products: HomeProduct[];
}

export interface HomeData {
  config: HomeConfig;
  diplomas: HomeDiploma[];
  rows: HomeRow[];
}

/** Pide al CDN de Shopify una versión reducida (las originales pesan 1600–2048 px). */
export function sizedImage(url: string, width: number): string {
  if (!/^(https?:)?\/\/(cdn\.shopify\.com|ceium\.net\/cdn)\//.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
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

const productSelect = {
  slug: true,
  title: true,
  excerpt: true,
  enrollmentNote: true,
  eventDateText: true,
  enrollmentDeadline: true,
  offersOnline: true,
  offersSemipresencial: true,
  images: { orderBy: { position: "asc" as const }, take: 1, select: { url: true, alt: true } },
};

type SelectedProduct = {
  slug: string;
  title: string;
  excerpt: string | null;
  enrollmentNote: string | null;
  eventDateText: string | null;
  enrollmentDeadline: Date | null;
  offersOnline: boolean;
  offersSemipresencial: boolean;
  images: { url: string; alt: string | null }[];
};

function toHomeProduct(p: SelectedProduct): HomeProduct {
  const note =
    p.enrollmentNote?.trim() ||
    p.eventDateText?.trim() ||
    (p.enrollmentDeadline ? `Inscripción hasta: ${formatDeadline(p.enrollmentDeadline)}` : null);
  return { slug: p.slug, title: p.title, image: p.images[0] ?? null, note };
}

function mergeConfig(override: Partial<HomeConfig> | null): HomeConfig {
  if (!override || typeof override !== "object") return DEFAULT_HOME;
  const out = { ...DEFAULT_HOME } as HomeConfig;
  for (const key of Object.keys(DEFAULT_HOME) as (keyof HomeConfig)[]) {
    const v = override[key];
    if (v == null) continue;
    // Las listas se reemplazan; los objetos se mezclan campo a campo.
    (out as unknown as Record<string, unknown>)[key] =
      Array.isArray(v) || typeof v !== "object" ? v : { ...(DEFAULT_HOME[key] as object), ...(v as object) };
  }
  return out;
}

export async function getHomeData(): Promise<HomeData> {
  const setting = await prisma.setting.findUnique({ where: { key: HOME_SETTING_KEY } });
  const config = mergeConfig((setting?.value as Partial<HomeConfig> | undefined) ?? null);
  const slugs = [config.diplomas.collection, ...config.rows.map((r) => r.slug)];

  const collections = await prisma.collection.findMany({
    where: { slug: { in: slugs }, published: true },
    select: {
      slug: true,
      title: true,
      products: {
        where: { product: { published: true } },
        orderBy: { position: "asc" },
        select: { product: { select: productSelect } },
      },
    },
  });
  const bySlug = new Map(collections.map((c) => [c.slug, c]));

  const diplomaProducts = bySlug.get(config.diplomas.collection)?.products.map((cp) => cp.product) ?? [];
  const cohorts = diplomaProducts.length
    ? await prisma.cohort.findMany({
        where: { product: { slug: { in: diplomaProducts.map((p) => p.slug) } }, scheduleUrl: { not: null }, status: { notIn: ["DRAFT", "CANCELLED"] } },
        orderBy: { startDate: "asc" },
        select: { name: true, scheduleUrl: true, product: { select: { slug: true } } },
      })
    : [];

  const diplomas: HomeDiploma[] = diplomaProducts.map((p) => {
    const seen = new Set<string>();
    const schedules = cohorts
      .filter((c) => c.product.slug === p.slug && c.scheduleUrl && !seen.has(c.name) && seen.add(c.name))
      .map((c) => ({ label: `Cronograma ${c.name.replace(/\s*-\s*/, " ")}`, url: c.scheduleUrl! }));
    return { ...toHomeProduct(p), excerpt: p.excerpt, modality: modalityLabel(p.offersOnline, p.offersSemipresencial), schedules };
  });

  const rows: HomeRow[] = config.rows.flatMap((r): HomeRow[] => {
    const c = bySlug.get(r.slug);
    if (!c || c.products.length === 0) return [];
    const count = c.products.length;
    return [
      {
        slug: c.slug,
        title: r.emoji ? `${r.emoji} ${c.title}` : c.title,
        href: `/collections/${c.slug}`,
        linkLabel: r.linkLabel ? r.linkLabel.replace("{count}", String(count)) : null,
        layout: r.layout ?? "compact",
        products: c.products.map((cp) => toHomeProduct(cp.product)),
      },
    ];
  });

  return { config, diplomas, rows };
}
