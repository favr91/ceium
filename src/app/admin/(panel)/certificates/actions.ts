"use server";
// Acciones de Certificados: revisar ahora (consulta Moodle y emite si corresponde), reenviar y revocar.
import { revalidatePath } from "next/cache";
import { services } from "@/server/services";
import { checkCertificateNow, resendCertificate, runCertificateSweepNow } from "@/server/admin-learning";
import { failLearn, type LearnResult } from "../enrollments/actions";
import { requireAdminAction } from "../../_lib/session";

function refresh(customerId?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/certificates");
  revalidatePath("/admin/enrollments");
  if (customerId) revalidatePath(`/admin/customers/${customerId}`);
}

export async function checkCertificateAction(customerId: string, diplomaId: string): Promise<LearnResult> {
  const user = await requireAdminAction();
  try {
    const r = await checkCertificateNow(services().deps, user, customerId, diplomaId);
    refresh(customerId);
    if (r.issued && !r.alreadyIssued) return { ok: true, message: `Certificado ${r.code} emitido y enviado por correo.` };
    if (r.alreadyIssued) return { ok: true, message: r.issued ? `El certificado ${r.code} ya estaba emitido.` : `El certificado ${r.code} está revocado.` };
    if (r.blockedByBalance) return { ok: false, error: r.reason ?? "Completó todos los cursos, pero tiene saldo pendiente." };
    if (r.reason && r.total === 0) return { ok: false, error: r.reason };
    return { ok: true, message: `Moodle reporta ${r.completed} de ${r.total} cursos completados. El certificado se emitirá al completar todos.` };
  } catch (e) {
    return failLearn(e, "No pudimos revisar el diplomado en Moodle.");
  }
}

export async function resendCertificateAction(certificateId: string): Promise<LearnResult> {
  const user = await requireAdminAction();
  try {
    await resendCertificate(services().deps, user, certificateId);
    refresh();
    return { ok: true, message: "Certificado reenviado por correo con el PDF adjunto." };
  } catch (e) {
    return failLearn(e, "No pudimos reenviar el certificado.");
  }
}

export async function revokeCertificateAction(certificateId: string, reason: string): Promise<LearnResult> {
  const user = await requireAdminAction();
  if (!reason.trim()) return { ok: false, error: "Indica el motivo de la revocación." };
  try {
    const c = await services().certificates.revokeCertificate(user, certificateId, reason.trim());
    refresh(c.customerId);
    return { ok: true, message: `Certificado ${c.code} revocado. La verificación pública ahora lo muestra como revocado.` };
  } catch (e) {
    return failLearn(e, "No pudimos revocar el certificado.");
  }
}

export async function sweepCertificatesAction(): Promise<LearnResult> {
  const user = await requireAdminAction();
  try {
    const r = await runCertificateSweepNow(services().deps, user);
    refresh();
    const base = `Se revisaron ${r.checked} ${r.checked === 1 ? "diplomado en curso" : "diplomados en curso"} en Moodle`;
    return { ok: true, message: r.issued ? `${base}: ${r.issued} ${r.issued === 1 ? "certificado emitido" : "certificados emitidos"} (${r.codes.join(", ")}).` : `${base}. Ninguno completo todavía.` };
  } catch (e) {
    return failLearn(e, "No pudimos revisar los diplomados en Moodle.");
  }
}
