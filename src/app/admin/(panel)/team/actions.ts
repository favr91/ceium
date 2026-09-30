"use server";
// Acciones de Equipo. Los servicios (admin-users.ts y resetTwoFactorFor de admin-account.ts) vuelven a comprobar el
// permiso y la jerarquía con el rol leído de la BD: aquí solo se traduce el resultado para la página.
import { revalidatePath } from "next/cache";
import type { AdminRole } from "@/generated/prisma/client";
import { resetTwoFactorFor } from "@/server/admin-account";
import type { AccessLinkResult } from "@/server/admin-users";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { requireAdminAction } from "../../_lib/session";

export type TeamResult<T = object> = ({ ok: true; message: string } & T) | { ok: false; error: string };

export interface AccessLinkPayload {
  kind: AccessLinkResult["kind"];
  link: string;
  expiresAt: string;
  emailed: boolean;
  name: string;
  email: string;
}

function fail(e: unknown, fallback: string): { ok: false; error: string } {
  if (isDomainError(e)) return { ok: false, error: e.message };
  console.error("[admin/team]", e);
  return { ok: false, error: fallback };
}

const payload = (r: AccessLinkResult, u: { name: string; email: string }): AccessLinkPayload => ({ kind: r.kind, link: r.link, expiresAt: r.expiresAt.toISOString(), emailed: r.emailed, name: u.name, email: u.email });

export async function inviteMemberAction(input: { name: string; email: string; role: AdminRole }): Promise<TeamResult<{ access: AccessLinkPayload }>> {
  const user = await requireAdminAction();
  try {
    const r = await services().adminUsers.inviteAdminUser(user, { name: input.name, email: input.email.trim(), role: input.role });
    revalidatePath("/admin/team");
    return { ok: true, message: `Invitación creada para ${r.user.name}.`, access: payload(r, r.user) };
  } catch (e) {
    return fail(e, "No pudimos crear la invitación. Intenta de nuevo.");
  }
}

export async function updateMemberAction(id: string, input: { name?: string; role?: AdminRole }): Promise<TeamResult> {
  const user = await requireAdminAction();
  try {
    const u = await services().adminUsers.updateAdminUser(user, id, input);
    revalidatePath("/admin/team");
    return { ok: true, message: `${u.name}: cambios guardados.` };
  } catch (e) {
    return fail(e, "No pudimos guardar los cambios.");
  }
}

export async function setMemberActiveAction(id: string, active: boolean): Promise<TeamResult> {
  const user = await requireAdminAction();
  try {
    const u = await services().adminUsers.updateAdminUser(user, id, { active });
    revalidatePath("/admin/team");
    return { ok: true, message: active ? `${u.name} puede volver a entrar al panel.` : `${u.name} ya no puede entrar al panel; sus sesiones se cerraron.` };
  } catch (e) {
    return fail(e, active ? "No pudimos reactivar la cuenta." : "No pudimos desactivar la cuenta.");
  }
}

export async function sendMemberLinkAction(id: string): Promise<TeamResult<{ access: AccessLinkPayload }>> {
  const user = await requireAdminAction();
  try {
    const s = services();
    const r = await s.adminUsers.sendAccessLink(user, id);
    const u = await s.deps.db.adminUser.findUniqueOrThrow({ where: { id }, select: { name: true, email: true } });
    revalidatePath("/admin/team");
    return { ok: true, message: r.kind === "invite" ? "Invitación reenviada." : "Enlace enviado.", access: payload(r, u) };
  } catch (e) {
    return fail(e, "No pudimos generar el enlace.");
  }
}

export async function resetMemberTwoFactorAction(id: string): Promise<TeamResult> {
  const user = await requireAdminAction();
  try {
    await resetTwoFactorFor(services().deps, user, id, "Desde Equipo");
    revalidatePath("/admin/team");
    return { ok: true, message: "Verificación en dos pasos quitada. Al entrar podrá configurarla de nuevo." };
  } catch (e) {
    return fail(e, "No pudimos quitar la verificación en dos pasos.");
  }
}

export async function cancelInviteAction(id: string): Promise<TeamResult> {
  const user = await requireAdminAction();
  try {
    await services().adminUsers.cancelInvitation(user, id);
    revalidatePath("/admin/team");
    return { ok: true, message: "Invitación cancelada." };
  } catch (e) {
    return fail(e, "No pudimos cancelar la invitación.");
  }
}
