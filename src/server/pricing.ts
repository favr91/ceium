// Cálculo de montos por plan de pago. Toda cifra en centavos enteros (USD).
// Reglas (derivadas de las variantes reales de ceium.net, ver prisma/seed.ts):
//   FULL:    total = price·(1−d)                   dueNow = total
//   HALF:    total = price·(1−d)                   dueNow = ⌈total/2⌉, resto = 1 cuota
//   MONTHLY: total = price (sin recargo)            dueNow = installmentCents, N−1 cuotas iguales y la
//            última absorbe el residuo (si no hay installmentCents: price/N redondeado)
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
  /** Montos de cada cuota (incluye la primera = dueNow). Suma = totalCents. */
  schedule: number[];
}

export function computePlanAmounts(price: PriceInput, plan: PlanInput): PlanAmounts {
  const list = price.priceCents;
  if (plan.kind === "MONTHLY") {
    // Sin recargo: el total mes a mes es el precio de lista. N−1 cuotas iguales y la última absorbe el
    // residuo (con la cuota real de ceium.net y N=8 la última queda en $160: 7×180+160 = 1420).
    let n = Math.max(1, plan.installments);
    const each = price.installmentCents && price.installmentCents > 0 ? Math.min(price.installmentCents, list) : Math.round(list / n);
    // Si la cuota configurada es tan alta que N cuotas superan el precio, se usan menos cuotas.
    if (each * (n - 1) >= list) n = Math.max(1, Math.ceil(list / each));
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
