// Búsqueda de la tienda (modal predictivo del header y página /search). Solo servidor.
// El catálogo es pequeño (decenas de productos): se filtra en memoria con normalización de acentos y
// mayúsculas, que SQLite (LIKE) no hace para caracteres no ASCII.
import { prisma } from "@/server/db";

export function normalizeSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Todas las palabras del término aparecen en el texto (en cualquier orden). */
export function matchesSearch(haystack: string, query: string): boolean {
  const h = normalizeSearch(haystack);
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => h.includes(w));
}

export interface SearchProduct {
  slug: string;
  title: string;
  image: { url: string; alt: string | null; width: number | null; height: number | null } | null;
  minPriceCents: number | null;
}
export interface SearchCollection {
  slug: string;
  title: string;
}

export async function searchCatalog(query: string, opts: { productLimit?: number; collectionLimit?: number } = {}) {
  const q = query.trim();
  if (!normalizeSearch(q)) return { products: [] as SearchProduct[], collections: [] as SearchCollection[] };
  const [products, collections] = await Promise.all([
    prisma.product.findMany({
      where: { published: true },
      orderBy: [{ position: "asc" }, { title: "asc" }],
      select: {
        slug: true,
        title: true,
        excerpt: true,
        descriptionHtml: true,
        images: { orderBy: { position: "asc" }, take: 1, select: { url: true, alt: true, width: true, height: true } },
        prices: { where: { active: true }, orderBy: { priceCents: "asc" }, take: 1, select: { priceCents: true } },
      },
    }),
    prisma.collection.findMany({ where: { published: true }, orderBy: { position: "asc" }, select: { slug: true, title: true } }),
  ]);
  // Primero los que coinciden por título; luego los que coinciden por el extracto o la descripción.
  const byTitle = products.filter((p) => matchesSearch(p.title, q));
  const byText = products.filter(
    (p) => !byTitle.includes(p) && matchesSearch(`${p.excerpt ?? ""} ${p.descriptionHtml.replace(/<[^>]*>/g, " ")}`, q),
  );
  const found = [...byTitle, ...byText].map(
    (p): SearchProduct => ({ slug: p.slug, title: p.title, image: p.images[0] ?? null, minPriceCents: p.prices[0]?.priceCents ?? null }),
  );
  const colls = collections.filter((c) => matchesSearch(c.title, q));
  return {
    products: opts.productLimit ? found.slice(0, opts.productLimit) : found,
    collections: opts.collectionLimit ? colls.slice(0, opts.collectionLimit) : colls,
  };
}
