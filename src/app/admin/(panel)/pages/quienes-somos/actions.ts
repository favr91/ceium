"use server";
// Acciones de Tienda en línea › Quiénes somos (personal). El servicio (server/about-team.ts) vuelve a comprobar el
// permiso con el rol leído de la BD y valida todo: aquí solo se traduce el resultado para la página.
import { revalidatePath } from "next/cache";
import type { TeamSection } from "@/components/store/pages/team";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { requireAdminAction } from "../../../_lib/session";

type Res<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function fail(e: unknown, fallback: string): { ok: false; error: string } {
  if (isDomainError(e)) return { ok: false, error: e.message };
  console.error("[admin/pages/quienes-somos]", e);
  return { ok: false, error: fallback };
}

export async function saveTeamAction(team: TeamSection, version: string | null): Promise<Res<{ team: TeamSection; version: string | null }>> {
  const user = await requireAdminAction();
  try {
    const r = await services().aboutTeam.saveTeamSection(user, { team, version });
    revalidatePath("/pages/quienes-somos");
    revalidatePath("/admin/pages/quienes-somos");
    return { ok: true, ...r };
  } catch (e) {
    return fail(e, "No se pudieron guardar los cambios. Intenta de nuevo.");
  }
}

export async function uploadTeamPhotoAction(formData: FormData): Promise<Res<{ url: string }>> {
  const user = await requireAdminAction();
  try {
    const file = formData.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file) || !file.size) return { ok: false, error: "Elige una imagen." };
    const name = String(formData.get("name") ?? "");
    return { ok: true, ...(await services().aboutTeam.uploadTeamPhoto(user, { bytes: new Uint8Array(await file.arrayBuffer()), name })) };
  } catch (e) {
    return fail(e, "No se pudo subir la foto. Intenta de nuevo.");
  }
}
