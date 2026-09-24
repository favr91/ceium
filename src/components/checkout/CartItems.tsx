"use client";
// Líneas del carrito (tabla Dawn) con cantidad y eliminar. Las mutaciones van por server actions; la página se
// vuelve a renderizar con los datos frescos de la BD (refresh()).
import { useRef, useState, useTransition } from "react";
import type { ResolvedCartLine } from "@/server/cart";
import type { CartActionResult } from "@/app/(store)/cart/actions";
import { ErrorIcon, MinusIcon, PlusIcon, RemoveIcon } from "./icons";

type Mutate = (key: string, quantity: number) => Promise<CartActionResult>;

/** Evento que escucha el header de la tienda para actualizar la burbuja del carrito sin recargar. */
const CART_COUNT_EVENT = "ceium:cart-count";

function usd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function imageSrc(url: string): string {
  // CDN de Shopify: pide una miniatura de 300 px (como el tema original).
  if (/cdn\.shopify\.com|\/cdn\/shop\//.test(url) && !/[?&]width=/.test(url)) return url + (url.includes("?") ? "&" : "?") + "width=300";
  return url;
}

/**
 * Opciones de la línea para mostrar: «Sede» sobra en Online, la cohorte se parte en nombre + inicio y la forma de
 * pago no repite el «(10% de descuento)» porque el ahorro se muestra con su monto justo debajo.
 */
function displayOptions(line: ResolvedCartLine): { name: string; value: string }[] {
  const online = line.options.some((o) => o.name === "Modalidad" && o.value === "Online");
  const out: { name: string; value: string }[] = [];
  for (const o of line.options) {
    if (o.name === "Sede" && online) continue;
    if (o.name === "Cohorte") {
      const [name, start] = o.value.split(" · inicia el ");
      out.push({ name: "Cohorte", value: name });
      if (start) out.push({ name: "Inicio", value: start });
      continue;
    }
    if (o.name === "Forma de pago" && line.discountCents > 0 && !line.error) {
      out.push({ name: o.name, value: o.value.replace(/\s*\([^)]*descuento[^)]*\)\s*$/i, "") || o.value });
      continue;
    }
    out.push(o);
  }
  return out;
}

function TagIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" width="14" height="14">
      <path d="M8.6 1.5H14.5V7.4L7.9 14 2 8.1 8.6 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="11.4" cy="4.6" r="1.1" fill="currentColor" />
    </svg>
  );
}

export function CartItems({ lines, updateQuantity }: { lines: ResolvedCartLine[]; updateQuantity: Mutate }) {
  const [status, setStatus] = useState("");
  return (
    <div className="ck-items" id="main-cart-items">
      <table className="ck-table">
        <caption className="ck-visually-hidden">Tu carrito</caption>
        <thead className="ck-thead">
          <tr className="ck-head">
            <th scope="col">Producto</th>
            <th scope="col" className="ck-right ck-head-total-narrow">Total</th>
            <th scope="col" className="ck-head-qty">Cantidad</th>
            <th scope="col" className="ck-right ck-head-total-wide">Total</th>
          </tr>
        </thead>
        <tbody className="ck-tbody">
          {lines.map((l, i) => (
            <CartRow key={l.key} line={l} index={i + 1} updateQuantity={updateQuantity} onStatus={setStatus} />
          ))}
        </tbody>
      </table>
      <p className="ck-visually-hidden" aria-live="polite" role="status">{status}</p>
    </div>
  );
}

function CartRow({ line, index, updateQuantity, onStatus }: { line: ResolvedCartLine; index: number; updateQuantity: Mutate; onStatus: (s: string) => void }) {
  const [pending, startTransition] = useTransition();
  const [qty, setQty] = useState(String(line.quantity));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (quantity: number) => {
    setError(null);
    startTransition(async () => {
      onStatus("Cargando…");
      const res = await updateQuantity(line.key, quantity);
      if (!res.ok) {
        setError(res.error);
        setQty(String(line.quantity));
        onStatus(res.error);
      } else {
        window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: { count: res.count } }));
        onStatus(quantity === 0 ? `${line.title} se eliminó del carrito.` : "Carrito actualizado.");
      }
    });
  };

  const onInputCommit = () => {
    const n = Number(qty);
    if (qty.trim() === "" || !Number.isInteger(n) || n < 0) {
      setQty(String(line.quantity));
      return;
    }
    if (n !== line.quantity) commit(n);
  };

  const price = line.error ? "—" : usd(line.priceCents);
  const errorText = error ?? line.error;
  const optionLabel = line.options.map((o) => o.value).join(" / ");

  return (
    <tr className="ck-row" id={`CartItem-${index}`} data-busy={pending ? "true" : undefined} data-testid="cart-line" data-key={line.key}>
      <td className="ck-media">
        <a href={line.href} className="ck-media-link" aria-hidden="true" tabIndex={-1}> </a>
        <div className="ck-img-wrap">
          {line.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- CDN externo (Shopify) o /uploads; miniatura fija
            <img src={imageSrc(line.imageUrl)} className="ck-img" alt={line.imageAlt} loading="lazy" width={150} height={85} />
          ) : (
            <span className="ck-img ck-img--empty" />
          )}
        </div>
      </td>
      <td className="ck-details">
        <div className="ck-name-row">
          <a href={line.href} className="ck-name">{line.title}</a>
          <span className="ck-price ck-price--inline" aria-hidden="true">{price}</span>
        </div>
        <div className="ck-unit" data-testid="cart-unit-price">
          {line.discountCents > 0 && !line.error ? (
            <>
              <span className="ck-visually-hidden">Precio habitual</span>
              <s className="ck-unit-list">{usd(line.listCents)}</s>
              <span className="ck-visually-hidden">Precio con descuento</span>
            </>
          ) : null}
          <span className="ck-unit-now">{line.error ? "—" : usd(line.programTotalCents)}</span>
          {!line.error && line.programTotalCents > line.priceCents ? <span className="ck-unit-hint">total del programa</span> : null}
        </div>
        <dl className="ck-options">
          {displayOptions(line).map((o) => (
            <div className="ck-option" key={o.name}>
              <dt>{o.name}</dt>
              <dd>{o.value}</dd>
            </div>
          ))}
        </dl>
        {line.discountCents > 0 && !line.error ? (
          <p className="ck-save" data-testid="cart-line-discount">
            <TagIcon />
            <span>Ahorras <strong>{usd(line.discountCents)}</strong> (−{line.discountPct}%)</span>
          </p>
        ) : null}
        {line.planNote ? <p className="ck-plan-note">{line.planNote}</p> : null}
        {line.seatNote ? <p className="ck-seat-note">{line.seatNote}</p> : null}
      </td>
      <td className="ck-total-cell ck-total-cell--narrow">
        <span className="ck-price">{price}</span>
      </td>
      <td className="ck-qty-cell">
        <div className="ck-qty-wrap">
          <label className="ck-visually-hidden" htmlFor={`Quantity-${index}`}>Cantidad</label>
          <div className="ck-qty">
            <button className="ck-qty-btn" type="button" name="minus" onClick={() => commit(line.quantity - 1)} disabled={pending}>
              <span className="ck-visually-hidden">Reducir cantidad para {line.title}</span>
              <MinusIcon />
            </button>
            <input
              ref={inputRef}
              className="ck-qty-input"
              type="number"
              inputMode="numeric"
              name="updates[]"
              id={`Quantity-${index}`}
              min={0}
              max={1}
              step={1}
              value={qty}
              aria-label={`Cantidad para ${line.title}`}
              onChange={(e) => setQty(e.target.value)}
              onBlur={onInputCommit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  inputRef.current?.blur();
                }
              }}
            />
            <button className="ck-qty-btn" type="button" name="plus" onClick={() => commit(line.quantity + 1)} disabled={pending}>
              <span className="ck-visually-hidden">Aumentar cantidad para {line.title}</span>
              <PlusIcon />
            </button>
          </div>
          <button type="button" className="ck-remove" aria-label={`Eliminar ${line.title} - ${optionLabel}`} onClick={() => commit(0)} disabled={pending} data-testid="cart-remove">
            <RemoveIcon />
          </button>
        </div>
        <div className="ck-line-error" id={`Line-item-error-${index}`} role="alert">
          {errorText ? (
            <>
              <ErrorIcon />
              <small>{errorText}</small>
            </>
          ) : null}
        </div>
      </td>
      <td className="ck-total-cell ck-total-cell--wide">
        <span className="ck-price">{price}</span>
      </td>
    </tr>
  );
}
