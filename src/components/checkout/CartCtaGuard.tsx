"use client";
// El botón flotante de WhatsApp (fijo abajo a la derecha) nunca debe tapar «Pagar pedido», PayPal ni el ahorro
// de una línea ([data-ck-wa-avoid]): mientras alguno se cruce con él, se aparta (cart.css lo oculta con html[data-ck-wa-yield]).
import { useEffect } from "react";

const ATTR = "data-ck-wa-yield";

function overlaps(a: DOMRect, b: DOMRect, pad: number): boolean {
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
}

export function CartCtaGuard() {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const check = () => {
      frame = 0;
      const wa = document.querySelector(".whatsapp-widget");
      const ctas = document.querySelectorAll<HTMLElement>("[data-ck-cta], [data-ck-wa-avoid]");
      if (!wa || ctas.length === 0) return root.removeAttribute(ATTR);
      // Rectángulo «de reposo» del botón (sin la transformación de ocultarlo).
      const r = wa.getBoundingClientRect();
      const home = new DOMRect(window.innerWidth - 10 - r.width, window.innerHeight - 10 - r.height, r.width, r.height);
      const hit = Array.from(ctas).some((el) => overlaps(el.getBoundingClientRect(), home, 8));
      if (hit) root.setAttribute(ATTR, "");
      else root.removeAttribute(ATTR);
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
      root.removeAttribute(ATTR);
    };
  }, []);
  return null;
}
