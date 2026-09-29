// Rutas de exportación CSV del panel (/admin/<sección>/export): sesión y permiso, formato, alcance y descarga.
// Alcance por parámetros, igual en todas: `ids=a,b` (seleccionados) · `page=N` (solo esa página) · filtros de la
// sección (lo que coincide) · nada (todo). `format=excel|plain` (ver server/csv.ts).
import { can, type Permission, type SessionUser } from "@/server/auth";
import { csvResponse, parseCsvFormat, toCsv, type CsvCell, type CsvFormat } from "@/server/csv";
import { isDomainError } from "@/server/errors";
import { currentAdmin } from "./session";

const plain = (msg: string, status: number) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export interface ExportCtx {
  user: SessionUser;
  sp: URLSearchParams;
  format: CsvFormat;
  /** Ids seleccionados (`ids=`), o null. */
  ids: string[] | null;
  /** Página pedida (`page=`), o null para todas. */
  page: number | null;
}

export interface ExportTable {
  /** Nombre base del archivo (sin fecha ni extensión). */
  name: string;
  head: string[];
  rows: CsvCell[][];
}

export async function exportCsv(req: Request, permission: Permission, build: (ctx: ExportCtx) => Promise<ExportTable | null>): Promise<Response> {
  const user = await currentAdmin();
  if (!user) return plain("Inicia sesión en el panel.", 401);
  if (!can(user, permission)) return plain("Tu rol no puede exportar esta información.", 403);
  const sp = new URL(req.url).searchParams;
  const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[a-z0-9]{10,40}$/i.test(s)).slice(0, 1000);
  const page = Number(sp.get("page"));
  const format = parseCsvFormat(sp.get("format"));
  try {
    const t = await build({ user, sp, format, ids: ids.length ? ids : null, page: Number.isInteger(page) && page > 0 ? page : null });
    if (!t) return plain("No encontrado.", 404);
    return csvResponse(toCsv(format, t.head, t.rows), t.name);
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return plain(e.message, e.code === "FORBIDDEN" ? 403 : e.code === "NOT_FOUND" ? 404 : 400);
  }
}

/** Primer valor de un parámetro, recortado. */
export const param = (sp: URLSearchParams, k: string, max = 100) => (sp.get(k) ?? "").trim().slice(0, max);
