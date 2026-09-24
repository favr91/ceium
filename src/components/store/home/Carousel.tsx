"use client";
// Carrusel horizontal de la home (tarjetas de productos, testimonios y galería), como los sliders PageFly de
// ceium.net: la pista es un scroll nativo con scroll-snap (se arrastra con el dedo, el trackpad o la rueda con
// Mayús, y con las flechas del teclado cuando tiene foco) y dos botones redondos que avanzan media «página» de
// tarjetas (2 en escritorio, 1 en móvil). Cada botón se oculta cuando no hay más en esa dirección.
import { useCallback, useEffect, useRef, useState } from "react";

function Chevron() {
  // Dos trazos de 1 × 8 px a ±45°, como el `nav-style-1` de PageFly.
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 40 40" width="40" height="40">
      <path d="M17.2 14.3 22.9 20l-5.7 5.7" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" />
    </svg>
  );
}

/**
 * Alto común de las tarjetas, como el «equal height» de PageFly en ceium.net: todas miden lo que mide la PRIMERA
 * (su contenido natural); una tarjeta con más texto invade su relleno inferior, pero nunca deja menos de
 * `MIN_BOTTOM` px bajo el botón.
 */
const MIN_BOTTOM = 10;
function equalizeHeights(el: HTMLElement) {
  const items = [...el.children] as HTMLElement[];
  if (items.length === 0) return;
  el.style.removeProperty("--home-card-h");
  const natural = items.map((i) => i.getBoundingClientRect().height);
  const pad = parseFloat(getComputedStyle(items[0]).paddingBottom) || 0;
  const tallest = Math.max(...natural);
  const h = Math.round(Math.max(natural[0], tallest - Math.max(0, pad - MIN_BOTTOM)));
  el.style.setProperty("--home-card-h", `${h}px`);
}

export function Carousel({
  label,
  className,
  equalize = false,
  children,
}: {
  label: string;
  className?: string;
  /** Igualar el alto de las tarjetas al de la primera (filas de productos). */
  equalize?: boolean;
  children: React.ReactNode;
}) {
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
    let width = -1;
    const onResize = () => {
      // Solo si cambia el ancho (el alto cambia justamente al igualar).
      if (equalize && el.clientWidth !== width) {
        width = el.clientWidth;
        equalizeHeights(el);
      }
      update();
    };
    onResize();
    let alive = true;
    if (equalize) void document.fonts?.ready.then(() => alive && equalizeHeights(el));
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => {
      alive = false;
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [update, equalize]);

  const step = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const items = [...el.children] as HTMLElement[];
    if (items.length === 0) return;
    const pitch = items.length > 1 ? items[1].offsetLeft - items[0].offsetLeft : items[0].offsetWidth;
    const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
    // Tarjetas enteras visibles → se avanza la mitad (mín. 1), alineado a la rejilla del snap.
    const visible = Math.max(1, Math.floor((el.clientWidth - pad + 1) / pitch));
    const by = Math.max(1, Math.floor(visible / 2)) * pitch;
    const current = Math.round(el.scrollLeft / pitch);
    const target = Math.min(el.scrollWidth - el.clientWidth, Math.max(0, (current + (dir * by) / pitch) * pitch));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: target, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className={`home-carousel${className ? ` ${className}` : ""}`} role="region" aria-roledescription="carrusel" aria-label={label}>
      {/* La pista con foco se desplaza con ← → (scroll nativo). */}
      <ul className="home-carousel__track list-unstyled" ref={track} tabIndex={0} data-equalize={equalize ? "" : undefined}>
        {children}
      </ul>
      <button type="button" className="home-carousel__btn home-carousel__btn--prev" aria-label="Anterior" hidden={edges.start} onClick={() => step(-1)}>
        <Chevron />
      </button>
      <button type="button" className="home-carousel__btn home-carousel__btn--next" aria-label="Siguiente" hidden={edges.end} onClick={() => step(1)}>
        <Chevron />
      </button>
    </div>
  );
}
