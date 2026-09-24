"use client";
// Navega (reemplazando la entrada del historial) a `href` en cuanto la página se pinta. Lo usa la pantalla
// «Confirmando tu pago»: el navegador la mantiene visible mientras el servidor captura el cobro.
import { useEffect } from "react";

export function ContinueTo({ href }: { href: string }) {
  useEffect(() => {
    let t: number | undefined;
    // Un cuadro de pintura antes de salir, para que la pantalla de proceso llegue a verse.
    const raf = window.requestAnimationFrame(() => {
      t = window.setTimeout(() => window.location.replace(href), 60);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (t) window.clearTimeout(t);
    };
  }, [href]);
  return null;
}
