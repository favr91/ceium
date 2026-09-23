// Cálculo de montos por plan de pago. Toda cifra en centavos enteros (USD).
// Reglas (derivadas de las variantes reales de ceium.net, ver prisma/seed.ts):
//   FULL:    total = price·(1−d)                   dueNow = total
//   HALF:    total = price·(1−d)                   dueNow = ⌈total/2⌉, resto = 1 cuota
//   MONTHLY: total = installmentCents·N            dueNow = installmentCents, resto = N−1 cuotas
//            (si no hay installmentCents: price/N redondeado; la última cuota absorbe el residuo)
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
    const n = Math.max(1, plan.installments);
    const each = price.installmentCents ?? Math.round(list / n);
    const schedule = Array.from({ length: n }, () => each);
    if (price.installmentCents == null) schedule[n - 1] = list - each * (n - 1);
    const total = schedule.reduce((a, b) => a + b, 0);
    return { listCents: list, discountCents: Math.max(0, list - total), totalCents: total, dueNowCents: schedule[0], schedule };
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
