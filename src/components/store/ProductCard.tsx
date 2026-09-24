// Tarjeta de producto (Dawn "card--standard" con imagen cuadrada y precio "A partir de").
import Link from "next/link";
import { formatUSD } from "@/server/pricing";
import type { SearchProduct } from "./search";

export function ProductCard({ product }: { product: SearchProduct }) {
  const href = `/products/${product.slug}`;
  return (
    <div className="card-wrapper">
      <Link href={href} className="card__media-link" tabIndex={-1} aria-hidden="true">
        <div className="card__media">
          {product.image ? (
            // eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN de Shopify / uploads
            <img src={product.image.url} alt={product.image.alt ?? product.title} width={product.image.width ?? 533} height={product.image.height ?? 533} loading="lazy" />
          ) : null}
        </div>
      </Link>
      <div className="card__content">
        <h3 className="card__heading">
          <Link href={href} className="full-unstyled-link">
            {product.title}
          </Link>
        </h3>
        {product.minPriceCents != null ? <p className="card__price">A partir de {formatUSD(product.minPriceCents)} USD</p> : null}
      </div>
    </div>
  );
}
