// Montos para la vista previa del panel (cliente). Replica EXACTAMENTE computePlanAmounts/formatUSD de
// src/server/pricing.ts (que es solo-servidor por convención); tests/unit/admin-money.test.ts verifica que
// ambos coinciden en todo el catálogo sembrado.
export type Kind = "FULL" | "HALF" | "MONTHLY";

export function planPreview(priceCents: number, installmentCents: number | null, kind: Kind, discountPct: number, installments: number) {
  if (kind === "MONTHLY") {
    const n = Math.max(1, Math.trunc(installments));
    if (installmentCents && installmentCents > 0) return { totalCents: installmentCents * n, dueNowCents: installmentCents, n };
    const each = Math.round(priceCents / n);
    return { totalCents: priceCents, dueNowCents: each, n };
  }
  const total = priceCents - Math.round((priceCents * discountPct) / 100);
  return { totalCents: total, dueNowCents: kind === "HALF" ? Math.ceil(total / 2) : total, n: kind === "HALF" ? 2 : 1 };
}

export function usd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "1.420,50" / "1,420.50" / "1420" → centavos; "" → null; inválido → NaN. */
export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/[$\s]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Math.round(Number(s) * 100);
}

export function centsToInput(c: number | null | undefined): string {
  if (c == null) return "";
  return c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2);
}
