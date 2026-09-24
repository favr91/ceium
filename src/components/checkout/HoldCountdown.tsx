"use client";
// Cuenta regresiva de la reserva de cupo (semipresencial). Cuenta contra `expiresAt` del servidor; al llegar a
// cero recarga la página (el servidor decide: la reserva venció y el checkout vuelve a empezar).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function HoldCountdown({ expiresAt, serverNow }: { expiresAt: string; serverNow: string }) {
  const router = useRouter();
  const end = Date.parse(expiresAt);
  // Corrige el reloj del navegador con la hora del servidor al renderizar.
  const [skew] = useState(() => Date.parse(serverNow) - Date.now());
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + skew), 1000);
    return () => window.clearInterval(id);
  }, [skew]);
  const left = end - now;
  const expired = left <= 0;
  useEffect(() => {
    if (expired) {
      const t = window.setTimeout(() => router.refresh(), 1500);
      return () => window.clearTimeout(t);
    }
  }, [expired, router]);
  const urgent = left < 5 * 60_000;
  return (
    <span className="co-timer" data-urgent={urgent || undefined} data-testid="hold-countdown" role="timer" aria-live="off" aria-label={expired ? "Reserva vencida" : `Tiempo restante de la reserva: ${formatRemaining(left)}`}>
      {expired ? "00:00" : formatRemaining(left)}
    </span>
  );
}
