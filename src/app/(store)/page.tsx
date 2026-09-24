// Home de la tienda: réplica de la home de ceium.net (hero con fotos rotativas, aliados, diplomados con sus
// cronogramas, carruseles por colección, confianza, galería y llamada final). El catálogo sale de la BD
// (colecciones, productos, notas de inscripción, cronogramas de cohortes); lo editorial, de `store.home`.
import Link from "next/link";
import { connection } from "next/server";
import { Carousel } from "@/components/store/home/Carousel";
import { getHomeData, sizedImage, type HomeProduct, type HomeRow } from "@/components/store/home/home-data";
import { HeroSlider } from "@/components/store/home/HeroSlider";
import { IconArrow } from "@/components/store/icons";
import "./home.css";

function IconCalendar() {
  return (
    <svg aria-hidden="true" focusable="false" className="home-icon" viewBox="0 0 448 512" width="14" height="16">
      <path fill="currentColor" d="M0 464c0 26.5 21.5 48 48 48h352c26.5 0 48-21.5 48-48V192H0zm320-196c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12h-40c-6.6 0-12-5.4-12-12zm0 128c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12h-40c-6.6 0-12-5.4-12-12zM192 268c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12h-40c-6.6 0-12-5.4-12-12zm0 128c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12h-40c-6.6 0-12-5.4-12-12zM64 268c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12H76c-6.6 0-12-5.4-12-12zm0 128c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12H76c-6.6 0-12-5.4-12-12zM400 64h-48V16c0-8.8-7.2-16-16-16h-32c-8.8 0-16 7.2-16 16v48H160V16c0-8.8-7.2-16-16-16h-32c-8.8 0-16 7.2-16 16v48H48C21.5 64 0 85.5 0 112v48h448v-48c0-26.5-21.5-48-48-48" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg aria-hidden="true" focusable="false" className="home-icon" viewBox="0 0 512 512" width="13" height="13">
      <path fill="currentColor" d="M471.6 21.7c-21.9-21.9-57.3-21.9-79.2 0l-30.1 30 97.9 97.9 30.1-30.1c21.9-21.9 21.9-57.3 0-79.2zM172.4 241.7c-6.1 6.1-10.8 13.6-13.5 21.9l-29.6 88.8c-2.9 8.6-.6 18.1 5.8 24.6s15.9 8.7 24.6 5.8l88.8-29.6c8.2-2.7 15.7-7.4 21.9-13.5l167.3-167.4-97.9-97.9zM96 64c-53 0-96 43-96 96v256c0 53 43 96 96 96h256c53 0 96-43 96-96v-96c0-17.7-14.3-32-32-32s-32 14.3-32 32v96c0 17.7-14.3 32-32 32H96c-17.7 0-32-14.3-32-32V160c0-17.7 14.3-32 32-32h96c17.7 0 32-14.3 32-32s-14.3-32-32-32z" />
    </svg>
  );
}

function ProductTile({ product, width }: { product: HomeProduct; width: number }) {
  const href = `/products/${product.slug}`;
  return (
    <li className="home-card">
      <Link href={href} className="home-card__media" tabIndex={-1} aria-hidden="true">
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN de Shopify / uploads
          <img src={sizedImage(product.image.url, width)} alt="" width={16} height={9} loading="lazy" />
        ) : null}
      </Link>
      <h3 className="home-card__title">
        <Link href={href}>{product.title}</Link>
      </h3>
      {product.note ? <p className="home-card__note">{product.note}</p> : null}
      <Link href={href} className="home-btn home-card__btn" aria-label={`Inscríbete: ${product.title}`}>
        Inscríbete
      </Link>
    </li>
  );
}

function CollectionRow({ row, index }: { row: HomeRow; index: number }) {
  const headingId = `home-row-${row.slug}`;
  return (
    <section className={`home-row home-row--${row.layout}${index === 0 ? " home-row--first" : ""}`} aria-labelledby={headingId}>
      <div className="home-container">
        <div className="home-row__head">
          <h2 id={headingId} className="home-h2 home-row__title">
            {row.title}
          </h2>
          {row.linkLabel ? (
            <Link href={row.href} className="home-row__link">
              {row.linkLabel}
              <IconArrow width={14} height={10} />
            </Link>
          ) : null}
        </div>
        <Carousel label={row.title.replace(/^\P{L}+/u, "")} className="home-row__carousel">
          {row.products.map((p) => (
            <ProductTile key={p.slug} product={p} width={row.layout === "wide" ? 540 : 480} />
          ))}
        </Carousel>
      </div>
    </section>
  );
}

export default async function HomePage() {
  await connection(); // render dinámico: lee la BD en cada request
  const { config, diplomas, rows } = await getHomeData();
  const { hero, partners, trust, gallery, closing } = config;

  return (
    <div className="home">
      <section className="home-hero" aria-labelledby="home-hero-title">
        <HeroSlider slides={hero.slides} start={hero.start} />
        <div className="home-container home-hero__content">
          <h1 id="home-hero-title" className="home-hero__title">
            {hero.title}
          </h1>
          <p className="home-hero__subtitle">{hero.subtitle}</p>
          <div className="home-hero__buttons">
            <Link href={hero.primary.url} className="home-btn home-btn--lg">
              <span className="home-hero__label--desktop">{hero.primary.label}</span>
              <span className="home-hero__label--mobile">{hero.primary.mobileLabel}</span>
            </Link>
            <Link href={hero.secondary.url} className="home-btn home-btn--lg home-btn--alt">
              <span className="home-hero__label--desktop">{hero.secondary.label}</span>
              <span className="home-hero__label--mobile">{hero.secondary.mobileLabel}</span>
            </Link>
          </div>
        </div>
      </section>

      {partners.logos.length ? (
        <section className="home-partners" aria-labelledby="home-partners-title">
          <div className="home-container">
            <h2 id="home-partners-title" className="home-partners__title">
              {partners.title}
            </h2>
            <ul className="home-partners__list list-unstyled">
              {partners.logos.map((l) => (
                <li key={l.src} data-wa-avoid>
                  {/* eslint-disable-next-line @next/next/no-img-element -- logos SVG/WebP del CDN */}
                  <img src={l.src} alt={l.alt} loading="lazy" />
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {diplomas.length ? (
        <section className="home-diplomas" aria-labelledby="home-diplomas-title">
          <div className="home-container">
            <div className="home-diplomas__box">
              <h2 id="home-diplomas-title" className="home-h2">
                {config.diplomas.title}
              </h2>
              <p className="home-diplomas__text">{config.diplomas.text}</p>
              <ul className="home-diplomas__grid list-unstyled">
                {diplomas.map((d) => {
                  const href = `/products/${d.slug}`;
                  return (
                    <li key={d.slug} className="home-diploma">
                      <Link href={href} className="home-diploma__media" tabIndex={-1} aria-hidden="true">
                        {d.image ? (
                          // eslint-disable-next-line @next/next/no-img-element -- imagen del CDN de Shopify
                          <img src={sizedImage(d.image.url, 960)} alt="" width={16} height={9} loading="lazy" />
                        ) : null}
                      </Link>
                      <p className="home-diploma__badge">{d.modality}</p>
                      <h3 className="home-diploma__title">
                        <Link href={href}>{d.title}</Link>
                      </h3>
                      {d.excerpt ? <p className="home-diploma__excerpt">{d.excerpt}</p> : null}
                      {d.schedules.length ? (
                        <ul className="home-diploma__schedules list-unstyled">
                          {d.schedules.map((s) => (
                            <li key={s.url}>
                              <a href={s.url} target="_blank" rel="noopener noreferrer">
                                <IconCalendar />
                                {s.label}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <Link href={href} className="home-btn home-diploma__btn" aria-label={`Inscríbete: ${d.title}`}>
                        <IconEdit />
                        Inscríbete
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      {rows.map((row, i) => (
        <CollectionRow key={row.slug} row={row} index={i} />
      ))}

      <section className="home-trust" aria-labelledby="home-trust-title">
        <div className="home-container">
          <h2 id="home-trust-title" className="home-h2 home-trust__title">
            {trust.title}
          </h2>
          <Link href={trust.cta.url} className="home-btn home-btn--lg home-btn--outline">
            {trust.cta.label}
            <IconArrow width={14} height={10} />
          </Link>
        </div>
      </section>

      {gallery.images.length ? (
        <section className="home-gallery" aria-labelledby="home-gallery-title">
          <div className="home-container">
            <h2 id="home-gallery-title" className="home-h2">
              {gallery.title}
            </h2>
            <Carousel label={gallery.title} className="home-gallery__carousel">
              {gallery.images.map((g) => (
                <li key={g.src} className="home-gallery__item">
                  {/* eslint-disable-next-line @next/next/no-img-element -- fotos del CDN de Shopify */}
                  <img src={sizedImage(g.src, 500)} alt={g.alt} loading="lazy" />
                </li>
              ))}
            </Carousel>
          </div>
        </section>
      ) : null}

      <section className="home-closing" aria-labelledby="home-closing-title">
        <div className="home-container">
          <div className="home-closing__box" style={{ backgroundImage: `url("${closing.image}")` }}>
            <p className="home-closing__eyebrow">{closing.eyebrow}</p>
            <h2 id="home-closing-title" className="home-closing__title">
              {closing.title}
            </h2>
            <p className="home-closing__text">{closing.text}</p>
            <Link href={closing.cta.url} className="home-btn home-btn--lg">
              {closing.cta.label}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
