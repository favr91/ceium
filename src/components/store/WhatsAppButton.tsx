"use client";
// Botón flotante de WhatsApp (número de la Setting `store.contact.whatsapp`).
// Nunca tapa contenido marcado con [data-wa-avoid] (p. ej. los logos de «Nuestros aliados»): mientras su
// posición de reposo se cruce con uno, se aparta con un fundido (data-yield) y vuelve al dejar de cruzarse.
import { useEffect, useRef } from "react";
import { IconWhatsApp } from "./icons";

function overlaps(a: DOMRect, b: DOMRect, pad: number): boolean {
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}

export function WhatsAppButton({ href }: { href: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wa = ref.current;
    if (!wa) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const avoid = document.querySelectorAll<HTMLElement>("[data-wa-avoid]");
      if (avoid.length === 0) return wa.removeAttribute("data-yield");
      // Rectángulo «de reposo» (sin la transformación de apartarse): right/bottom de store.css.
      const cs = getComputedStyle(wa);
      const w = wa.offsetWidth;
      const h = wa.offsetHeight;
      const rest = new DOMRect(
        window.innerWidth - parseFloat(cs.right) - w,
        window.innerHeight - parseFloat(cs.bottom) - h,
        w,
        h,
      );
      const hit = Array.from(avoid).some((el) => overlaps(el.getBoundingClientRect(), rest, 6));
      if (hit) wa.setAttribute("data-yield", "");
      else wa.removeAttribute("data-yield");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="whatsapp-widget" ref={ref}>
      <a className="whatsapp-widget__link" href={href} target="_blank" rel="noopener noreferrer" aria-label="Escríbenos por WhatsApp">
        <IconWhatsApp width={63} height={63} />
      </a>
    </div>
  );
}
