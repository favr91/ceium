import { describe, expect, it } from "vitest";
import { computePlanAmounts, formatUSD } from "@/server/pricing";

// Casos tomados de las variantes reales de ceium.net (ref/products.json).
describe("computePlanAmounts", () => {
  it("curso: paga todo / paga la mitad (Barquisimeto $180)", () => {
    expect(computePlanAmounts({ priceCents: 18000 }, { kind: "FULL", discountPct: 0, installments: 1 }).dueNowCents).toBe(18000);
    const half = computePlanAmounts({ priceCents: 18000 }, { kind: "HALF", discountPct: 0, installments: 2 });
    expect(half.dueNowCents).toBe(9000);
    expect(half.schedule).toEqual([9000, 9000]);
  });
  it("diplomado: todo 10% ($1,420 → $1,278) y mitad 5% ($674.50)", () => {
    expect(computePlanAmounts({ priceCents: 142000 }, { kind: "FULL", discountPct: 10, installments: 1 }).totalCents).toBe(127800);
    const half = computePlanAmounts({ priceCents: 142000 }, { kind: "HALF", discountPct: 5, installments: 2 });
    expect(half.dueNowCents).toBe(67450);
    expect(half.totalCents).toBe(134900);
  });
  it("diplomado: mes a mes usa la cuota real", () => {
    const m = computePlanAmounts({ priceCents: 142000, installmentCents: 18000 }, { kind: "MONTHLY", discountPct: 0, installments: 8 });
    expect(m.dueNowCents).toBe(18000);
    expect(m.schedule).toHaveLength(8);
    expect(m.totalCents).toBe(144000);
  });
  it("formatUSD", () => {
    expect(formatUSD(127800)).toBe("$1,278.00");
  });
});
