"use server";
// Acciones del panel de Pedidos: verificar (aprobar/rechazar) pagos manuales, reembolsar, comentar, cancelar y
// las correcciones manuales (reasignar cohorte, ajustar saldo, condonar cuota, rematricular/desmatricular,
// reenviar correos). Cada una delega en el servicio de dominio, que vuelve a comprobar rol y usuario activo
// (requireAdmin) y deja su OrderEvent. Devuelven { ok, message } para el toast; la página se refresca sola.
import { revalidatePath } from "next/cache";
import { isDomainError } from "@/server/errors";
import { services } from "@/server/services";
import { requireAdminAction } from "../../_lib/session";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string; needsConfirmRepeat?: boolean; pending?: boolean };

function fail(e: unknown, fallback: string): ActionResult {
  if (isDomainError(e)) {
    const det = e.details ?? {};
    const cause = typeof det.cause === "string" && e.code === "PAYMENT_PROVIDER" && !det.pending ? ` (${det.cause.slice(0, 160)})` : "";
    return { ok: false, error: e.message + cause, needsConfirmRepeat: det.needsConfirmRepeat === true, pending: det.pending === true };
  }
  console.error("[admin/orders]", e);
  return { ok: false, error: fallback };
}

function done(orderId: string, message: string): ActionResult {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/orders");
  return { ok: true, message };
}

/** Convierte "1.234,56" / "1234.56" / "1234" en centavos (NaN si no es un número). */
function parseCents(raw: unknown): number | undefined {
  let s = String(raw ?? "").trim().replace(/[\s$]/g, "");
  if (!s) return undefined;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export async function verifyPayment(orderId: string, paymentId: string, decision: "approve" | "reject", note: string, amountUsd?: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    const amountUsdCents = amountUsd ? parseCents(amountUsd) : undefined;
    if (amountUsdCents !== undefined && !(amountUsdCents > 0)) return { ok: false, error: "Indica un equivalente en USD válido." };
    // La pertenencia se comprueba ANTES de verificar: un paymentId de otro pedido no debe aprobarse ni rechazarse.
    const pay = await services().deps.db.payment.findUnique({ where: { id: paymentId }, select: { orderId: true } });
    if (!pay || pay.orderId !== orderId) return { ok: false, error: "El pago no pertenece a este pedido." };
    await services().payments.adminVerifyPayment(user, { paymentId, decision, note: note.trim() || null, amountUsdCents });
    return done(orderId, decision === "approve" ? "Pago aprobado. El pedido quedó pagado y se inició la matrícula." : "Pago rechazado. Se avisó al cliente por correo.");
  } catch (e) {
    return fail(e, "No pudimos registrar la verificación. Intenta de nuevo.");
  }
}

export interface RefundForm {
  paymentId: string;
  amount: string;
  reason: string;
  unenroll: boolean;
  releaseSeat: boolean;
  keepCertificate: boolean;
  confirmRepeat: boolean;
  idempotencyKey: string;
}

export async function refundPayment(orderId: string, f: RefundForm): Promise<ActionResult> {
  const user = await requireAdminAction();
  const amountCents = parseCents(f.amount);
  if (amountCents === undefined || !Number.isInteger(amountCents) || amountCents <= 0) return { ok: false, error: "Indica el monto a reembolsar." };
  try {
    const pay = await services().deps.db.payment.findUnique({ where: { id: f.paymentId }, select: { orderId: true, method: true } });
    if (!pay || pay.orderId !== orderId) return { ok: false, error: "El pago no pertenece a este pedido." };
    const r = await services().payments.refundPayment(user, {
      paymentId: f.paymentId,
      amountCents,
      reason: f.reason.trim() || null,
      unenroll: f.unenroll,
      releaseSeat: f.releaseSeat,
      keepCertificate: f.keepCertificate,
      manual: pay.method !== "PAYPAL",
      confirmRepeat: f.confirmRepeat,
      idempotencyKey: f.idempotencyKey || null,
    });
    return done(orderId, r.fullyRefunded ? "Reembolso completado. El pedido quedó reembolsado." : "Reembolso completado (parcial).");
  } catch (e) {
    const r = fail(e, "No pudimos procesar el reembolso. Intenta de nuevo.");
    revalidatePath(`/admin/orders/${orderId}`);
    return r;
  }
}

export async function addOrderNote(orderId: string, note: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    await services().orders.addNote(user, orderId, note);
    return done(orderId, "Comentario publicado.");
  } catch (e) {
    return fail(e, "No pudimos publicar el comentario.");
  }
}

export async function cancelOrderAction(orderId: string, reason: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    await services().orders.cancelOrder(user, orderId, reason.trim() || undefined);
    return done(orderId, "Pedido cancelado. El cupo quedó libre.");
  } catch (e) {
    return fail(e, "No pudimos cancelar el pedido.");
  }
}

export async function reassignCohortAction(orderId: string, orderItemId: string, cohortId: string, note: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    const item = await services().deps.db.orderItem.findUnique({ where: { id: orderItemId }, select: { orderId: true } });
    if (!item || item.orderId !== orderId) return { ok: false, error: "El programa no pertenece a este pedido." };
    const r = await services().corrections.reassignCohort(user, orderItemId, cohortId, note.trim() || undefined);
    const extra = r.enrollment && "status" in r.enrollment && r.enrollment.status === "ERROR" ? " La matrícula se reintentará." : "";
    return done(orderId, `Cohorte reasignada.${extra}`);
  } catch (e) {
    return fail(e, "No pudimos reasignar la cohorte.");
  }
}

export async function adjustBalanceAction(orderId: string, kind: "discount" | "charge", amount: string, reason: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  const cents = parseCents(amount);
  if (cents === undefined || !Number.isInteger(cents) || cents <= 0) return { ok: false, error: "Indica un monto mayor que cero." };
  if (!reason.trim()) return { ok: false, error: "Indica el motivo del ajuste." };
  try {
    const r = await services().corrections.adjustBalanceDetailed(user, orderId, kind === "discount" ? -cents : cents, reason.trim());
    const bal = (r.balanceCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
    return done(orderId, `Saldo ajustado. Saldo pendiente: $${bal}.`);
  } catch (e) {
    return fail(e, "No pudimos ajustar el saldo.");
  }
}

export async function waiveInstallmentAction(orderId: string, installmentId: string, reason: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  if (!reason.trim()) return { ok: false, error: "Indica el motivo." };
  try {
    const ins = await services().deps.db.installment.findUnique({ where: { id: installmentId }, select: { orderId: true, sequence: true } });
    if (!ins || ins.orderId !== orderId) return { ok: false, error: "La cuota no pertenece a este pedido." };
    await services().corrections.waiveInstallment(user, installmentId, reason.trim());
    return done(orderId, `Cuota ${ins.sequence} condonada.`);
  } catch (e) {
    return fail(e, "No pudimos condonar la cuota.");
  }
}

export async function reenrollAction(orderId: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    const r = await services().enrollment.reenrollOrder(user, orderId);
    if (r.status === "ENROLLED") return done(orderId, `Matrícula en Moodle al día (${r.enrolledCourseIds.length} curso(s)).`);
    if (r.status === "SKIPPED") return { ok: false, error: r.reason ?? "Este pedido no tiene cursos habilitados para matricular." };
    if (r.status === "FAILED") return { ok: false, error: `Moodle rechazó la matrícula: ${r.reason ?? "error desconocido"}.` };
    return done(orderId, "Rematrícula en curso: Moodle no respondió y se reintentará sola.");
  } catch (e) {
    return fail(e, "No pudimos rematricular en Moodle.");
  }
}

export async function unenrollAction(orderId: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    const r = await services().enrollment.adminUnenrollOrder(user, orderId);
    return done(orderId, r.unenrolledCourseIds.length ? `Desmatriculado de ${r.unenrolledCourseIds.length} curso(s) en Moodle.` : "No había cursos que desmatricular.");
  } catch (e) {
    return fail(e, "No pudimos desmatricular en Moodle.");
  }
}

export async function resendEmailAction(orderId: string, emailId: string): Promise<ActionResult> {
  const user = await requireAdminAction();
  try {
    const m = await services().deps.db.emailOutbox.findUnique({ where: { id: emailId }, select: { orderId: true, to: true } });
    if (!m || m.orderId !== orderId) return { ok: false, error: "El correo no pertenece a este pedido." };
    const r = await services().email.resendEmail(user, emailId);
    return r.status === "SENT" ? done(orderId, `Correo reenviado a ${m.to}.`) : { ok: false, error: "El correo quedó en cola: el envío falló y se reintentará." };
  } catch (e) {
    return fail(e, "No pudimos reenviar el correo.");
  }
}
