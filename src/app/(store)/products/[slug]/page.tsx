// Ficha de producto (/products/<slug>): réplica de las fichas PageFly de ceium.net — foto + opciones de compra,
// franja de datos (requisitos, certificado, aval, duración), beneficios / cursos del diplomado / temario,
// equipo docente, carrusel de programas relacionados y la llamada «Obtén tu Certificado…». Además de lo que
// tenía la tienda original, el médico elige la cohorte (fechas y cupos en vivo) y ve el precio de cada
// combinación antes de agregar al carrito. Todo el contenido sale de la BD (ver product-data).
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { Carousel } from "@/components/store/home/Carousel";
import { sizedImage } from "@/components/store/home/home-data";
import { shareImage } from "@/components/store/image-url";
import { ProductBuyForm } from "@/components/store/product/ProductBuyForm";
import { getProductPage, type ProductPageData } from "@/components/store/product/product-data";
import { ProductGallery } from "@/components/store/product/ProductGallery";
import "../../home.css";
import "./product.css";

type Props = { params: Promise<{ slug: string }> };

const loadPage = cache((slug: string) => getProductPage(slug));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await connection();
  const data = await loadPage(decodeURIComponent((await params).slug));
  if (!data) return { title: "Programa no encontrado" };
  const image = data.images[0];
  return {
    title: data.title,
    description: data.seoDescription ?? undefined,
    // Vista previa al compartir el enlace (WhatsApp, Facebook): primera foto del programa.
    openGraph: {
      type: "website",
      siteName: "CEIUM",
      title: data.title,
      description: data.seoDescription ?? undefined,
      url: `/products/${data.slug}`,
      images: image ? [{ url: shareImage(image.url), alt: image.alt || data.title }] : undefined,
    },
    twitter: { card: image ? "summary_large_image" : "summary" },
  };
}

/** Triángulo de los acordeones del diplomado (abierto ▾ / cerrado ▸). */
function IconCaret() {
  return (
    <svg aria-hidden="true" focusable="false" className="pp-acc__icon pp-acc__icon--caret" viewBox="0 0 10 6" width="14" height="7">
      <path fill="currentColor" d="M0 0h10L5 6z" />
    </svg>
  );
}

/** Chevron del acordeón «Temas a tratar» (abierto ⌄ / cerrado ›). */
function IconChevron() {
  return (
    <svg aria-hidden="true" focusable="false" className="pp-acc__icon pp-acc__icon--chevron" viewBox="0 0 14 9" width="14" height="9">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m1.5 1.5 5.5 5.5 5.5-5.5" />
    </svg>
  );
}

function IconFileDown() {
  return (
    <svg aria-hidden="true" focusable="false" className="pp-icon" viewBox="0 0 384 512" width="9" height="12">
      <path fill="currentColor" d="M64 0C28.7 0 0 28.7 0 64v384c0 35.3 28.7 64 64 64h256c35.3 0 64-28.7 64-64V160H256c-17.7 0-32-14.3-32-32V0zm192 0v128h128zm-40 232v102.1l31-31c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-72 72c-9.4 9.4-24.6 9.4-33.9 0l-72-72c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l31 31V232c0-13.3 10.7-24 24-24s24 10.7 24 24" />
    </svg>
  );
}

function IconArrowRight() {
  return (
    <svg aria-hidden="true" focusable="false" className="pp-icon" viewBox="0 0 448 512" width="14" height="16">
      <path fill="currentColor" d="M438.6 278.6c12.5-12.5 12.5-32.8 0-45.3l-160-160c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L338.8 224 32 224c-17.7 0-32 14.3-32 32s14.3 32 32 32l306.7 0L233.4 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0l160-160z" />
    </svg>
  );
}

function Hero({ data }: { data: ProductPageData }) {
  return (
    <section className="pp-hero" aria-labelledby="pp-title">
      <div className="pp-container">
        <div className="pp-hero__box">
          <ProductGallery images={data.images} title={data.title} />
          <div className="pp-hero__info">
            <h1 id="pp-title" className="pp-title">
              {data.title}
            </h1>
            {data.intro ? <p className="pp-intro">{data.intro}</p> : null}
            {data.eventDateText ? (
              <p className="pp-fact">
                <strong>Fecha:</strong> {data.eventDateText}
              </p>
            ) : null}
            {data.belongsTo ? (
              <p className="pp-fact pp-fact--belongs">
                <strong>🎓 Pertenece al:</strong> <Link href={data.belongsTo.href}>{data.belongsTo.title}</Link>
              </p>
            ) : null}
            {data.enrollmentNote ? <p className={`pp-note${data.enrollmentNote.closed ? " pp-note--closed" : ""}`}>{data.enrollmentNote.text}</p> : null}
            {data.scheduleLinks.length ? (
              <ul className="pp-schedules list-unstyled">
                {data.scheduleLinks.map((s) => (
                  <li key={s.href}>
                    <Link href={s.href}>📅 {s.label}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
            <ProductBuyForm config={data.buy} title={data.title} />
          </div>
        </div>
      </div>
    </section>
  );
}

function InfoStrip({ data }: { data: ProductPageData }) {
  if (!data.info.length) return null;
  return (
    <section className="pp-info" aria-label="Datos del programa">
      <div className="pp-container">
        <ul className="pp-info__list list-unstyled" style={{ "--pp-info-cols": data.info.length } as React.CSSProperties}>
          {data.info.map((i) => (
            <li key={i.key} className="pp-info__item">
              {/* eslint-disable-next-line @next/next/no-img-element -- iconos SVG del CDN */}
              <img className="pp-info__icon" src={i.icon} alt="" width={30} height={30} />
              <div>
                <h2 className="pp-info__title">{i.title}</h2>
                <p className="pp-info__text">{i.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Details({ data }: { data: ProductPageData }) {
  const diploma = data.type === "DIPLOMA";
  const hasMain = diploma ? data.benefits.length > 0 || data.diplomaCourses.length > 0 : data.topics.length > 0 || !!data.syllabusUrl;
  if (!hasMain && !data.faculty.length) return null;
  return (
    <section className="pp-details">
      <div className="pp-container pp-details__grid">
        {hasMain ? (
          <div className={`pp-card pp-card--main${diploma ? " pp-card--diploma" : ""}`}>
            {diploma ? (
              <>
                {data.benefits.length ? (
                  <details className="pp-acc pp-acc--caret" open>
                    <summary className="pp-acc__head">
                      <h2 className="pp-acc__title">Beneficios</h2>
                      <IconCaret />
                    </summary>
                    <ul className="pp-benefits list-unstyled">
                      {data.benefits.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {data.diplomaCourses.length ? (
                  <details className="pp-acc pp-acc--caret">
                    <summary className="pp-acc__head">
                      <h2 className="pp-acc__title">Cursos de este diplomado</h2>
                      <IconCaret />
                    </summary>
                    <ol className="pp-dcourses list-unstyled">
                      {data.diplomaCourses.map((c) => (
                        <li key={c.n}>
                          <strong className="pp-dcourses__title">
                            {c.n}. {c.href ? <Link href={c.href}>{c.title}</Link> : c.title}:
                          </strong>
                          {c.highlights.length ? (
                            <ul className="pp-bullets">
                              {c.highlights.map((h) => (
                                <li key={h}>{h}</li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </>
            ) : (
              <>
                <div className="pp-card__head">
                  <h2 className="pp-card__title">{data.topicsTitle}</h2>
                  {data.syllabusUrl ? (
                    <a className="pp-download" href={data.syllabusUrl} target="_blank" rel="noopener noreferrer">
                      <IconFileDown />
                      Descargar contenido
                    </a>
                  ) : null}
                </div>
                {data.topics.length ? (
                  <details className="pp-acc pp-acc--chevron" open={data.category !== "WORKSHOP"}>
                    <summary className="pp-acc__head">
                      <h3 className="pp-acc__title pp-acc__title--sm">Temas a tratar</h3>
                      <IconChevron />
                    </summary>
                    <div className="pp-topics">
                      {data.topics.map((t, i) => (
                        <div key={`${t.title}-${i}`} className="pp-topic">
                          {t.title ? <strong className="pp-topic__title">{t.title}</strong> : null}
                          {t.lead ? <p className="pp-topic__lead">{t.lead}</p> : null}
                          {t.items.length ? (
                            <ul className="pp-bullets pp-bullets--circle">
                              {t.items.map((it) => (
                                <li key={it}>{it}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {data.faculty.length ? (
          <div className="pp-card pp-card--faculty">
            <h2 className="pp-card__title">Equipo docente</h2>
            <ul className="pp-faculty list-unstyled">
              {data.faculty.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Related({ data }: { data: ProductPageData }) {
  const r = data.related;
  if (!r) return null;
  return (
    <section className="pp-related" aria-labelledby="pp-related-title">
      <div className="pp-container">
        <div className="pp-related__head">
          <h2 id="pp-related-title" className="pp-h2">
            {r.title}
          </h2>
          {r.link ? (
            <Link href={r.link.href} className="pp-related__link">
              {r.link.label}
              <IconArrowRight />
            </Link>
          ) : null}
        </div>
        <Carousel label={r.title} className="pp-related__carousel" equalize>
          {r.products.map((p) => (
            <li key={p.slug} className="home-card pp-rcard">
              <Link href={p.href} className="home-card__media" tabIndex={-1} aria-hidden="true">
                {p.image ? (
                  // eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN de Shopify / uploads
                  <img src={sizedImage(p.image.url, 600)} alt="" width={16} height={9} loading="lazy" />
                ) : null}
              </Link>
              <h3 className="home-card__title">
                <Link href={p.href}>{p.title}</Link>
              </h3>
              <Link href={p.href} className="home-btn home-card__btn" aria-label={`Inscríbete: ${p.title}`}>
                Inscríbete
              </Link>
            </li>
          ))}
        </Carousel>
      </div>
    </section>
  );
}

function CertificateBand({ data }: { data: ProductPageData }) {
  const c = data.certificate;
  return (
    <section className="pp-cert" aria-labelledby="pp-cert-title">
      <div className="pp-container">
        <div className="pp-cert__box">
          <div className="pp-cert__text">
            <h2 id="pp-cert-title" className="pp-cert__title">
              {c.title}
            </h2>
            <p className="pp-cert__lead">{c.text}</p>
            <ul className="pp-cert__items list-unstyled">
              {c.items.map((it) => (
                <li key={it.title}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- iconos SVG del CDN */}
                  <img src={it.icon} alt="" width={32} height={32} loading="lazy" />
                  <div>
                    <h3>{it.title}</h3>
                    <p>{it.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- foto del CDN de Shopify */}
          <img className="pp-cert__img" src={sizedImage(c.image, 900)} alt="" width={406} height={406} loading="lazy" />
        </div>
      </div>
    </section>
  );
}

export default async function ProductPage({ params }: Props) {
  await connection(); // cupos y precios en vivo: render dinámico
  const data = await loadPage(decodeURIComponent((await params).slug));
  if (!data) notFound();
  return (
    <div className={`pp pp--${data.category.toLowerCase().replace("_", "-")}`} data-product={data.slug}>
      <Hero data={data} />
      <InfoStrip data={data} />
      <Details data={data} />
      <Related data={data} />
      <CertificateBand data={data} />
    </div>
  );
}
