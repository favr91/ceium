"use client";
// Imagen(es) del programa. Con una sola imagen es la foto fija de ceium.net (borde #eee, radio 12); con varias,
// un carrusel con scroll-snap (dedo/trackpad) y los puntos del slider PageFly para saltar entre fotos.
import { useEffect, useRef, useState } from "react";

/** Pide al CDN de Shopify el ancho justo (mismo criterio que sizedImage de home-data, que es solo servidor). */
function sizedImage(url: string, width: number): string {
  if (!/^(https?:)?\/\/(cdn\.shopify\.com|ceium\.net\/cdn)\//.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}

export interface GalleryImage {
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export function ProductGallery({ images, title }: { images: GalleryImage[]; title: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const el = track.current;
    if (!el || images.length < 2) return;
    const onScroll = () => setActive(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [images.length]);

  if (images.length === 0) return <div className="pp-media pp-media--empty" aria-hidden="true" />;

  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: i * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className="pp-media">
      <div className="pp-media__track" ref={track} tabIndex={images.length > 1 ? 0 : -1} aria-label={images.length > 1 ? `Imágenes de ${title}` : undefined} role={images.length > 1 ? "region" : undefined}>
        {images.map((im, i) => (
          // eslint-disable-next-line @next/next/no-img-element -- imágenes del CDN de Shopify / uploads
          <img
            key={im.url}
            className="pp-media__img"
            src={sizedImage(im.url, 1100)}
            alt={im.alt || title}
            width={im.width ?? 1600}
            height={im.height ?? 900}
            loading={i === 0 ? "eager" : "lazy"}
            fetchPriority={i === 0 ? "high" : undefined}
          />
        ))}
      </div>
      {images.length > 1 ? (
        <div className="pp-media__dots">
          {images.map((im, i) => (
            <button key={im.url} type="button" className={`pp-media__dot${i === active ? " is-active" : ""}`} aria-label={`Imagen ${i + 1} de ${images.length}`} aria-current={i === active || undefined} onClick={() => go(i)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
