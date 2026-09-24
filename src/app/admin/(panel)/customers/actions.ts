"use server";
// Ficha del cliente: nota interna y vincular la cuenta de Moodle que ya tenía (con auditoría).
import { revalidatePath } from "next/cache";
import { services } from "@/server/services";
import { updateCustomerNote } from "@/server/admin-learning";
import { failLearn, type LearnResult } from "../enrollments/actions";
import { requireAdminAction } from "../../_lib/session";

export async function saveCustomerNoteAction(customerId: string, note: string): Promise<LearnResult> {
  const user = await requireAdminAction();
  try {
    await updateCustomerNote(services().deps, user, customerId, note);
    revalidatePath(`/admin/customers/${customerId}`);
    return { ok: true, message: note.trim() ? "Nota guardada." : "Nota eliminada." };
  } catch (e) {
    return failLearn(e, "No pudimos guardar la nota.");
  }
}

/** Vincula al cliente con su cuenta de Moodle existente (id, correo o usuario) y reintenta sus matrículas. */
export async function linkMoodleAccountAction(customerId: string, ref: string): Promise<LearnResult> {
  const user = await requireAdminAction();
  try {
    const r = await services().enrollment.linkMoodleAccount(user, customerId, ref);
    revalidatePath(`/admin/customers/${customerId}`);
    revalidatePath("/admin/enrollments");
    for (const o of r.orders) revalidatePath(`/admin/orders/${o.orderId}`);
    const base = `Cuenta de Moodle #${r.moodleUserId} (${r.username}) vinculada.`;
    const failed = r.orders.filter((o) => o.status !== "ENROLLED");
    if (failed.length) return { ok: false, error: `${base} La matrícula aún no se completó: ${failed.map((o) => o.reason ?? o.status).join("; ")}` };
    return { ok: true, message: r.orders.length ? `${base} Matrícula completada.` : base };
  } catch (e) {
    return failLearn(e, "No pudimos vincular la cuenta de Moodle.");
  }
}
