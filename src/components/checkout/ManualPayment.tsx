"use client";
// Piezas del pago manual (pago móvil, transferencia, Zelle) en el checkout, dentro del panel gris del método
// seleccionado (como el acordeón de Shopify de ceium.net):
//   - ManualAmount: cuánto pagar en la moneda del método (Bs. a la tasa fijada en el panel) y su equivalente en USD;
//   - PayeeDetails: los datos de CEIUM para pagar, cada uno con «Copiar» y un «Copiar todo» para pegarlos en el banco;
//   - ManualFields: referencia, banco de origen, monto, fecha y comprobante (arrastrar o elegir, con vista previa).
import { useEffect, useRef, useState } from "react";
import type { MethodView } from "@/app/(checkout)/checkout/data";
import { CheckIcon, ChevronDownIcon, CopyIcon, FieldErrorIcon } from "./icons";
import { usd } from "./OrderSummary";
import { formatAmount, parseAmountCents, plainAmount, PROOF_ACCEPT, VE_BANKS, type ManualErrors, type ManualField, type ManualValues } from "./manual-payment-fields";

/** Lo que se paga con el método, en su moneda (céntimos). */
export function methodAmountCents(m: MethodView, dueNowCents: number): number {
  return m.currency === "VES" && m.vesPerUsd ? Math.round(dueNowCents * m.vesPerUsd) : dueNowCents;
}

export function methodAmountLabel(m: MethodView, dueNowCents: number): string {
  return m.currency === "VES" && m.vesPerUsd ? `Bs. ${formatAmount(methodAmountCents(m, dueNowCents))}` : usd(dueNowCents);
}

export function CopyButton({ value, label, text, className }: { value: string; label: string; text?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`co-copy${className ? ` ${className}` : ""}`}
      data-done={done || undefined}
      aria-label={done ? `${label} copiado` : `Copiar ${label.toLowerCase()}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Sin permiso de portapapeles (http, navegador antiguo): copia con una selección temporal.
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand?.("copy");
          ta.remove();
          if (!ok) return;
        }
        setDone(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setDone(false), 1800);
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      <span aria-hidden="true">{done ? "Copiado" : text ?? "Copiar"}</span>
    </button>
  );
}

/** Monto a pagar: en bolívares a la tasa del panel (con su equivalente en USD) o en dólares. */
export function ManualAmount({ m, dueNowCents, copy = false }: { m: MethodView; dueNowCents: number; copy?: boolean }) {
  const ves = m.currency === "VES" && m.vesPerUsd;
  const cents = methodAmountCents(m, dueNowCents);
  return (
    <div className="co-due" data-testid="method-due">
      <div className="co-due-main">
        <div>
          <p className="co-due-label">Monto a pagar</p>
          <p className="co-due-value" data-testid="method-amount">
            {methodAmountLabel(m, dueNowCents)}
          </p>
        </div>
        {copy ? <CopyButton value={plainAmount(cents)} label="Monto" /> : null}
      </div>
      <dl className="co-due-rows">
        {ves ? (
          <>
            <div>
              <dt>Equivale a</dt>
              <dd data-testid="method-usd">{usd(dueNowCents)} USD</dd>
            </div>
            <div>
              <dt>Tasa{m.rateLabel ? ` ${m.rateLabel}` : " del día"}</dt>
              <dd data-testid="method-rate">Bs. {m.vesPerUsd!.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} por USD</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Moneda</dt>
            <dd>Dólares (USD)</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Datos de CEIUM para pagar, con «Copiar» por dato y «Copiar todo». */
export function PayeeDetails({ m, amountLabel }: { m: MethodView; amountLabel: string }) {
  if (!m.details?.length) return null;
  const all = [...m.details.map((d) => `${d.label}: ${d.value}`), `Monto: ${amountLabel}`].join("\n");
  return (
    <section className="co-payee" aria-label={`Datos de ${m.label} de CEIUM`}>
      <header className="co-payee-head">
        <p className="co-payee-title">Datos de {m.label} de CEIUM</p>
        <CopyButton value={all} label="Todos los datos" text="Copiar todo" className="co-copy-all" />
      </header>
      <dl className="co-bank" data-testid="method-details">
        {m.details.map((d) => (
          <div key={d.label}>
            <dt>{d.label}</dt>
            <dd>
              <span>{d.value}</span>
              <CopyButton value={d.value} label={d.label} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ───────────── registro del pago ─────────────

function UploadIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" {...p}>
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M12 15.5V4.5m0 0-4 4m4-4 4 4" />
      <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

function DocIcon(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" {...p}>
      <path stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" d="M13.5 3.5v4h4" />
    </svg>
  );
}

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("es-VE", { maximumFractionDigits: 1 })} MB`;
}

function ErrorText({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <p className="co-error" id={id}>
      <FieldErrorIcon />
      {children}
    </p>
  );
}

/** Miniatura local del comprobante (imagen) o ícono de documento (PDF). */
function ProofThumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="co-drop-thumb" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- vista previa local (blob:) del comprobante */}
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : <DocIcon />}
    </span>
  );
}

function ProofDrop({ file, onFile, error, native }: { file: File | null; onFile: (f: File | null) => void; error?: string; native: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  // Vista previa local (blob:) creada al elegir el archivo; se libera al cambiarlo o quitarlo.
  const [preview, setPreview] = useState<{ file: File; url: string | null } | null>(null);
  const previewUrl = preview && preview.file === file ? preview.url : null;
  const setPreviewFor = (f: File | null) => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    const isImage = !!f && /^image\//.test(f.type) && !/hei[cf]/i.test(f.type);
    setPreview(f ? { file: f, url: isImage ? URL.createObjectURL(f) : null } : null);
  };

  const pick = (list: FileList | null) => {
    const f = list?.[0] ?? null;
    if (!f) return;
    setPreviewFor(f);
    // Mantiene el archivo también en el <input> (envío sin JavaScript y arrastrar-soltar).
    if (inputRef.current && inputRef.current.files !== list) {
      try {
        const dt = new DataTransfer();
        dt.items.add(f);
        inputRef.current.files = dt.files;
      } catch {
        /* navegador sin DataTransfer: basta con el estado */
      }
    }
    onFile(f);
  };
  const clear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setPreviewFor(null);
    onFile(null);
    inputRef.current?.focus();
  };

  return (
    <div className="co-cell">
      <div
        className="co-drop"
        data-file={file ? "true" : undefined}
        data-drag={drag || undefined}
        data-invalid={error ? "true" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          id="co-proof"
          className="co-drop-input"
          type="file"
          name={native ? "proof" : undefined}
          accept={PROOF_ACCEPT}
          aria-label="Comprobante de pago"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "co-proof-error" : "co-proof-hint"}
          onChange={(e) => pick(e.target.files)}
        />
        {file ? (
          <div className="co-drop-file" data-testid="proof-file">
            <ProofThumb key={previewUrl ?? file.name} url={previewUrl} />
            <span className="co-drop-info">
              <span className="co-drop-name">{file.name}</span>
              <span className="co-drop-meta">
                <CheckIcon /> {fileSize(file.size)} · listo para enviar
              </span>
            </span>
            <span className="co-drop-actions">
              <label htmlFor="co-proof" className="co-link-btn">
                Cambiar
              </label>
              <button type="button" className="co-link-btn" onClick={clear} aria-label="Quitar el comprobante">
                Quitar
              </button>
            </span>
          </div>
        ) : (
          <label htmlFor="co-proof" className="co-drop-zone">
            <span className="co-drop-icon" aria-hidden="true">
              <UploadIcon />
            </span>
            <span className="co-drop-title">Sube el comprobante</span>
            <span className="co-drop-hint" id="co-proof-hint">
              <span className="co-drop-desk">Arrastra aquí la captura o el PDF, o </span>
              <span className="co-drop-cta">elige un archivo</span>
              <span className="co-drop-limit"> · JPG, PNG o PDF, máx. 10 MB</span>
            </span>
          </label>
        )}
      </div>
      <ErrorText id="co-proof-error">{error}</ErrorText>
    </div>
  );
}

export interface ManualFieldsProps {
  m: MethodView;
  dueNowCents: number;
  today: string;
  values: ManualValues;
  errors: ManualErrors;
  onChange: (name: Exclude<ManualField, "proof">, value: string) => void;
  file: File | null;
  onFile: (f: File | null) => void;
  /** Nombres en los campos para el envío sin JavaScript (formulario que publica a /api/checkout/comprobante). */
  native?: boolean;
}

/** Referencia, banco de origen, monto, fecha y comprobante. */
export function ManualFields({ m, dueNowCents, today, values, errors, onChange, file, onFile, native = true }: ManualFieldsProps) {
  const ves = m.currency === "VES";
  const due = methodAmountCents(m, dueNowCents);
  const paid = parseAmountCents(values.amount);
  const short = Number.isFinite(paid) && paid > 0 && paid < due && !errors.amount;
  const n = (name: string) => (native ? name : undefined);
  const field = (name: Exclude<ManualField, "proof">) => ({
    id: `co-${name}`,
    name: n(name),
    value: values[name],
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? `co-${name}-error` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(name, e.target.value),
  });

  return (
    <section className="co-report" aria-labelledby="co-report-title" data-testid="manual-form">
      <h3 id="co-report-title" className="co-report-title">
        Registra tu pago
      </h3>
      <p className="co-report-sub">Cuando hayas pagado, completa estos datos tal como aparecen en tu comprobante.</p>
      <div className="co-grid">
        <div className="co-cell co-half">
          <div className="co-field" data-invalid={errors.reference ? "true" : undefined}>
            <input {...field("reference")} placeholder=" " inputMode={ves ? "numeric" : "text"} autoComplete="off" aria-required />
            <label htmlFor="co-reference">{ves ? "Número de referencia" : "Número de confirmación"}</label>
          </div>
          <ErrorText id="co-reference-error">{errors.reference}</ErrorText>
        </div>
        <div className="co-cell co-half">
          {ves ? (
            <div className="co-field co-select" data-invalid={errors.bank ? "true" : undefined} data-empty={values.bank ? undefined : "true"}>
              <select {...field("bank")} aria-required>
                <option value="" disabled>
                  Selecciona tu banco
                </option>
                {VE_BANKS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <label htmlFor="co-bank">Banco de origen</label>
              <ChevronDownIcon className="co-chevron" />
            </div>
          ) : (
            <div className="co-field" data-invalid={errors.bank ? "true" : undefined}>
              <input {...field("bank")} placeholder=" " autoComplete="off" />
              <label htmlFor="co-bank">Banco o titular (opcional)</label>
            </div>
          )}
          <ErrorText id="co-bank-error">{errors.bank}</ErrorText>
        </div>
        <div className="co-cell co-half">
          <div className="co-field co-field-suffix" data-invalid={errors.amount ? "true" : undefined}>
            <input {...field("amount")} placeholder=" " inputMode="decimal" autoComplete="off" aria-required />
            <label htmlFor="co-amount">Monto pagado ({ves ? "Bs." : "USD"})</label>
            <span className="co-suffix" aria-hidden="true">
              {ves ? "Bs." : "USD"}
            </span>
          </div>
          <ErrorText id="co-amount-error">{errors.amount}</ErrorText>
          {short ? (
            <p className="co-field-note" data-testid="amount-short">
              Es menos que el monto a pagar ({methodAmountLabel(m, dueNowCents)}). Si pagaste de menos, tu inscripción quedará pendiente del resto.
            </p>
          ) : null}
        </div>
        <div className="co-cell co-half">
          <div className="co-field" data-invalid={errors.paidAt ? "true" : undefined}>
            <input {...field("paidAt")} type="date" max={today} aria-required />
            <label htmlFor="co-paidAt">Fecha del pago</label>
          </div>
          <ErrorText id="co-paidAt-error">{errors.paidAt}</ErrorText>
        </div>
        <ProofDrop file={file} onFile={onFile} error={errors.proof} native={native} />
      </div>
    </section>
  );
}
