// Resultados de búsqueda (/search?q=…), réplica de la plantilla de búsqueda de Dawn en ceium.net.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { SearchField } from "@/components/store/PredictiveSearch";
import { ProductCard } from "@/components/store/ProductCard";
import { searchCatalog } from "@/components/store/search";

const PER_PAGE = 24;
type SearchProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: SearchProps): Promise<Metadata> {
  const q = firstParam((await searchParams).q).trim();
  return { title: q ? `Buscar: ${q}` : "Buscar" };
}

function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function SearchPage({ searchParams }: SearchProps) {
  await connection();
  const sp = await searchParams;
  const q = firstParam(sp.q).trim().slice(0, 100);
  const { products } = await searchCatalog(q);
  const pages = Math.max(1, Math.ceil(products.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(firstParam(sp.page), 10) || 1));
  const shown = products.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const pageHref = (n: number) => `/search?${new URLSearchParams({ q, ...(n > 1 ? { page: String(n) } : {}) })}`;

  return (
    <div className="template-search">
      <div className="template-search__header page-width">
        <h1 className="template-search__title">Resultados de búsqueda</h1>
        <form action="/search" method="get" role="search" className="template-search__form search">
          <SearchField key={q} id="Search-In-Template" defaultValue={q} />
        </form>
        {q ? (
          <p className="template-search__count" role="status">
            {products.length === 0
              ? `No se encontraron resultados para "${q}". Comprueba la ortografía o usa una palabra o frase diferente.`
              : `Se ${products.length === 1 ? "ha" : "han"} encontrado ${products.length} ${products.length === 1 ? "resultado" : "resultados"} para "${q}"`}
          </p>
        ) : null}
      </div>
      {shown.length ? (
        <div className="template-search__results page-width">
          <ul className="product-grid list-unstyled" role="list">
            {shown.map((p) => (
              <li key={p.slug} className="product-grid__item">
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
          {pages > 1 ? (
            <nav className="pagination" aria-label="Paginación">
              <ul className="pagination__list list-unstyled" role="list">
                {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                  <li key={n}>
                    {n === page ? (
                      <span className="pagination__item pagination__item--current" aria-current="page" aria-label={`Página ${n}`}>
                        {n}
                      </span>
                    ) : (
                      <Link href={pageHref(n)} className="pagination__item link" aria-label={`Página ${n}`}>
                        {n}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
