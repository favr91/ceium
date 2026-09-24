"use client";
// Botón «play» del banner de Quiénes somos: abre el video de YouTube en un diálogo modal (como el popup de
// PageFly: fondo negro al 90 %, franja blanca con la X y el reproductor 16:9 en autoplay). Esc, la X o un clic
// fuera del video lo cierran y detienen el video (el iframe solo existe mientras el diálogo está abierto).
import { useEffect, useRef, useState } from "react";
import { IconClose } from "@/components/store/icons";

export function VideoModal({ youtubeId, title, playIcon }: { youtubeId: string; title: string; playIcon: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const src = `https://www.youtube.com/embed/${encodeURIComponent(youtubeId)}?autoplay=1&loop=0&mute=0&controls=1&rel=0&enablejsapi=1`;

  return (
    <>
      <button type="button" className="pg-play" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Ver video: ${title}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- icono del CDN de Shopify */}
        <img src={playIcon} alt="" width={88} height={88} />
      </button>
      <dialog
        ref={dialogRef}
        className="pg-video"
        aria-label={title}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // Clic en el fondo (el propio <dialog>, fuera de la caja del video) → cerrar.
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div className="pg-video__box">
          <button type="button" className="pg-video__close" onClick={() => setOpen(false)} aria-label="Cerrar video">
            <IconClose width={16} height={16} />
          </button>
          <div className="pg-video__frame">
            {open ? <iframe src={src} title={title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen /> : null}
          </div>
        </div>
      </dialog>
    </>
  );
}
