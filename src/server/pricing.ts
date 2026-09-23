// Cálculo de montos por plan de pago. Toda cifra en centavos enteros (USD).
// Reglas (SPEC.md "Planes de pago", variantes reales de ceium.net):
//   FULL:    total = price·(1−d)                   dueNow = total
//   HALF:    total = price·(1−d)                   dueNow = ⌈total/2⌉, resto = 1 cuota
//   MONTHLY: (solo diplomados) N = nº de cursos del diplomado, cada cuota = installmentCents (el precio
//            publicado de la variante "Paga mes a mes": 180/230/150), total = N·cuota, sin tope al precio
//            de lista. listCents = total (el plan no tiene descuento). Sin installmentCents configurado:
//            price/N redondeado y la última cuota absorbe el residuo.
export type PlanKindLike = "FULL" | "HALF" | "MONTHLY";

export interface PlanInput {
  kind: PlanKindLike;
  discountPct: number;
  installments: number;
}

export interface PriceInput {
  priceCents: number;
  installmentCents?: number | null;
}

export interface PlanAmounts {
  listCents: number;
  discountCents: number;
  totalCents: number;
  dueNowCents: number;
  /** Montos de cada cuota (incluye la primera = dueNow). Suma = totalCents. MONTHLY: una por curso. */
  schedule: number[];
}

export function computePlanAmounts(price: PriceInput, plan: PlanInput): PlanAmounts {
  const list = price.priceCents;
  if (plan.kind === "MONTHLY") {
    const n = Math.max(1, Math.trunc(plan.installments));
    if (price.installmentCents && price.installmentCents > 0) {
      const schedule = Array.from({ length: n }, () => price.installmentCents!);
      const total = price.installmentCents * n;
      return { listCents: total, discountCents: 0, totalCents: total, dueNowCents: schedule[0], schedule };
    }
    const each = Math.round(list / n);
    const schedule = Array.from({ length: n }, () => each);
    schedule[n - 1] = list - each * (n - 1);
    return { listCents: list, discountCents: 0, totalCents: list, dueNowCents: schedule[0], schedule };
  }
  const discount = Math.round((list * plan.discountPct) / 100);
  const total = list - discount;
  if (plan.kind === "HALF") {
    const first = Math.ceil(total / 2);
    return { listCents: list, discountCents: discount, totalCents: total, dueNowCents: first, schedule: [first, total - first] };
  }
  return { listCents: list, discountCents: discount, totalCents: total, dueNowCents: total, schedule: [total] };
}

/** "$1,278.00" — mismo formato que la tienda Shopify original (USD, 2 decimales). */
export function formatUSD(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Clave de alcance de un PriceEntry: única por producto (@@unique([productId, scopeKey])).
 * Todo alta/edición de precios debe escribirla (ONLINE ignora la sede).
 */
export function priceScopeKey(p: { modality: "ONLINE" | "SEMIPRESENCIAL"; sedeId?: string | null; choiceId?: string | null }): string {
  const sede = p.modality === "ONLINE" ? "-" : p.sedeId || "-";
  return `${p.modality}:${sede}:${p.choiceId || "-"}`;
}
