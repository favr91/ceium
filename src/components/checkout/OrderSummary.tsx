// Resumen del pedido del checkout (columna gris en escritorio, desplegable en móvil), como el de Shopify:
// miniatura con la cantidad, título, variante y precio; luego subtotal, descuento del plan y total.
// Presentacional (sin estado): el servidor le pasa las líneas ya cotizadas desde la BD.
import type { CheckoutLineView } from "@/app/(checkout)/checkout/data";

export function usd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface SummaryTotals {
  count: number;
  listCents: number;
  discountCents: number;
  totalCents: number;
  dueNowCents: number;
}

function seatsLabel(n: number): string {
  if (n <= 0) return "Sin cupos";
  return n === 1 ? "Queda 1 cupo" : `Quedan ${n} cupos`;
}

export function SummaryLines({ lines }: { lines: CheckoutLineView[] }) {
  return (
    <ul className="co-lines" aria-label="Programas">
      {lines.map((l) => (
        <li key={l.key} className="co-line" data-testid="summary-line" data-error={l.error ? "true" : undefined}>
          <div className="co-thumb">
            {l.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- imagen del CDN del catálogo, miniatura de 64 px
              <img src={l.imageUrl} alt={l.imageAlt} width={64} height={64} loading="eager" />
            ) : (
              <span className="co-thumb-empty" aria-hidden="true" />
            )}
            <span className="co-qty" aria-label="Cantidad: 1">1</span>
          </div>
          <div className="co-line-body">
            <p className="co-line-title">{l.title}</p>
            {l.variant ? <p className="co-line-variant">{l.variant}</p> : null}
            {l.cohort ? (
              <p className="co-line-cohort" data-testid="summary-cohort">
                {l.cohort.name} · {l.cohort.startLabel} – {l.cohort.endLabel}
                <span className="co-seats" data-low={l.cohort.available <= 5 || undefined}>
                  {seatsLabel(l.cohort.available)}
                </span>
              </p>
            ) : null}
            {l.planNote ? <p className="co-line-note">{l.planNote}</p> : null}
            {l.error ? (
              <p className="co-line-error" role="alert">
                {l.error}
              </p>
            ) : null}
          </div>
          <p className="co-line-price">
            {l.discountCents > 0 && l.dueNowCents === l.totalCents ? <s className="co-compare">{usd(l.listCents)}</s> : null}
            <span>{usd(l.dueNowCents)}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function SummaryTotalsBlock({ t }: { t: SummaryTotals }) {
  const split = t.dueNowCents < t.totalCents;
  return (
    <div className="co-costs" data-testid="summary-costs">
      <div className="co-cost-row">
        <span>Subtotal · {t.count === 1 ? "1 programa" : `${t.count} programas`}</span>
        <span>{usd(t.listCents)}</span>
      </div>
      {t.discountCents > 0 ? (
        <div className="co-cost-row co-cost-discount">
          <span>Descuento por forma de pago</span>
          <span>−{usd(t.discountCents)}</span>
        </div>
      ) : null}
      {split ? (
        <>
          <div className="co-cost-row">
            <span>Total de los programas</span>
            <span>{usd(t.totalCents)}</span>
          </div>
          <div className="co-cost-row co-cost-muted">
            <span>Saldo que pagas después</span>
            <span>{usd(t.totalCents - t.dueNowCents)}</span>
          </div>
        </>
      ) : null}
      <div className="co-cost-total">
        <strong>{split ? "A pagar hoy" : "Total"}</strong>
        <span className="co-total-amount">
          <span className="co-currency">USD</span>
          <strong data-testid="summary-total">{usd(t.dueNowCents)}</strong>
        </span>
      </div>
    </div>
  );
}

/** Qué pasa después de pagar (confianza para el médico). */
export function NextSteps({ semipresencial }: { semipresencial: boolean }) {
  return (
    <div className="co-next" aria-labelledby="co-next-title">
      <h2 id="co-next-title" className="co-next-title">
        Después de pagar
      </h2>
      <ol>
        <li>Recibes la confirmación y tu acceso al aula virtual (Moodle) en tu correo.</li>
        {semipresencial ? <li>Te enviamos la sede, las fechas y el horario de tu cohorte.</li> : <li>Empiezas a estudiar a tu ritmo desde el aula virtual.</li>}
        <li>Al completar el programa, recibes tu certificado con código de verificación.</li>
      </ol>
    </div>
  );
}
