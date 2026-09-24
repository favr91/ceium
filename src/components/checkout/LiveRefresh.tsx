"use client";
// Vuelve a pedir la página al servidor cada `everyMs` mientras haya algo en curso (PayPal revisando el pago,
// acceso al aula virtual en preparación). Se detiene sola tras `forMs` o cuando el servidor deja de renderizarla.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function LiveRefresh({ everyMs = 4000, forMs = 10 * 60_000 }: { everyMs?: number; forMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const start = Date.now();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - start > forMs) return window.clearInterval(id);
      router.refresh();
    }, everyMs);
    return () => window.clearInterval(id);
  }, [router, everyMs, forMs]);
  return null;
}
