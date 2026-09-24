"use client";
// Fondo del hero: rota las fotos cada 5 s con fundido (como el "background-slider" de la home de ceium.net).
// En escritorio el texto va sobre la foto; en móvil la foto va arriba (240 px) y el texto debajo sobre gris.
import { useEffect, useState } from "react";

export function HeroSlider({ slides, start }: { slides: { desktop: string; mobile: string }[]; start: number }) {
  const [index, setIndex] = useState(() => (slides.length ? start % slides.length : 0));

  useEffect(() => {
    if (slides.length < 2) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), 5000);
    return () => window.clearInterval(id);
  }, [slides.length]);

  return (
    <div className="home-hero__slides" aria-hidden="true" data-slide={index}>
      {slides.map((s, i) => (
        <picture key={s.desktop} className={`home-hero__slide${i === index ? " is-active" : ""}`}>
          <source media="(min-width: 750px)" srcSet={s.desktop} />
          <img src={s.mobile} alt="" loading={i === index ? "eager" : "lazy"} fetchPriority={i === index ? "high" : "low"} />
        </picture>
      ))}
    </div>
  );
}
