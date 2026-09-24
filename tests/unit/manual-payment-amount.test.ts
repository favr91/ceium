// Monto de un pago manual tal como lo escribe el médico (checkout y /pedido/[token] usan el mismo intérprete):
// «33.705» con punto de miles es Bs. 33.705,00, no Bs. 33,71 (x2 crítica: el pedido se aprobaba como pago de menos).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAmountCents, validateManualPayment } from "@/components/checkout/manual-payment-fields";

describe("parseAmountCents", () => {
  it.each([
    ["33.705", 3_370_500],
    ["1.234.567", 123_456_700],
    ["33.705,50", 3_370_550],
    ["33705,5", 3_370_550],
    ["Bs. 33.705,00", 3_370_500],
    ["33705", 3_370_500],
    ["180.00", 18_000],
    ["12.5", 1_250],
    // Formato de EE. UU. (lo muestran algunas apps de banco): el ÚLTIMO separador es el decimal.
    ["33,564.60", 3_356_460],
    ["1,234,567.89", 123_456_789],
    ["33,564", 3_356_400],
    ["33.564,60", 3_356_460],
    ["1.234.567,89", 123_456_789],
    ["12,5", 1_250],
    ["0,50", 50],
    ["33 564,60", 3_356_460],
    ["33705 Bs.", 3_370_500],
    ["$180", 18_000],
  ])("%s → %i céntimos", (raw, cents) => {
    expect(parseAmountCents(raw)).toBe(cents);
  });

  it("vacío o basura → NaN", () => {
    expect(parseAmountCents("")).toBeNaN();
    expect(parseAmountCents("abc")).toBeNaN();
  });

  // x2 crítica: «33,564.60» se leía como Bs. 33,56 (1000 veces menos) y el pago quedaba «en verificación» con
  // ese monto. Lo ambiguo o mal agrupado se rechaza en vez de adivinar.
  it.each(["1.234,567", "1,234.567", "33.56.4", "12,3456", "33,564,60", "33.564,", ".50", "0,005", "1.23.456", "12-5"])("%s → NaN (ambiguo o mal escrito)", (raw) => {
    expect(parseAmountCents(raw)).toBeNaN();
  });

  it("validateManualPayment marca el monto ambiguo en línea (checkout y /pedido)", () => {
    const e = validateManualPayment({ reference: "01341234", bank: "Banesco (0134)", amount: "1.234,567", paidAt: "2026-09-20" }, { name: "c.png", size: 10 }, "VES", "2026-09-24");
    expect(e.amount).toMatch(/monto válido/);
    const ok = validateManualPayment({ reference: "01341234", bank: "Banesco (0134)", amount: "33,564.60", paidAt: "2026-09-20" }, { name: "c.png", size: 10 }, "VES", "2026-09-24");
    expect(ok).toEqual({});
  });

  it("/pedido/[token] no tiene un intérprete propio: usa el compartido", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/app/(checkout)/pedido/[token]/actions.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*\bparseAmountCents\b[^}]*\} from "@\/components\/checkout\/manual-payment-fields"/);
    expect(src).not.toMatch(/function parseAmountCents/);
  });
});

describe("next.config: Server Actions aceptan el comprobante anunciado (10 MB)", () => {
  it("bodySizeLimit ≥ 10 MB", async () => {
    const { default: cfg } = await import("../../next.config");
    const limit = String(cfg.experimental?.serverActions?.bodySizeLimit ?? "1mb");
    const m = /^(\d+(?:\.\d+)?)\s*mb$/i.exec(limit);
    expect(m && Number(m[1])).toBeGreaterThanOrEqual(10.1);
  });
});
