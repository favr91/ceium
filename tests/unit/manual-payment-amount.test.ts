// Monto de un pago manual tal como lo escribe el médico (checkout y /pedido/[token] usan el mismo intérprete):
// «33.705» con punto de miles es Bs. 33.705,00, no Bs. 33,71 (x2 crítica: el pedido se aprobaba como pago de menos).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAmountCents } from "@/components/checkout/manual-payment-fields";

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
  ])("%s → %i céntimos", (raw, cents) => {
    expect(parseAmountCents(raw)).toBe(cents);
  });

  it("vacío o basura → NaN", () => {
    expect(parseAmountCents("")).toBeNaN();
    expect(parseAmountCents("abc")).toBeNaN();
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
