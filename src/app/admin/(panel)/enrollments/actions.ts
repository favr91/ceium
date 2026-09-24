"use server";
// Acciones de Matrículas (y de la ficha del cliente): consultar el progreso en Moodle y reintentar matrículas.
// Delegan en src/server/admin-learning.ts, que vuelve a comprobar rol y usuario activo (requireAdmin).
import { revalidatePath } from "next/cache";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { refreshEnrollmentProgress, retryEnrollments } from "@/server/admin-learning";
import { requireAdminAction } from "../../_lib/session";

export type LearnResult = { ok: true; message: string } | { ok: false; error: string };

export async function failLearn(e: unknown, fallback: string): Promise<LearnResult> {
  if (isDomainError(e)) return { ok: false, error: e.message };
  console.error("[admin/learning]", e);
  return { ok: false, error: fallback };
}

function refresh() {
  revalidatePath("/admin");
  revalidatePath("/admin/enrollments");
  revalidatePath("/admin/certificates");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function refreshProgressAction(ids: string[]): Promise<LearnResult> {
  const user = await requireAdminAction();
  if (!ids.length) return { ok: false, error: "Selecciona al menos una matrícula." };
  try {
    const r = await refreshEnrollmentProgress(services().deps, user, ids);
    refresh();
    if (r.checked === 0 && r.errors === 0) return { ok: false, error: "Ninguna de las matrículas seleccionadas está activa en Moodle." };
    const parts = [`Moodle revisó ${plural(r.checked, "curso", "cursos")}: ${plural(r.completed, "completado", "completados")}`];
    if (r.newlyCompleted) parts.push(`${r.newlyCompleted} ${r.newlyCompleted === 1 ? "nuevo" : "nuevos"}`);
    if (r.certificatesIssued.length) parts.push(`${plural(r.certificatesIssued.length, "certificado emitido", "certificados emitidos")} (${r.certificatesIssued.join(", ")})`);
    if (r.errors) return { ok: false, error: `${parts.join(" · ")}. ${plural(r.errors, "consulta falló", "consultas fallaron")}; intenta de nuevo en unos minutos.` };
    return { ok: true, message: parts.join(" · ") + "." };
  } catch (e) {
    return failLearn(e, "No pudimos consultar Moodle. Intenta de nuevo.");
  }
}

export async function retryEnrollmentsAction(ids: string[]): Promise<LearnResult> {
  const user = await requireAdminAction();
  if (!ids.length) return { ok: false, error: "Selecciona al menos una matrícula." };
  try {
    const r = await retryEnrollments(services().deps, user, ids);
    refresh();
    if (r.failed) return { ok: false, error: `Moodle aún no acepta ${plural(r.failed, "pedido", "pedidos")}${r.errors[0] ? `: ${r.errors[0]}` : ""}. Se reintentará automáticamente.` };
    return { ok: true, message: `Matrícula reintentada en ${plural(r.orders, "pedido", "pedidos")}: ${plural(r.enrolled, "curso habilitado", "cursos habilitados")}.` };
  } catch (e) {
    return failLearn(e, "No pudimos reintentar la matrícula.");
  }
}
