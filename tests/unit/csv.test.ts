// CSV del panel: formato para Excel en español vs. CSV sin formato, fechas de Caracas y celdas seguras.
import { describe, expect, it } from "vitest";
import { at, code, day, money, toCsv } from "@/server/csv";

const lines = (s: string) => s.replace(/^﻿/, "").split("\r\n").filter(Boolean);

describe("toCsv", () => {
  const head = ["Pedido", "Fecha", "Total USD", "Inicio", "Teléfono", "Nota"];
  const row = ["#1015", at(new Date("2026-09-24T03:06:00Z")), money(127800), day("2026-10-03"), code("04141234567"), "Paga el martes; confirma"];

  it("para Excel: BOM, «;», coma decimal, fecha dd/mm/aaaa en hora de Caracas y teléfono sin perder el 0", () => {
    const csv = toCsv("excel", head, [row]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const [h, r] = lines(csv);
    expect(h).toBe("Pedido;Fecha;Total USD;Inicio;Teléfono;Nota");
    // 03:06 UTC del 24 = 23:06 del 23 en Caracas (UTC−4)
    expect(r).toBe('#1015;23/09/2026 23:06;1278,00;03/10/2026;"=""04141234567""";"Paga el martes; confirma"');
  });

  it("sin formato: «,», punto decimal, ISO 8601 con −04:00 y sin BOM", () => {
    const csv = toCsv("plain", head, [row]);
    expect(csv.startsWith("﻿")).toBe(false);
    expect(lines(csv)[1]).toBe("#1015,2026-09-23T23:06:00-04:00,1278.00,2026-10-03,04141234567,Paga el martes; confirma");
    expect(lines(toCsv("plain", ["a"], [["Ana, Luis"]]))[1]).toBe('"Ana, Luis"');
  });

  it("celdas que parecen fórmulas se neutralizan; teléfonos y montos negativos quedan igual", () => {
    const csv = toCsv("plain", ["a"], [["=HYPERLINK(\"http://x\")"], ["@SUM(A1)"], ["+cmd|' /C calc'!A0"], ["-2+3+cmd"], ["+58 414-1234567"], ["-142.00"], [code("=1+1")]]);
    expect(lines(csv).slice(1)).toEqual(['"\'=HYPERLINK(""http://x"")"', "'@SUM(A1)", "'+cmd|' /C calc'!A0", "'-2+3+cmd", "+58 414-1234567", "-142.00", "'=1+1"]);
  });

  it("vacíos, números, sí/no y comillas", () => {
    const csv = toCsv("excel", ["a", "b", "c", "d", "e"], [[null, 3.5, true, 'Dice "hola"', money(null)]]);
    expect(lines(csv)[1]).toBe(';3,5;Sí;"Dice ""hola""";');
  });

  it("códigos cortos o con letras no se tocan (cédula V-…, referencias sin cero inicial)", () => {
    const csv = toCsv("excel", ["a", "b", "c"], [[code("V-12345678"), code("4518772391"), code("004518772391")]]);
    expect(lines(csv)[1]).toBe('V-12345678;4518772391;"=""004518772391"""');
  });
});
