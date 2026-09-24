"use client";
// Testimonio en video de la banda «Más de 6000 profesionales…». Carga liviana: miniatura de YouTube + botón de
// reproducir; el reproductor (youtube-nocookie, autoplay) solo se inserta al pulsar, así la home no descarga
// seis iframes de YouTube al abrir.
import { useState } from "react";

export function TestimonialVideo({ id, title }: { id: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <li className="home-video">
      {playing ? (
        <iframe
          className="home-video__frame"
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <button type="button" className="home-video__poster" onClick={() => setPlaying(true)} aria-label={`Reproducir video: ${title}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- miniatura del CDN de YouTube */}
          <img src={`https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`} alt="" loading="lazy" />
          <span className="home-video__title">{title}</span>
          <svg className="home-video__play" aria-hidden="true" focusable="false" viewBox="0 0 68 48" width="68" height="48">
            <path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26" fill="#f00" />
            <path d="M45 24 27 14v20" fill="#fff" />
          </svg>
        </button>
      )}
    </li>
  );
}
