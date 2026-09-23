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
  it("diplomado: mes a mes usa la cuota real y el total es el precio de lista (última cuota $160)", () => {
    for (const [list, each] of [[142000, 18000], [177000, 23000], [121000, 15000]]) {
      const m = computePlanAmounts({ priceCents: list, installmentCents: each }, { kind: "MONTHLY", discountPct: 0, installments: 8 });
      expect(m.dueNowCents).toBe(each);
      expect(m.schedule).toHaveLength(8);
      expect(m.schedule[7]).toBe(16000);
      expect(m.totalCents).toBe(list);
      expect(m.discountCents).toBe(0);
    }
  });
  it("mes a mes: una cuota configurada demasiado alta reduce el número de cuotas", () => {
    const m = computePlanAmounts({ priceCents: 50000, installmentCents: 20000 }, { kind: "MONTHLY", discountPct: 0, installments: 8 });
    expect(m.schedule).toEqual([20000, 20000, 10000]);
  });
  it("formatUSD", () => {
    expect(formatUSD(127800)).toBe("$1,278.00");
  });
});
