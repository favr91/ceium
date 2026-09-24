"use client";
// Piezas pequeñas del panel de Pedidos: badge con icono de progreso (Polaris), texto copiable, mini gráfica,
// menú desplegable con cierre al hacer clic fuera, botón con estado de envío.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import type { BadgeSpec, Progress, Tone } from "./format";

export function ProgressIcon({ progress }: { progress: Progress }) {
  if (!progress) return null;
  return (
    <svg className="pg" viewBox="0 0 12 12" aria-hidden="true">
      {progress === "complete" ? (
        <circle cx="6" cy="6" r="5" fill="currentColor" />
      ) : progress === "partial" ? (
        <>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 1.6a4.4 4.4 0 0 1 0 8.8Z" fill="currentColor" />
        </>
      ) : (
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 1.3" />
      )}
    </svg>
  );
}

export function Badge({ spec, testId, size }: { spec: BadgeSpec | { label: string; tone: Tone; progress?: Progress }; testId?: string; size?: "lg" }) {
  return (
    <span className={`badge ${spec.tone}${size ? ` ${size}` : ""}`} data-testid={testId}>
      <ProgressIcon progress={spec.progress ?? null} />
      {spec.label}
    </span>
  );
}

export function Copy({ text, label, children }: { text: string; label: string; children?: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <span className="copy">
      {children ?? text}
      <button
        type="button"
        aria-label={done ? "Copiado" : label}
        title={done ? "Copiado" : label}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        <Icon name={done ? "check" : "duplicate"} size={16} />
      </button>
    </span>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const w = 64;
  const h = 22;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => [i * step, h - 2 - (v / max) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path className="a1" d={`${line} L${w} ${h} L0 ${h} Z`} />
      <path className="l1" d={line} />
    </svg>
  );
}

/** Estado abierto/cerrado que se cierra con clic fuera o Escape. */
export function useDismiss<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);
  return [ref, open, setOpen] as const;
}

export function Spinner() {
  return <span className="spin" aria-hidden="true" />;
}

export function MethodIcon({ method }: { method: string }) {
  if (method === "PAYPAL")
    return (
      <span className="ic pp" aria-hidden="true">
        Pay<b>Pal</b>
      </span>
    );
  const c: Record<string, [string, string]> = { PAGO_MOVIL: ["pm", "PM"], TRANSFERENCIA: ["tr", "TRF"], ZELLE: ["zl", "Zelle"], EFECTIVO: ["ef", "$"] };
  const [cls, txt] = c[method] ?? ["", "?"];
  return (
    <span className={`ic ${cls}`} aria-hidden="true">
      {txt}
    </span>
  );
}
