"use client";
// Piezas comunes de Matrículas, Certificados, Inicio y la ficha del cliente (pieza a4): estado de una matrícula
// como badge Polaris, barra de progreso, avatar, fecha relativa y un `useRun` que ejecuta una acción del
// servidor con estado de envío, toast y refresco de la página.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useToast } from "../ui";
import { Badge } from "../orders/bits";
import type { BadgeSpec } from "../orders/format";

export type LearnState = "COMPLETED" | "IN_PROGRESS" | "PENDING" | "FAILED" | "UNENROLLED" | "LOCKED";

export const STATE_BADGE: Record<LearnState, BadgeSpec> = {
  COMPLETED: { label: "Completado", tone: "success", progress: "complete" },
  IN_PROGRESS: { label: "En curso", tone: "info", progress: "partial" },
  PENDING: { label: "Matriculando", tone: "attention", progress: "incomplete" },
  FAILED: { label: "Error de matrícula", tone: "critical", progress: "incomplete" },
  UNENROLLED: { label: "Desmatriculado", tone: "neutral", progress: "incomplete" },
  LOCKED: { label: "Sin habilitar", tone: "neutral", progress: "incomplete" },
};

export function StateBadge({ state, testId }: { state: LearnState; testId?: string }) {
  return <Badge spec={STATE_BADGE[state]} testId={testId} />;
}

/** Barra de progreso (Polaris ProgressBar, tamaño small). */
export function Bar({ value, max, tone = "primary", label }: { value: number; max: number; tone?: "primary" | "success" | "critical"; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <span className={`lp-bar ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Segmentos: un tramo por curso del diplomado, coloreado por su estado. */
export function Segments({ states, label }: { states: LearnState[]; label: string }) {
  const done = states.filter((s) => s === "COMPLETED").length;
  return (
    <span className="lp-seg" role="img" aria-label={`${label}: ${done} de ${states.length} cursos completados`}>
      {states.map((s, i) => (
        <span key={i} className={`s-${s.toLowerCase()}`} />
      ))}
    </span>
  );
}

const AVATAR_BG = ["#c4f4e9", "#fed3d1", "#ffe4a5", "#d6e4ff", "#e5d8ff", "#cdfee1", "#fcd7ff", "#ffd6a4"];
const AVATAR_FG = ["#0c5132", "#8e0b21", "#5e4200", "#00527c", "#4d2c9d", "#0c5132", "#6e0c7a", "#5e4200"];
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const k = h % AVATAR_BG.length;
  return (
    <span className="lp-av" style={{ width: size, height: size, background: AVATAR_BG[k], color: AVATAR_FG[k], fontSize: size <= 28 ? 11 : 14 }} aria-hidden="true">
      {ini}
    </span>
  );
}

const F_DM = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", timeZone: "America/Caracas" });
const F_DMY = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Caracas" });
/** «23 sept.» (con año si no es el actual). */
export function dm(d: Date | string, now: Date | string = new Date()): string {
  const a = new Date(d);
  return (a.getUTCFullYear() === new Date(now).getUTCFullYear() ? F_DM : F_DMY).format(a);
}

/** «hace 5 min», «hace 3 h», «hace 2 días». */
export function ago(d: Date | string | null | undefined, now: Date | string = new Date()): string {
  if (!d) return "Nunca";
  const s = Math.max(0, (new Date(now).getTime() - new Date(d).getTime()) / 1000);
  if (s < 60) return "Hace un momento";
  if (s < 3600) return `Hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `Hace ${Math.floor(s / 3600)} h`;
  const days = Math.floor(s / 86400);
  if (days < 31) return days === 1 ? "Hace 1 día" : `Hace ${days} días`;
  const m = Math.floor(days / 30);
  return m < 12 ? (m === 1 ? "Hace 1 mes" : `Hace ${m} meses`) : Math.floor(m / 12) === 1 ? "Hace 1 año" : `Hace ${Math.floor(m / 12)} años`;
}

export type RunResult = { ok: true; message: string } | { ok: false; error: string };

/** Ejecuta una acción del servidor: marca `busy`, muestra el toast y refresca la página. */
export function useRun() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = async (key: string, fn: () => Promise<RunResult>): Promise<RunResult> => {
    setBusy(key);
    try {
      const r = await fn();
      toast.show(r.ok ? r.message : r.error, !r.ok);
      start(() => router.refresh());
      return r;
    } catch (e) {
      console.error(e);
      const msg = "No pudimos completar la acción. Revisa tu conexión e intenta de nuevo.";
      toast.show(msg, true);
      return { ok: false, error: msg };
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, pending, toastNode: toast.node, toast: toast.show };
}
