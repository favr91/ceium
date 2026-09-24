// La vista previa de montos del panel (cliente) debe coincidir con computePlanAmounts (servidor).
import { describe, expect, it } from "vitest";
import { computePlanAmounts, formatUSD } from "@/server/pricing";
import { centsToInput, parseMoney, planPreview, usd } from "@/components/admin/products/money";

describe("panel · montos de vista previa", () => {
  const prices = [8000, 15000, 35000, 121000, 142000, 177000, 99999, 12345];
  const insts = [null, 15000, 18000, 23000];
  it("coincide con computePlanAmounts en FULL/HALF/MONTHLY", () => {
    for (const price of prices)
      for (const d of [0, 5, 10, 15])
        for (const kind of ["FULL", "HALF"] as const) {
          const s = computePlanAmounts({ priceCents: price }, { kind, discountPct: d, installments: kind === "HALF" ? 2 : 1 });
          const c = planPreview(price, null, kind, d, kind === "HALF" ? 2 : 1);
          expect([c.totalCents, c.dueNowCents]).toEqual([s.totalCents, s.dueNowCents]);
        }
    for (const price of prices)
      for (const inst of insts)
        for (const n of [1, 3, 9]) {
          const s = computePlanAmounts({ priceCents: price, installmentCents: inst }, { kind: "MONTHLY", discountPct: 0, installments: n });
          const c = planPreview(price, inst, "MONTHLY", 0, n);
          expect([c.totalCents, c.dueNowCents]).toEqual([s.totalCents, s.dueNowCents]);
        }
  });
  it("formatea igual que formatUSD", () => {
    for (const c of [0, 5, 100, 127800, 1234567]) expect(usd(c)).toBe(formatUSD(c));
  });
  it("interpreta montos escritos a mano", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("1420")).toBe(142000);
    expect(parseMoney("$1,420.50")).toBe(142050);
    expect(parseMoney("1.420,50")).toBe(142050);
    expect(parseMoney("12,5")).toBe(1250);
    expect(parseMoney("abc")).toBeNaN();
    expect(parseMoney("1.2.3")).toBeNaN();
    expect(centsToInput(142000)).toBe("1420");
    expect(centsToInput(142050)).toBe("1420.50");
  });
});
