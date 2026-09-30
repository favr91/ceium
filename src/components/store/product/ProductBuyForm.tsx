"use client";
// Formulario de compra de la ficha de producto: las mismas opciones que ceium.net (Modalidad, Sede, Forma de
// pago; «Cursos disponibles» en los talleres por niveles) más la COHORTE en semipresencial, con fechas y cupos
// en vivo; las cohortes llenas o cerradas se ven pero no se pueden elegir. El precio (lo que se paga hoy) se
// recalcula al instante con la misma regla que el carrito y el checkout (computePlanAmounts), y «Agregar al
// carrito» valida en el servidor (addToCartForm) y lleva a /cart, como la tienda original. Sin JavaScript el
// formulario también funciona: los radios son campos reales.
import { useActionState, useId, useMemo, useState } from "react";
import { addToCartForm, type CartActionResult } from "@/app/(store)/cart/actions";
import { computePlanAmounts, formatUSD } from "@/server/pricing";
import type { BuyCohort, BuyConfig, BuyPlan, BuyPrice } from "./product-data";

type Modality = BuyConfig["modalities"][number];

const MODALITY_LABEL: Record<Modality, string> = { SEMIPRESENCIAL: "Semipresencial", ONLINE: "Online" };

function findPrice(prices: BuyPrice[], modality: Modality | null, sedeId: string | null, choiceId: string | null): BuyPrice | null {
  if (!modality) return null;
  return prices.find((p) => p.modality === modality && (modality === "ONLINE" || p.sedeId === sedeId) && (p.choiceId ?? null) === (choiceId ?? null)) ?? null;
}

function amountsFor(price: BuyPrice | null, plan: BuyPlan | null) {
  if (!price) return null;
  if (!plan) return computePlanAmounts(price, { kind: "FULL", discountPct: 0, installments: 1 });
  return computePlanAmounts(price, { kind: plan.kind, discountPct: plan.discountPct, installments: plan.installments });
}

const purchasable = (c: BuyCohort) => c.phase === "OPEN";

function seatsText(c: BuyCohort): string {
  if (c.phase === "SOLD_OUT") return "Agotado";
  if (c.phase === "CLOSED") return "Inscripciones cerradas";
  if (c.available === 1) return "¡Último cupo!";
  if (c.available <= 5) return `¡Quedan ${c.available} cupos!`;
  return `${c.available} cupos disponibles`;
}

function firstCohort(cohorts: BuyCohort[], sedeId: string | null): string | null {
  return cohorts.find((c) => c.sedeId === sedeId && purchasable(c))?.id ?? null;
}

export function ProductBuyForm({ config, title }: { config: BuyConfig; title: string }) {
  const uid = useId();
  const { prices, plans, cohorts, sedes, modalities, choices } = config;

  // Selección inicial como la de ceium.net (primera de cada opción), pero sin caer en una sede sin cupos.
  const initialSede = sedes.find((s) => cohorts.some((c) => c.sedeId === s.id && purchasable(c)))?.id ?? sedes[0]?.id ?? null;
  const [choiceId, setChoiceId] = useState<string | null>(choices[0]?.id ?? null);
  const [modality, setModality] = useState<Modality | null>(modalities[0] ?? null);
  const [sedeId, setSedeId] = useState<string | null>(initialSede);
  const [cohortId, setCohortId] = useState<string | null>(firstCohort(cohorts, initialSede));
  const [planKind, setPlanKind] = useState<BuyPlan["kind"] | null>(plans[0]?.kind ?? null);
  const [state, formAction, pending] = useActionState<CartActionResult | null, FormData>(addToCartForm, null);

  const semi = modality === "SEMIPRESENCIAL";
  const plan = plans.find((p) => p.kind === planKind) ?? null;
  const price = findPrice(prices, modality, semi ? sedeId : null, choiceId);
  const amounts = useMemo(() => amountsFor(price, plan), [price, plan]);
  const sedeCohorts = semi ? cohorts.filter((c) => c.sedeId === sedeId) : [];
  const cohort = sedeCohorts.find((c) => c.id === cohortId) ?? null;

  const pickSede = (id: string) => {
    setSedeId(id);
    setCohortId(firstCohort(cohorts, id));
  };
  const pickModality = (m: Modality) => {
    setModality(m);
    if (m === "SEMIPRESENCIAL" && !cohortId) setCohortId(firstCohort(cohorts, sedeId));
  };

  // ¿Se puede comprar la combinación elegida? (el servidor lo vuelve a validar)
  let blocker: string | null = null;
  if (!config.open) blocker = "Inscripciones cerradas";
  else if (!modality || !plan) blocker = "No disponible";
  else if (!price) blocker = "No disponible";
  else if (semi && (!cohort || !purchasable(cohort))) blocker = "Agotado";

  const sedeName = sedes.find((s) => s.id === sedeId)?.name ?? "";
  const noSeatsInSede = semi && sedeCohorts.length > 0 && !sedeCohorts.some(purchasable);
  const otherSedes = semi ? sedes.filter((s) => s.id !== sedeId && cohorts.some((c) => c.sedeId === s.id && purchasable(c))).map((s) => s.name) : [];

  let summary: string | null = null;
  if (amounts && plan && !blocker) {
    const total = formatUSD(amounts.totalCents);
    if (plan.kind === "MONTHLY") {
      summary = `Hoy pagas el 1.er curso. Luego pagas un curso por mes: ${amounts.schedule.length} cuotas de ${formatUSD(amounts.dueNowCents)} (total ${total}).`;
    } else if (plan.kind === "HALF") {
      const rest = formatUSD(amounts.totalCents - amounts.dueNowCents);
      summary = `Hoy pagas la mitad; el resto (${rest}) en un segundo pago. Total ${total}${amounts.discountCents > 0 ? `, ahorras ${formatUSD(amounts.discountCents)}` : ""}.`;
    } else if (amounts.discountCents > 0) {
      summary = `Pago único. Ahorras ${formatUSD(amounts.discountCents)} (${plan.discountPct} % de descuento sobre ${formatUSD(amounts.listCents)}).`;
    }
  }

  const priceText = amounts ? formatUSD(amounts.dueNowCents) : "—";
  const buttonLabel = pending ? "Agregando…" : blocker ?? "Agregar al carrito";

  return (
    <form action={formAction} className="pp-form" aria-label={`Opciones de compra: ${title}`} data-testid="buy-form">
      <input type="hidden" name="productId" value={config.productId} />
      <input type="hidden" name="redirectTo" value="cart" />
      <h2 className="pp-form__title">Selecciona las opciones:</h2>

      {choices.length > 0 ? (
        <fieldset className="pp-opt">
          <legend className="pp-opt__label">{config.choiceGroup ?? "Opciones"}</legend>
          <div className="pp-opt__values pp-opt__values--stack">
            {choices.map((c) => (
              <label key={c.id} className="pp-radio">
                <input type="radio" name="choiceId" value={c.id} checked={choiceId === c.id} onChange={() => setChoiceId(c.id)} />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {modalities.length > 0 ? (
        <fieldset className="pp-opt">
          <legend className="pp-opt__label">Modalidad</legend>
          <div className="pp-opt__values">
            {modalities.map((m) => (
              <label key={m} className="pp-radio">
                <input type="radio" name="modality" value={m} checked={modality === m} onChange={() => pickModality(m)} />
                <span>{MODALITY_LABEL[m]}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {semi && sedes.length > 0 ? (
        <fieldset className="pp-opt">
          <legend className="pp-opt__label">Sede</legend>
          <div className="pp-opt__values">
            {sedes.map((s) => {
              const full = !cohorts.some((c) => c.sedeId === s.id && purchasable(c));
              return (
                <label key={s.id} className={`pp-radio${full ? " pp-radio--muted" : ""}`}>
                  <input type="radio" name="sedeId" value={s.id} checked={sedeId === s.id} onChange={() => pickSede(s.id)} />
                  <span>
                    {s.name}
                    {full ? <span className="pp-radio__tag"> · sin cupos</span> : null}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {semi && sedeId ? (
        <fieldset className="pp-opt pp-opt--cohorts" aria-describedby={`${uid}-cohort-help`}>
          <legend className="pp-opt__label">Cohorte</legend>
          <p id={`${uid}-cohort-help`} className="pp-opt__help">
            {sedeCohorts.length === 0
              ? `Aún no hay fechas publicadas en ${sedeName}.`
              : noSeatsInSede
                ? `No quedan cupos en ${sedeName}.`
                : `Fechas en ${sedeName}. Tu cupo se reserva al pagar.`}
            {(sedeCohorts.length === 0 || noSeatsInSede) && otherSedes.length > 0 ? ` Hay cupos en ${otherSedes.join(" y ")}.` : ""}
            {(sedeCohorts.length === 0 || noSeatsInSede) && modalities.includes("ONLINE") ? " También puedes inscribirte online." : ""}
          </p>
          {sedeCohorts.length > 0 ? (
            <div className="pp-cohorts">
              {sedeCohorts.map((c) => {
                const ok = purchasable(c);
                const low = ok && c.available <= 5;
                return (
                  <label key={c.id} className={`pp-cohort${ok ? "" : " is-disabled"}${cohortId === c.id ? " is-selected" : ""}`} data-cohort={c.name} data-phase={c.phase}>
                    <input type="radio" name="cohortId" value={c.id} checked={cohortId === c.id} disabled={!ok} onChange={() => setCohortId(c.id)} aria-describedby={`${uid}-${c.id}-seats`} />
                    <span className="pp-cohort__body">
                      <span className="pp-cohort__name">{c.name}</span>
                      <span className="pp-cohort__dates" title={`Inicio: ${c.startLong}`}>
                        {c.dates}
                        {c.deadline && ok ? <span className="pp-cohort__deadline">{c.deadline}</span> : null}
                      </span>
                    </span>
                    <span id={`${uid}-${c.id}-seats`} className={`pp-cohort__seats${low ? " is-low" : ""}${ok ? "" : " is-out"}`}>
                      {seatsText(c)}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {plans.length > 0 ? (
        <fieldset className="pp-opt">
          <legend className="pp-opt__label">Forma de pago</legend>
          <div className="pp-opt__values">
            {plans.map((p) => (
              <label key={p.kind} className="pp-radio">
                <input type="radio" name="planKind" value={p.kind} checked={planKind === p.kind} onChange={() => setPlanKind(p.kind)} />
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <input type="hidden" name="planKind" value="FULL" />
      )}

      <div className="pp-buy">
        <button type="submit" className="pp-btn" disabled={!!blocker || pending} aria-busy={pending || undefined}>
          {pending ? <span className="pp-spinner" aria-hidden="true" /> : null}
          <span>{buttonLabel}</span>
        </button>
        <div className="pp-price" data-testid="price" aria-live="polite" aria-atomic="true">
          {priceText}
        </div>
      </div>
      {summary ? (
        <p className="pp-summary" data-testid="price-summary">
          {summary}
        </p>
      ) : null}
      {state && !state.ok ? (
        <p className="pp-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
