"use server";
// Ficha del cliente: nota interna (con auditoría).
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
