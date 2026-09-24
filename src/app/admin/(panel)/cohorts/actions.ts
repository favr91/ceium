"use server";
// Acciones de Cohortes y Sedes del panel. Toda escritura pasa por services().cohorts / services().catalog
// (validan, aplican el invariante de cupo con UPDATE condicional y dejan AuditLog en la misma transacción).
import { revalidatePath } from "next/cache";
import { services } from "@/server/services";
import { DomainError, isDomainError } from "@/server/errors";
import { requireAdminAction } from "../../_lib/session";
import { COHORT_STATUSES, type CohortForm, type CohortStatus } from "@/components/admin/cohorts/types";

type Res = { ok: true } | { ok: false; error: string };

function errMsg(e: unknown): string {
  if (isDomainError(e)) return e.message;
  console.error("[admin/cohorts]", e);
  return "Ocurrió un error inesperado. Intenta de nuevo.";
}

function refresh(id?: string | null) {
  revalidatePath("/admin/cohorts");
  revalidatePath("/admin/sedes");
  if (id) revalidatePath(`/admin/cohorts/${id}`);
  revalidatePath("/", "layout");
}

/** Día de Venezuela (UTC−4): la fecha se guarda a medianoche de Caracas, igual que el seed. */
const day = (s: string) => new Date(`${s}T00:00:00-04:00`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function fields(f: CohortForm) {
  if (!f.name.trim()) throw new DomainError("VALIDATION", "El nombre es obligatorio.");
  if (!DAY_RE.test(f.startDate) || !DAY_RE.test(f.endDate)) throw new DomainError("VALIDATION", "Indica la fecha de inicio y de fin.");
  if (f.enrollmentDeadline && !DAY_RE.test(f.enrollmentDeadline)) throw new DomainError("VALIDATION", "Fecha de cierre de inscripciones inválida.");
  const cap = f.capacity.trim();
  if (!/^\d+$/.test(cap)) throw new DomainError("VALIDATION", "El cupo debe ser un número entero (0 o más).");
  if (!COHORT_STATUSES.includes(f.status)) throw new DomainError("VALIDATION", "Estado inválido.");
  const sessions = f.sessions
    .filter((s) => s.date || s.title.trim())
    .map((s, i) => {
      if (!DAY_RE.test(s.date)) throw new DomainError("VALIDATION", `Sesión ${i + 1}: falta la fecha.`);
      if (!s.title.trim()) throw new DomainError("VALIDATION", `Sesión ${i + 1}: falta el título.`);
      if ((s.startTime && !TIME_RE.test(s.startTime)) || (s.endTime && !TIME_RE.test(s.endTime))) throw new DomainError("VALIDATION", `Sesión ${i + 1}: hora inválida.`);
      return { date: s.date, title: s.title.trim(), ...(s.startTime ? { startTime: s.startTime } : {}), ...(s.endTime ? { endTime: s.endTime } : {}), ...(s.courseSlug ? { courseSlug: s.courseSlug } : {}) };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
  return {
    name: f.name.trim(),
    startDate: day(f.startDate),
    endDate: day(f.endDate),
    enrollmentDeadline: f.enrollmentDeadline ? day(f.enrollmentDeadline) : null,
    capacity: Number(cap),
    status: f.status,
    sessions: sessions.length ? sessions : null,
    notes: f.notes.trim() || null,
    scheduleUrl: f.scheduleUrl.trim() || null,
  };
}

export async function saveCohort(form: CohortForm): Promise<Res & { id?: string }> {
  const user = await requireAdminAction();
  try {
    const data = fields(form);
    if (!form.id) {
      if (!form.productId) return { ok: false, error: "Elige el programa." };
      if (!form.sedeId) return { ok: false, error: "Elige la sede." };
      const c = await services().cohorts.createCohort(user, { productId: form.productId, sedeId: form.sedeId, ...data });
      refresh(c.id);
      return { ok: true, id: c.id };
    }
    await services().cohorts.updateCohort(user, form.id, data);
    refresh(form.id);
    return { ok: true, id: form.id };
  } catch (e) {
    refresh(form.id);
    return { ok: false, error: errMsg(e) };
  }
}

/** Cupo en línea desde el listado (como «Disponible» en el inventario de Shopify): cada fila por separado. */
export async function saveCapacities(changes: { id: string; capacity: number }[]): Promise<{ ok: boolean; saved: string[]; errors: { id: string; error: string }[] }> {
  const user = await requireAdminAction();
  const saved: string[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const c of changes) {
    try {
      if (!Number.isInteger(c.capacity) || c.capacity < 0) throw new DomainError("VALIDATION", "El cupo debe ser un número entero (0 o más).");
      await services().cohorts.updateCohort(user, c.id, { capacity: c.capacity }, "Cupo editado desde el listado");
      saved.push(c.id);
    } catch (e) {
      errors.push({ id: c.id, error: errMsg(e) });
    }
  }
  refresh();
  return { ok: errors.length === 0, saved, errors };
}

export async function setCohortsStatus(ids: string[], status: CohortStatus): Promise<{ ok: boolean; changed: number; errors: string[] }> {
  const user = await requireAdminAction();
  let changed = 0;
  const errors: string[] = [];
  for (const id of ids) {
    try {
      await services().cohorts.setCohortStatus(user, id, status);
      changed++;
    } catch (e) {
      errors.push(errMsg(e));
    }
  }
  refresh();
  return { ok: errors.length === 0, changed, errors };
}

export async function deleteCohortAction(id: string): Promise<Res> {
  const user = await requireAdminAction();
  try {
    await services().cohorts.deleteCohort(user, id);
    refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// ───────── Sedes ─────────

export interface SedeInput { id?: string; slug: string; name: string; city: string; address: string; phone: string; mapUrl: string; active: boolean }

export async function saveSede(input: SedeInput): Promise<Res & { id?: string }> {
  const user = await requireAdminAction();
  try {
    const mapUrl = input.mapUrl.trim();
    if (mapUrl && !/^https?:\/\//i.test(mapUrl)) throw new DomainError("VALIDATION", "El enlace del mapa debe empezar con https://");
    const svc = services();
    const position = input.id ? undefined : (await svc.deps.db.sede.count());
    const s = await svc.catalog.upsertSede(user, {
      ...(input.id ? { id: input.id } : {}),
      slug: input.slug.trim(),
      name: input.name.trim(),
      city: input.city.trim() || null,
      address: input.address.trim() || null,
      phone: input.phone.trim() || null,
      mapUrl: mapUrl || null,
      active: input.active,
      ...(position !== undefined ? { position } : {}),
    });
    refresh();
    return { ok: true, id: s.id };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Reordena las sedes (orden en el checkout, la matriz de precios y el pie de la tienda). */
export async function reorderSedes(ids: string[]): Promise<Res> {
  const user = await requireAdminAction();
  try {
    const svc = services();
    const sedes = await svc.deps.db.sede.findMany({ where: { id: { in: ids } } });
    if (sedes.length !== ids.length) throw new DomainError("VALIDATION", "La lista de sedes cambió. Recarga la página.");
    for (const [i, id] of ids.entries()) {
      const s = sedes.find((x) => x.id === id)!;
      if (s.position !== i) await svc.catalog.upsertSede(user, { id, slug: s.slug, name: s.name, position: i }, "Orden de sedes");
    }
    refresh();
    return { ok: true };
  } catch (e) {
    refresh();
    return { ok: false, error: errMsg(e) };
  }
}
