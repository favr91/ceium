"use client";
// Piezas pequeñas del panel: badge de estado, toast, modal, popover con cierre al hacer clic fuera.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { STATUS_LABEL, type Status } from "./products/types";

export function StatusBadge({ status }: { status: Status }) {
  const tone = status === "ACTIVE" ? "success" : status === "DRAFT" ? "info" : "neutral";
  return <span className={`badge ${tone}`} data-status={status}>{STATUS_LABEL[status]}</span>;
}

export interface ToastMsg { text: string; error?: boolean; id: number }

export function useToast() {
  const [toast, setToast] = useState<ToastMsg | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const show = (text: string, error = false) => setToast({ text, error, id: Date.now() });
  const node = toast ? (
    <div className={`toast${toast.error ? " err" : ""}`} role={toast.error ? "alert" : "status"} key={toast.id}>
      <span>{toast.text}</span>
      <button aria-label="Cerrar" onClick={() => setToast(null)}><Icon name="x" size={16} /></button>
    </div>
  ) : null;
  return { show, node };
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          <h2>{title}</h2>
          <button className="btn btn-tertiary btn-icon" aria-label="Cerrar" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="modal-b">{children}</div>
        <div className="modal-f">{footer}</div>
      </div>
    </div>
  );
}

/** Estado abierto/cerrado que se cierra al hacer clic fuera del contenedor. */
export function useOutside<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return [ref, open, setOpen] as const;
}
