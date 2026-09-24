"use client";
// Carrusel horizontal de la home (tarjetas de productos y galería). Pista con scroll-snap (se arrastra con el
// dedo o el trackpad) y flechas que avanzan una tarjeta; cada flecha se oculta cuando no hay más en esa dirección.
import { useCallback, useEffect, useRef, useState } from "react";

function Chevron({ dir }: { dir: "prev" | "next" }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === "next" ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"} />
    </svg>
  );
}

export function Carousel({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  const track = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  const update = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft >= max - 2 });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [update]);

  const step = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const first = el.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
    const by = first ? first.offsetWidth + gap : el.clientWidth * 0.8;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * by, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className={`home-carousel${className ? ` ${className}` : ""}`} role="region" aria-roledescription="carrusel" aria-label={label}>
      <ul className="home-carousel__track list-unstyled" ref={track}>
        {children}
      </ul>
      <button type="button" className="home-carousel__btn home-carousel__btn--prev" aria-label="Anterior" hidden={edges.start} onClick={() => step(-1)}>
        <Chevron dir="prev" />
      </button>
      <button type="button" className="home-carousel__btn home-carousel__btn--next" aria-label="Siguiente" hidden={edges.end} onClick={() => step(1)}>
        <Chevron dir="next" />
      </button>
    </div>
  );
}
