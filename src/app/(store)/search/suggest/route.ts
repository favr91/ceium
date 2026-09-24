// Resultados del buscador predictivo del header: GET /search/suggest?q=…
import { searchCatalog } from "@/components/store/search";
import { formatUSD } from "@/server/pricing";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 100);
  const { products, collections } = await searchCatalog(q, { productLimit: 10, collectionLimit: 4 });
  return Response.json({
    q,
    collections: collections.map((c) => ({ title: c.title, href: `/collections/${c.slug}` })),
    products: products.map((p) => ({
      title: p.title,
      href: `/products/${p.slug}`,
      image: p.image ? { url: p.image.url, alt: p.image.alt ?? p.title, width: p.image.width, height: p.image.height } : null,
      price: p.minPriceCents != null ? formatUSD(p.minPriceCents) : null,
    })),
  });
}
