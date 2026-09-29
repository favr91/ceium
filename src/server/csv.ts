// Exportaciones CSV del panel. Dos formatos, como el «Exportar» de Shopify:
//  - excel: para abrir con doble clic en Excel/Numbers configurados en español (Venezuela usa coma decimal y «;»
//    como separador de listas): columnas con «;», decimales con coma, fechas dd/mm/aaaa en hora de Caracas y UTF-8
//    con BOM (acentos). Teléfonos, referencias y cédulas numéricas no pierden el cero inicial ni pasan a notación
//    científica.
//  - plain: CSV estándar para Google Sheets u otros sistemas: «,», decimales con punto, fechas ISO 8601 (−04:00).
// En ambos, una celda que empieza como fórmula (=, @, o +/− seguido de algo que no es un número) se antepone con «'»:
// un nombre o una nota escritos por un cliente no se ejecutan al abrir el archivo (inyección de fórmulas).

export type CsvFormat = "excel" | "plain";
export const parseCsvFormat = (v: string | null | undefined): CsvFormat => (v === "plain" ? "plain" : "excel");

/** Tope de filas por archivo (evita consultas enormes; el panel nunca lista tanto de una vez). */
export const CSV_MAX_ROWS = 10_000;

export type CsvCell =
  | string
  | number
  | boolean
  | null
  | undefined
  | { money: number }
  | { at: Date | null }
  | { day: string | null }
  | { code: string | null };

/** Monto en centavos (USD o Bs.) → 1278,00 (excel) / 1278.00 (plain). */
export const money = (cents: number | null | undefined): CsvCell => (cents == null ? null : { money: cents });
/** Fecha y hora de Caracas. */
export const at = (d: Date | string | null | undefined): CsvCell => ({ at: d ? new Date(d) : null });
/** Día AAAA-MM-DD (fechas de cohortes). */
export const day = (ymd: string | null | undefined): CsvCell => ({ day: ymd ?? null });
/** Texto que parece número (teléfono, cédula, referencia bancaria): se conserva tal cual. */
export const code = (s: string | null | undefined): CsvCell => ({ code: s ?? null });

const CARACAS = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const parts = (d: Date) => Object.fromEntries(CARACAS.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;

/** Día de hoy en Caracas (AAAA-MM-DD), para el nombre del archivo. */
export function caracasStamp(now = new Date()): string {
  const p = parts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

function guard(s: string): string {
  const formula = /^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().,-]*$/.test(s));
  return formula ? `'${s}` : s;
}

function render(v: CsvCell, f: CsvFormat): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (typeof v === "number") return f === "excel" ? String(v).replace(".", ",") : String(v);
  if (typeof v === "string") return guard(v);
  if ("money" in v) {
    const s = (v.money / 100).toFixed(2);
    return f === "excel" ? s.replace(".", ",") : s;
  }
  if ("at" in v) {
    if (!v.at || Number.isNaN(v.at.getTime())) return "";
    const p = parts(v.at);
    return f === "excel" ? `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}` : `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00-04:00`;
  }
  if ("day" in v) {
    if (!v.day || !/^\d{4}-\d{2}-\d{2}$/.test(v.day)) return v.day ?? "";
    const [y, m, d] = v.day.split("-");
    return f === "excel" ? `${d}/${m}/${y}` : v.day;
  }
  const s = v.code ?? "";
  // ="0414…": Excel lo muestra como texto (sin quitar el 0 ni pasar a 4,14E+09). Solo dígitos: no es inyectable.
  if (f === "excel" && /^\d+$/.test(s) && (s.startsWith("0") || s.length > 11)) return `="${s}"`;
  return guard(s);
}

export function toCsv(format: CsvFormat, head: string[], rows: CsvCell[][]): string {
  const sep = format === "excel" ? ";" : ",";
  const quote = (s: string) => (s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [head.map(quote).join(sep), ...rows.map((r) => r.map((c) => quote(render(c, format))).join(sep))];
  return (format === "excel" ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

/** Respuesta de descarga: `<nombre>-AAAA-MM-DD.csv`, sin caché (datos personales). */
export function csvResponse(csv: string, name: string): Response {
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-${caracasStamp()}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
