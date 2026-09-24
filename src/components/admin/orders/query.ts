// Estado del índice de pedidos en la URL (compartido por la página RSC y el índice cliente).
export interface IndexState {
  view: string;
  status: string[];
  method: string[];
  modality: string[];
  q: string;
  sort: string;
  dir: "asc" | "desc";
  page: number;
}

export function toQuery(s: IndexState, patch: Partial<IndexState> = {}): string {
  const n = { ...s, ...patch };
  const p = new URLSearchParams();
  if (n.view && n.view !== "ALL") p.set("view", n.view);
  if (n.status.length) p.set("status", n.status.join(","));
  if (n.method.length) p.set("method", n.method.join(","));
  if (n.modality.length) p.set("modality", n.modality.join(","));
  if (n.q) p.set("q", n.q);
  if (n.sort !== "number" || n.dir !== "desc") {
    p.set("sort", n.sort);
    p.set("dir", n.dir);
  }
  if (n.page > 1) p.set("page", String(n.page));
  const q = p.toString();
  return q ? `?${q}` : "";
}

