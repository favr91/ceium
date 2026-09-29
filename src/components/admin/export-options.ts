// Alcances del diálogo «Exportar» (sin "use client": lo usan páginas de servidor y componentes cliente).

export interface ExportOption {
  key: string;
  label: string;
  /** Parámetros de la ruta de exportación para este alcance (sin `format`), p. ej. "view=PAID&q=ana". */
  query: string;
}

/** Une parámetros no vacíos en una consulta («a=1&b=2»). */
export function exportQuery(params: Record<string, string | number | null | undefined | false>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== false && v !== "") p.set(k, String(v));
  return p.toString();
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Alcances habituales de un índice, en el orden de Shopify: página actual (si hay varias), todo, lo que coincide
 * con los filtros (si hay filtros) y la selección (si hay). `filters` son los parámetros del índice sin `page`.
 */
export function exportOptions(o: {
  /** Sustantivo en plural y singular: ["pedidos", "pedido"]. */
  noun: [string, string];
  filters: string;
  filtered: boolean;
  /** Cuántos coinciden con los filtros. */
  total: number;
  page?: number;
  pages?: number;
  selected?: string[];
}): { options: ExportOption[]; initial: string } {
  const [many, one] = o.noun;
  const options: ExportOption[] = [];
  if (o.pages && o.pages > 1 && o.page) options.push({ key: "page", label: "Página actual", query: [o.filters, `page=${o.page}`].filter(Boolean).join("&") });
  options.push({ key: "all", label: `Todos los ${many}`, query: "" });
  if (o.filtered) options.push({ key: "filtered", label: `${plural(o.total, one, many)} que coinciden con los filtros actuales`, query: o.filters });
  if (o.selected?.length) options.push({ key: "selected", label: `Seleccionados: ${plural(o.selected.length, one, many)}`, query: `ids=${o.selected.join(",")}` });
  return { options, initial: o.selected?.length ? "selected" : o.filtered ? "filtered" : "all" };
}
