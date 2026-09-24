"use client";
// Modales de la ficha del pedido: comprobante ampliado, texto con motivo (condonar, cancelar), confirmación,
// reasignar cohorte, ajustar saldo y vista previa de un correo enviado.
import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import type { OrderDetail } from "@/server/admin-order-views";
import { Spinner } from "./bits";
import { COHORT_STATUS, calDate, usd } from "./format";
import { parseMoney } from "../products/money";

function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
}

function Shell({ title, size, onClose, children, footer, onSubmit, formLabel }: { title: string; size?: "md" | "lg"; onClose: () => void; children: React.ReactNode; footer: React.ReactNode; onSubmit?: () => void; formLabel?: string }) {
  useEscape(onClose);
  const body = (
    <>
      <div className="modal-h">
        <h2>{title}</h2>
        <button type="button" className="btn btn-tertiary btn-icon" aria-label="Cerrar" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-b scroll">{children}</div>
      <div className="modal-f">{footer}</div>
    </>
  );
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {onSubmit ? (
        <form
          className={`modal ${size ?? "md"}`}
          role="dialog"
          aria-modal="true"
          aria-label={formLabel ?? title}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {body}
        </form>
      ) : (
        <div className={`modal ${size ?? "md"}`} role="dialog" aria-modal="true" aria-label={title}>
          {body}
        </div>
      )}
    </div>
  );
}

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Comprobante ampliado" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element -- archivo privado servido por el panel */}
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <button type="button" className="x" aria-label="Cerrar" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}

export function TextModal({ title, label, help, confirm, critical, required = true, busy, onClose, onSubmit }: { title: string; label: string; help?: React.ReactNode; confirm: string; critical?: boolean; required?: boolean; busy: boolean; onClose: () => void; onSubmit: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Shell
      title={title}
      onClose={onClose}
      onSubmit={() => onSubmit(text)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className={`btn ${critical ? "btn-critical" : "btn-primary"}`} disabled={busy || (required && !text.trim())}>
            {busy ? <Spinner /> : null}
            {confirm}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{label}</span>
        <textarea className="inp" rows={3} value={text} onChange={(e) => setText(e.target.value)} required={required} autoFocus />
        {help ? <span className="help">{help}</span> : null}
      </label>
    </Shell>
  );
}

export function ConfirmModal({ title, children, confirm, critical, busy, onClose, onConfirm }: { title: string; children: React.ReactNode; confirm: string; critical?: boolean; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Shell
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className={`btn ${critical ? "btn-critical" : "btn-primary"}`} disabled={busy} onClick={onConfirm}>
            {busy ? <Spinner /> : null}
            {confirm}
          </button>
        </>
      }
    >
      <div style={{ lineHeight: "20px" }}>{children}</div>
    </Shell>
  );
}

type O = OrderDetail;

export function ReassignModal({ o, busy, onClose, onSubmit }: { o: O; busy: boolean; onClose: () => void; onSubmit: (itemId: string, cohortId: string, note: string) => void }) {
  const items = o.items.filter((i) => i.modality === "SEMIPRESENCIAL");
  const [itemId, setItemId] = useState(items[0]?.id ?? "");
  const item = items.find((i) => i.id === itemId);
  const options = o.cohortOptions.filter((c) => c.productId === item?.productId);
  const [cohortId, setCohortId] = useState("");
  const [note, setNote] = useState("");
  const current = item?.cohortId;
  const seatLost = item?.reservation?.status === "RELEASED" || !item?.reservation;
  return (
    <Shell
      title="Reasignar cohorte"
      onClose={onClose}
      onSubmit={() => cohortId && onSubmit(itemId, cohortId, note)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !cohortId}>
            {busy ? <Spinner /> : null}
            Reasignar
          </button>
        </>
      }
    >
      {items.length > 1 ? (
        <label className="field">
          <span>Programa</span>
          <select className="inp" value={itemId} onChange={(e) => { setItemId(e.target.value); setCohortId(""); }}>
            {items.map((i) => (
              <option key={i.id} value={i.id}>{i.productTitle}</option>
            ))}
          </select>
        </label>
      ) : (
        <p style={{ marginBottom: 12 }}>
          <b>{item?.productTitle}</b>
          <br />
          <span className="muted">Actual: {item?.cohort ? `${item.cohort.name} · ${item.cohort.sede.name}` : "sin cohorte"}</span>
        </p>
      )}
      <div className="cohort-opts" role="radiogroup" aria-label="Cohorte nueva">
        {options.map((c) => {
          const isCurrent = c.id === current;
          const disabled = (c.free <= 0 && !isCurrent) || (isCurrent && !seatLost);
          return (
            <label key={c.id} className={`cohort-opt${cohortId === c.id ? " on" : ""}${disabled ? " dis" : ""}`}>
              <input type="radio" name="cohort" value={c.id} checked={cohortId === c.id} disabled={disabled} onChange={() => setCohortId(c.id)} />
              <span className="i">
                <span className="strong">{c.name} · {c.sede}</span>
                <span className="s" style={{ display: "block" }}>
                  {calDate(c.startDate)} – {calDate(c.endDate)} · {COHORT_STATUS[c.status] ?? c.status}
                </span>
              </span>
              <span className={`badge ${isCurrent ? "info" : c.free > 0 ? (c.free <= 3 ? "attention" : "success") : "critical"}`}>
                {isCurrent ? (seatLost ? "Actual · retomar cupo" : "Actual") : c.free > 0 ? `${c.free} ${c.free === 1 ? "cupo" : "cupos"}` : "Sin cupo"}
              </span>
            </label>
          );
        })}
        {options.length === 0 ? <p className="muted">No hay otras cohortes de este programa.</p> : null}
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span>Nota (opcional)</span>
        <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="p. ej. cambio de sede solicitado por el médico" />
        <span className="help">El cupo anterior se libera y se toma uno en la cohorte nueva en la misma operación. Si el pedido está inscrito, se envían los datos de la nueva cohorte al médico.</span>
      </label>
    </Shell>
  );
}

export function AdjustModal({ o, busy, onClose, onSubmit }: { o: O; busy: boolean; onClose: () => void; onSubmit: (kind: "discount" | "charge", amount: string, reason: string) => void }) {
  const [kind, setKind] = useState<"discount" | "charge">("discount");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const cents = parseMoney(amount) ?? NaN;
  const valid = Number.isFinite(cents) && cents > 0 && (kind === "charge" || cents <= Math.max(0, o.balanceCents));
  const after = Math.max(0, o.balanceCents) + (valid ? (kind === "discount" ? -cents : cents) : 0);
  return (
    <Shell
      title="Ajustar saldo"
      onClose={onClose}
      onSubmit={() => valid && reason.trim() && onSubmit(kind, amount, reason)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !valid || !reason.trim()}>
            {busy ? <Spinner /> : null}
            Guardar ajuste
          </button>
        </>
      }
    >
      <div className="seg" role="radiogroup" aria-label="Tipo de ajuste">
        <button type="button" role="radio" aria-checked={kind === "discount"} className={kind === "discount" ? "on" : ""} onClick={() => setKind("discount")}>
          Condonar / descontar
        </button>
        <button type="button" role="radio" aria-checked={kind === "charge"} className={kind === "charge" ? "on" : ""} onClick={() => setKind("charge")}>
          Cargo adicional
        </button>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Monto</span>
          <span className="inp-affix">
            <span className="pre">$</span>
            <input className="inp has-pre num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" autoFocus />
            <span className="suf">USD</span>
          </span>
        </label>
        <div className="field">
          <span>Saldo pendiente</span>
          <div style={{ lineHeight: "32px" }} className="mono">
            {usd(Math.max(0, o.balanceCents))} <Icon name="next" size={14} /> <b>{usd(after)}</b>
          </div>
        </div>
      </div>
      <label className="field">
        <span>Motivo</span>
        <input className="inp" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === "discount" ? "p. ej. beca parcial aprobada por la dirección" : "p. ej. diferencia cambiaria"} />
        <span className="help">
          {kind === "discount"
            ? "Se descuenta de las cuotas pendientes en orden. Si cubre el primer pago, el cupo se confirma y se matricula."
            : "Se agrega como una cuota nueva al final del calendario."}
        </span>
      </label>
    </Shell>
  );
}

export function EmailPreview({ orderId, email, onClose, onResend, busy, canResend }: { orderId: string; email: { id: string; subject: string; to: string; template: string }; onClose: () => void; onResend: () => void; busy: boolean; canResend: boolean }) {
  return (
    <Shell
      title={email.subject}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <span className="small muted" style={{ marginRight: "auto" }}>Para: {email.to}</span>
          <button type="button" className="btn" onClick={onClose}>Cerrar</button>
          {canResend ? (
            <button type="button" className="btn btn-primary" onClick={onResend} disabled={busy}>
              {busy ? <Spinner /> : null}
              Reenviar correo
            </button>
          ) : null}
        </>
      }
    >
      <iframe className="mail-frame" title={`Vista previa: ${email.subject}`} src={`/admin/orders/${orderId}/correo/${email.id}`} sandbox="" />
    </Shell>
  );
}
