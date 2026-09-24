// Página de colección (/collections/<slug>): réplica de las plantillas de colección de ceium.net —
// diplomados (tarjetas anchas PageFly), cursos (rejilla PageFly de tarjetas «Inscríbete») y talleres (colección
// Dawn con «A partir de $… USD»). Título, productos, orden, notas y precios salen de la BD (ver collection-data).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { getCollectionPage, type CollectionPage, type CollectionProduct } from "@/components/store/collection/collection-data";
import { sizedImage } from "@/components/store/home/home-data";
import { ProductCard } from "@/components/store/ProductCard";
import "./collection.css";

type Props = { params: Promise<{ slug: string }> };

const loadPage = cache((slug: string) => getCollectionPage(slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const data = await loadPage(decodeURIComponent((await params).slug));
  if (!data) return { title: "Colección no encontrada" };
  return { title: data.title, description: data.description ?? undefined };
}

function IconEdit() {
  // Icono «pen-to-square» de PageFly (12 px) del botón de los diplomados.
  return (
    <svg aria-hidden="true" focusable="false" className="coll-icon" viewBox="0 0 512 512" width="12" height="12">
      <path
        fill="currentColor"
        d="M471.6 21.7c-21.9-21.9-57.3-21.9-79.2 0l-30.1 30 97.9 97.9 30.1-30.1c21.9-21.9 21.9-57.3 0-79.2zM172.4 241.7c-6.1 6.1-10.8 13.6-13.5 21.9l-29.6 88.8c-2.9 8.6-.6 18.1 5.8 24.6s15.9 8.7 24.6 5.8l88.8-29.6c8.2-2.7 15.7-7.4 21.9-13.5l167.3-167.4-97.9-97.9zM96 64c-53 0-96 43-96 96v256c0 53 43 96 96 96h256c53 0 96-43 96-96v-96c0-17.7-14.3-32-32-32s-32 14.3-32 32v96c0 17.7-14.3 32-32 32H96c-17.7 0-32-14.3-32-32V160c0-17.7 14.3-32 32-32h96c17.7 0 32-14.3 32-32s-14.3-32-32-32z"
      />
    </svg>
  );
}

function Media({ p, width, className }: { p: CollectionProduct; width: number; className: string }) {
  return (
    <Link href={p.href} className={className} tabIndex={-1} aria-hidden="true">
      {p.image ? (
        // eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN de Shopify / uploads
        <img src={sizedImage(p.image.url, width)} alt="" width={p.image.width ?? 16} height={p.image.height ?? 9} loading="lazy" />
      ) : null}
    </Link>
  );
}

function ctaLabel(p: CollectionProduct) {
  return p.open ? "Inscríbete" : "Ver programa";
}

function Empty() {
  return <p className="coll-empty">Esta colección no tiene programas disponibles por ahora.</p>;
}

function DiplomasTemplate({ data }: { data: CollectionPage }) {
  return (
    <section className="coll-pf coll-pf--diplomas" aria-labelledby="coll-title">
      <div className="coll-container">
        <div className="coll-diplomas__head">
          <h1 id="coll-title" className="coll-diplomas__title">
            {data.title}
          </h1>
          {data.description ? <p className="coll-diplomas__text">{data.description}</p> : null}
        </div>
        {data.products.length ? (
          <ul className="coll-diplomas__list list-unstyled" role="list">
            {data.products.map((p) => (
              <li key={p.slug} className="coll-diploma coll-hover" data-product={p.slug}>
                <Media p={p} width={900} className="coll-diploma__media coll-media" />
                <div className="coll-diploma__body">
                  <p className="coll-diploma__badge">{p.modality}</p>
                  <h2 className="coll-diploma__title">
                    <Link href={p.href}>{p.title}</Link>
                  </h2>
                  {p.note ? <p className={`coll-diploma__note coll-diploma__note--${p.note.kind}`}>{p.note.kind === "deadline" ? `${p.note.label} ${p.note.date}` : p.note.text}</p> : null}
                  {p.excerpt ? <p className="coll-diploma__excerpt">{p.excerpt}</p> : null}
                  <Link href={p.href} className="coll-btn coll-btn--lg" aria-label={`${ctaLabel(p)}: ${p.title}`}>
                    <IconEdit />
                    {ctaLabel(p)}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </div>
    </section>
  );
}

function CardNote({ p }: { p: CollectionProduct }) {
  const note = p.note;
  if (!note) return <div className="coll-card__meta" />;
  if (note.kind === "deadline") {
    return (
      <div className="coll-card__meta coll-card__meta--deadline">
        <p className="coll-card__note">
          <span className="coll-card__note-label">{note.label}</span> <time dateTime={note.iso}>{note.date}</time>
        </p>
      </div>
    );
  }
  return (
    <div className="coll-card__meta">
      <p className={`coll-card__note${note.kind === "closed" ? " coll-card__note--closed" : ""}`}>{note.text}</p>
    </div>
  );
}

function CardsTemplate({ data }: { data: CollectionPage }) {
  return (
    <section className="coll-pf coll-pf--cards" aria-labelledby="coll-title">
      <div className="coll-container">
        {data.config.eyebrow ? <p className="coll-eyebrow">{data.config.eyebrow}</p> : null}
        <h1 id="coll-title" className="coll-title">
          {data.title}
        </h1>
        {data.description ? <p className="coll-text">{data.description}</p> : null}
        {data.products.length ? (
          <ul className="coll-grid list-unstyled" role="list">
            {data.products.map((p) => (
              <li key={p.slug} className="coll-card coll-hover" data-product={p.slug}>
                <Media p={p} width={560} className="coll-card__media coll-media" />
                <h2 className="coll-card__title">
                  <Link href={p.href}>{p.title}</Link>
                </h2>
                <CardNote p={p} />
                <Link href={p.href} className="coll-btn coll-card__btn" aria-label={`${ctaLabel(p)}: ${p.title}`}>
                  {ctaLabel(p)}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </div>
    </section>
  );
}

function GridTemplate({ data }: { data: CollectionPage }) {
  return (
    <div className="coll-dawn">
      <div className="collection-hero">
        <div className="page-width">
          <h1 className="collection-hero__title">{data.title}</h1>
          {data.description ? <p className="collection-hero__description">{data.description}</p> : null}
        </div>
      </div>
      <div className="coll-dawn__products page-width">
        {data.products.length ? (
          <ul className="product-grid list-unstyled" role="list">
            {data.products.map((p) => (
              <li key={p.slug} className="product-grid__item" data-product={p.slug}>
                <ProductCard
                  product={{
                    slug: p.slug,
                    title: p.title,
                    image: p.image ? { ...p.image, url: sizedImage(p.image.url, 600) } : null,
                    minPriceCents: p.fromPriceCents,
                  }}
                />
              </li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </div>
    </div>
  );
}

export default async function CollectionPageRoute({ params }: Props) {
  await connection(); // render dinámico: catálogo y notas de inscripción en vivo
  const data = await loadPage(decodeURIComponent((await params).slug));
  if (!data) notFound();
  return (
    <div className={`coll coll--${data.config.template}`} data-collection={data.slug}>
      {data.config.template === "diplomas" ? (
        <DiplomasTemplate data={data} />
      ) : data.config.template === "grid" ? (
        <GridTemplate data={data} />
      ) : (
        <CardsTemplate data={data} />
      )}
    </div>
  );
}
