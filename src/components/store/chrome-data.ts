// Datos del "cromo" de la tienda (barra de anuncio, menú, pie, WhatsApp). Solo servidor.
// El menú replica la navegación de ceium.net, pero los enlaces a catálogo se resuelven contra la BD:
// una colección aporta su submenú con sus productos publicados (en su orden) y un producto aporta su título.
// La estructura se puede sobreescribir con la Setting `store.navigation` (mismo formato que DEFAULT_NAVIGATION).
import { prisma } from "@/server/db";
import { SETTING_KEYS } from "@/server/settings";

/** Nodo de configuración del menú (lo que se guarda en la Setting `store.navigation`). */
export type NavConfigNode =
  | { type: "link"; title: string; url: string }
  | { type: "campus"; title: string }
  | { type: "dropdown"; title: string; items: NavConfigNode[] }
  /** Submenú con los productos de la colección (título = `title` o el de la colección). */
  | { type: "collection"; slug: string; title?: string }
  /** Los productos de la colección como enlaces sueltos, al mismo nivel (p. ej. los diplomados). */
  | { type: "collection-products"; slug: string }
  | { type: "product"; slug: string; title?: string };

/** Nodo resuelto que pinta el header. */
export interface NavItem {
  id: string;
  title: string;
  href?: string;
  external?: boolean;
  children?: NavItem[];
}

export const NAVIGATION_SETTING_KEY = "store.navigation";
export const ANNOUNCEMENT_SETTING_KEY = "store.announcement";
export const SOCIAL_SETTING_KEY = "store.social";

export const DEFAULT_NAVIGATION: NavConfigNode[] = [
  { type: "link", title: "Inicio", url: "/" },
  {
    type: "dropdown",
    title: "Educación 2026",
    items: [
      { type: "collection", slug: "cursos-y-talleres-de-marzo-a-junio-2026", title: "🥇 Cursos y talleres que inician de marzo a junio" },
      { type: "collection-products", slug: "diplomados" },
      { type: "collection", slug: "cursos-universitarios" },
      { type: "collection", slug: "cursos-avanzados" },
    ],
  },
  { type: "link", title: "Quiénes somos", url: "/pages/quienes-somos" },
  { type: "link", title: "Preguntas frecuentes", url: "/pages/preguntas-frecuentes" },
  { type: "link", title: "Contacto", url: "/pages/contacto" },
  { type: "campus", title: "🎓 Campus" },
];

export const DEFAULT_ANNOUNCEMENT = { text: "¡Todos nuestros cursos y diplomados están avalados por la UCLA!", url: null as string | null };

export interface SocialLink {
  network: "facebook" | "instagram" | "youtube";
  url: string;
}
const DEFAULT_SOCIAL: Record<SocialLink["network"], string> = {
  facebook: "https://www.facebook.com/ceium/",
  instagram: "https://instagram.com/ceiumoficial",
  youtube: "https://www.youtube.com/@ceium2447",
};

export const WHATSAPP_GREETING = "Hola, quiero conocer sobre los cursos y diplomados que ofrece CEIUM.";

export interface StoreChrome {
  announcement: { text: string; url: string | null };
  menu: NavItem[];
  campusUrl: string;
  phones: { label: string; href: string }[];
  sedes: { id: string; label: string; href: string | null }[];
  social: SocialLink[];
  whatsappUrl: string | null;
  year: number;
}

async function setting<T>(key: string): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? null;
}

export function campusUrl(): string {
  const env = process.env;
  return env.MOODLE_LOGIN_URL || (env.MOODLE_URL ? `${env.MOODLE_URL.replace(/\/$/, "")}/login/index.php` : "https://cursos.ceium.net/academico/login/index.php");
}

function collectSlugs(nodes: NavConfigNode[], colls: Set<string>, prods: Set<string>) {
  for (const n of nodes) {
    if (n.type === "dropdown") collectSlugs(n.items, colls, prods);
    else if (n.type === "collection" || n.type === "collection-products") colls.add(n.slug);
    else if (n.type === "product") prods.add(n.slug);
  }
}

/** Resuelve la configuración del menú contra la BD (solo colecciones y productos publicados). */
export async function resolveNavigation(config: NavConfigNode[]): Promise<NavItem[]> {
  const collSlugs = new Set<string>();
  const prodSlugs = new Set<string>();
  collectSlugs(config, collSlugs, prodSlugs);
  const [collections, products] = await Promise.all([
    prisma.collection.findMany({
      where: { slug: { in: [...collSlugs] }, published: true },
      select: {
        slug: true,
        title: true,
        products: {
          where: { product: { published: true } },
          orderBy: { position: "asc" },
          select: { product: { select: { slug: true, title: true } } },
        },
      },
    }),
    prisma.product.findMany({ where: { slug: { in: [...prodSlugs] }, published: true }, select: { slug: true, title: true } }),
  ]);
  const collBySlug = new Map(collections.map((c) => [c.slug, c]));
  const prodBySlug = new Map(products.map((p) => [p.slug, p]));
  const campus = campusUrl();

  const walk = (nodes: NavConfigNode[], prefix: string): NavItem[] =>
    nodes.flatMap((n, i): NavItem[] => {
      const id = `${prefix}-${i}`;
      switch (n.type) {
        case "link":
          return [{ id, title: n.title, href: n.url, external: /^https?:/i.test(n.url) }];
        case "campus":
          return [{ id, title: n.title, href: campus, external: true }];
        case "product": {
          const p = prodBySlug.get(n.slug);
          return p ? [{ id, title: n.title ?? p.title, href: `/products/${p.slug}` }] : [];
        }
        case "collection-products": {
          const c = collBySlug.get(n.slug);
          return c ? c.products.map(({ product }, j) => ({ id: `${id}-${j}`, title: product.title, href: `/products/${product.slug}` })) : [];
        }
        case "collection": {
          const c = collBySlug.get(n.slug);
          if (!c || c.products.length === 0) return [];
          return [
            {
              id,
              title: n.title ?? c.title,
              href: `/collections/${c.slug}`,
              children: c.products.map(({ product }, j) => ({ id: `${id}-${j}`, title: product.title, href: `/products/${product.slug}` })),
            },
          ];
        }
        case "dropdown": {
          const children = walk(n.items, id);
          return children.length ? [{ id, title: n.title, children }] : [];
        }
      }
    });
  return walk(config, "nav");
}

function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export function whatsappLink(number: string | undefined | null): string | null {
  const digits = (number ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/+${digits}?text=${encodeURIComponent(WHATSAPP_GREETING)}`;
}

export async function getStoreChrome(): Promise<StoreChrome> {
  const [navConfig, announcement, contact, social, sedes] = await Promise.all([
    setting<NavConfigNode[]>(NAVIGATION_SETTING_KEY),
    setting<{ text?: string; url?: string | null }>(ANNOUNCEMENT_SETTING_KEY),
    setting<{ phones?: string[]; whatsapp?: string; instagram?: string }>(SETTING_KEYS.storeContact),
    setting<Partial<Record<SocialLink["network"], string>>>(SOCIAL_SETTING_KEY),
    prisma.sede.findMany({ where: { active: true }, orderBy: { position: "asc" }, select: { id: true, name: true, address: true, mapUrl: true } }),
  ]);
  const menu = await resolveNavigation(Array.isArray(navConfig) && navConfig.length ? navConfig : DEFAULT_NAVIGATION);
  const socialUrls = { ...DEFAULT_SOCIAL, ...(contact?.instagram ? { instagram: contact.instagram } : {}), ...(social ?? {}) };
  return {
    announcement: { text: announcement?.text || DEFAULT_ANNOUNCEMENT.text, url: announcement?.url ?? null },
    menu,
    campusUrl: campusUrl(),
    phones: (contact?.phones ?? []).map((p) => ({ label: p, href: telHref(p) })),
    sedes: sedes.map((s) => ({ id: s.id, label: s.address ? `${s.name}: ${s.address}` : s.name, href: s.mapUrl || null })),
    social: (["facebook", "instagram", "youtube"] as const).filter((n) => socialUrls[n]).map((n) => ({ network: n, url: socialUrls[n] })),
    whatsappUrl: whatsappLink(contact?.whatsapp),
    year: new Date().getFullYear(),
  };
}
