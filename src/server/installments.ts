// Cuotas: imputación de lo pagado, vencimiento y recordatorios de la siguiente cuota.
//
// Imputación (reallocateInstallments): el neto pagado del pedido (amountPaidCents, ya descontados los
// reembolsos) se reparte entre las cuotas en orden de secuencia. Es la ÚNICA fuente de verdad de
// paidCents/status: se recalcula tras cada pago confirmado y tras cada reembolso, así un reembolso parcial
// deja de nuevo pendiente la última cuota cubierta (y la siguiente cuota a cobrar es la correcta).
//
// Recordatorios (runInstallmentReminders, job "installments"): para cada pedido con primer pago
// confirmado y saldo pendiente, la siguiente cuota impaga recibe un correo con enlace directo de pago
// (PayPal o manual) — N días antes del vencimiento, al vencer y luego cada `overdueEveryDays` hasta
// `maxOverdueReminders`. Las cuotas vencidas pasan a OVERDUE (con evento en el historial).
import { randomUUID } from "node:crypto";
import type { InstallmentStatus } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import { DAY, readSetting, withTx } from "@/server/deps";
import { addOrderEvent, listPaymentOptions, PAID_STATES, SYSTEM } from "@/server/orders";
import { DEFAULT_INSTALLMENT_REMINDERS, SETTING_KEYS, type InstallmentReminderPolicy } from "@/server/settings";
import { safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import { formatUSD } from "@/server/pricing";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { DomainError } from "@/server/errors";

export interface InstallmentChange {
  id: string;
  sequence: number;
  courseId: string | null;
  moodleCourseId: number | null;
}

export interface ReallocationResult {
  becamePaid: InstallmentChange[];
  becameUnpaid: InstallmentChange[];
}

const SETTLED: InstallmentStatus[] = ["PAID", "WAIVED"];

export async function reallocateInstallments(tx: Tx, orderId: string, now: Date): Promise<ReallocationResult> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { amountPaidCents: true } });
  const list = await tx.installment.findMany({ where: { orderId }, orderBy: { sequence: "asc" } });
  let remaining = Math.max(0, o.amountPaidCents);
  const out: ReallocationResult = { becamePaid: [], becameUnpaid: [] };
  for (const ins of list) {
    if (ins.status === "WAIVED") continue;
    const paid = Math.min(remaining, ins.amountCents);
    remaining -= paid;
    const full = paid >= ins.amountCents;
    const status: InstallmentStatus = full ? "PAID" : ins.overdueAt ? "OVERDUE" : "PENDING";
    if (paid !== ins.paidCents || status !== ins.status) {
      await tx.installment.update({ where: { id: ins.id }, data: { paidCents: paid, status, paidAt: full ? ins.paidAt ?? now : null } });
    }
    const change = { id: ins.id, sequence: ins.sequence, courseId: ins.courseId, moodleCourseId: ins.moodleCourseId };
    if (full && ins.status !== "PAID") out.becamePaid.push(change);
    if (!full && ins.status === "PAID") out.becameUnpaid.push(change);
  }
  return out;
}

export function isSettled(status: InstallmentStatus) {
  return SETTLED.includes(status);
}

/** Siguiente cuota impaga del pedido (la que se cobra ahora). */
export async function nextUnpaidInstallment(db: Deps["db"] | Tx, orderId: string) {
  return db.installment.findFirst({ where: { orderId, status: { in: ["PENDING", "OVERDUE"] } }, orderBy: { sequence: "asc" }, include: { course: { select: { title: true } } } });
}

/** Enlaces directos de pago de una cuota (los usa el correo de recordatorio y la página del pedido). */
function joinLabels(labels: string[]): string {
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} o ${labels[labels.length - 1]}`;
}

export function installmentPaymentLinks(d: Pick<Deps, "config">, token: string, installmentId: string) {
  const base = `${d.config.appUrl}/pedido/${encodeURIComponent(token)}`;
  return { paypalUrl: `${base}/cuota/${encodeURIComponent(installmentId)}/paypal`, manualUrl: `${base}?cuota=${encodeURIComponent(installmentId)}#pagar` };
}

/** Marca OVERDUE las cuotas pendientes vencidas (más la gracia) de pedidos con primer pago confirmado. */
export async function markOverdueInstallments(d: Deps, policy?: InstallmentReminderPolicy): Promise<number> {
  const p = policy ?? (await readSetting(d.db, SETTING_KEYS.installmentReminders, DEFAULT_INSTALLMENT_REMINDERS));
  const now = d.now();
  const limit = new Date(now.getTime() - p.overdueGraceDays * DAY);
  const due = await d.db.installment.findMany({
    where: { status: "PENDING", dueDate: { lt: limit }, order: { status: { in: [...PAID_STATES] } } },
    select: { id: true, orderId: true, sequence: true, amountCents: true, paidCents: true, dueDate: true },
  });
  let n = 0;
  for (const ins of due) {
    const changed = await withTx(d, async (tx) => {
      const r = await tx.installment.updateMany({ where: { id: ins.id, status: "PENDING" }, data: { status: "OVERDUE", overdueAt: now } });
      if (r.count !== 1) return false;
      await addOrderEvent(tx, ins.orderId, "INSTALLMENT_OVERDUE", SYSTEM, `Cuota ${ins.sequence} vencida (${T.formatDate(ins.dueDate)}): ${formatUSD(ins.amountCents - ins.paidCents)} pendientes`, { installmentId: ins.id });
      return true;
    });
    if (changed) n++;
  }
  return n;
}

type Stage = { key: string; overdue: boolean };

function reminderStage(now: Date, dueDate: Date, p: InstallmentReminderPolicy): Stage | null {
  const t = now.getTime();
  const due = dueDate.getTime();
  if (t < due - p.daysBefore * DAY) return null;
  if (t < due) return { key: "upcoming", overdue: false };
  const k = Math.floor((t - due) / (Math.max(1, p.overdueEveryDays) * DAY));
  if (k === 0) return { key: "due", overdue: false };
  if (k > p.maxOverdueReminders) return null;
  return { key: `overdue-${k}`, overdue: true };
}

/**
 * Job: marca vencidas y envía el recordatorio de la siguiente cuota de cada pedido con saldo. Idempotente:
 * cada etapa (antes, al vencer, vencida 1..N) se envía una sola vez por cuota (dedupeKey).
 */
export async function runInstallmentReminders(d: Deps): Promise<{ overdue: number; reminded: number }> {
  const policy = await readSetting(d.db, SETTING_KEYS.installmentReminders, DEFAULT_INSTALLMENT_REMINDERS);
  const overdue = await markOverdueInstallments(d, policy);
  const now = d.now();
  const orders = await d.db.order.findMany({ where: { status: { in: [...PAID_STATES] }, balanceCents: { gt: 0 } }, select: { id: true } });
  let reminded = 0;
  for (const { id } of orders) {
    const ins = await nextUnpaidInstallment(d.db, id);
    if (!ins?.dueDate) continue;
    const stage = reminderStage(now, ins.dueDate, policy);
    if (!stage) continue;
    const sent = await sendInstallmentReminder(d, ins.id, stage);
    if (sent) reminded++;
  }
  return { overdue, reminded };
}

/**
 * Envía (una vez por etapa) el recordatorio de una cuota. Devuelve true si se creó un correo nuevo.
 * Sin `stage` (reenvío desde el panel) siempre envía uno nuevo.
 */
export async function sendInstallmentReminder(d: Deps, installmentId: string, stageArg?: Stage): Promise<boolean> {
  const stage = stageArg ?? { key: `manual-${d.now().getTime()}`, overdue: false };
  let created = false;
  await safeNotify(d, "installment_reminder", async () => {
    const ins = await d.db.installment.findUniqueOrThrow({
      where: { id: installmentId },
      include: { course: { select: { title: true } }, orderItem: { select: { productTitle: true } }, order: { include: { customer: true } } },
    });
    const o = ins.order;
    const total = await d.db.installment.count({ where: { orderId: o.id } });
    const links = installmentPaymentLinks(d, o.token, ins.id);
    // Solo se ofrecen los métodos que la página del pedido puede cobrar hoy (misma fuente: listPaymentOptions).
    const options = await listPaymentOptions(d);
    const paypalOffered = options.some((m) => m.method === "PAYPAL");
    const manualOptions = options.filter((m) => m.method !== "PAYPAL");
    const chosen = manualOptions.find((m) => m.method === o.paymentMethod);
    const manualLabel = chosen ? chosen.label : manualOptions.length ? joinLabels(manualOptions.map((m) => m.label)) : null;
    const rendered = T.installmentReminder({
      firstName: o.customer.firstName,
      orderNumber: o.number,
      sequence: ins.sequence,
      totalInstallments: total,
      programTitle: ins.orderItem?.productTitle ?? null,
      courseTitle: ins.course?.title ?? null,
      // Lo que falta de la cuota, nunca más que el saldo del pedido (p.ej. tras un ajuste).
      amountCents: Math.max(0, Math.min(ins.amountCents - ins.paidCents, o.balanceCents)),
      dueDate: ins.dueDate,
      overdue: stage.overdue || ins.status === "OVERDUE",
      balanceCents: o.balanceCents,
      paypalUrl: paypalOffered ? links.paypalUrl : null,
      manualUrl: manualOptions.length ? links.manualUrl : null,
      manualLabel,
      statusUrl: `${d.config.appUrl}/pedido/${o.token}`,
    });
    const r = await sendEmail(d, { template: "installment_reminder", to: o.customer.email, rendered, dedupeKey: `installment_reminder:${ins.id}:${stage.key}`, orderId: o.id, customerId: o.customerId });
    created = !r.duplicate;
  });
  return created;
}

/**
 * Panel: envía ahora el recordatorio de la SIGUIENTE cuota por pagar (correo con el enlace directo de pago PayPal
 * / manual de esa cuota), sin esperar a la fecha del job. Solo la siguiente: las cuotas se imputan en orden, y un
 * enlace de una cuota posterior cobraría antes de tiempo. Queda en la cronología con quién lo envió.
 */
export async function adminSendInstallmentReminder(d: Deps, actor: SessionUser, installmentId: string): Promise<{ sequence: number; to: string }> {
  const user = await requireAdmin(d.db, actor, "emails.resend");
  const ins = await d.db.installment.findUnique({
    where: { id: installmentId },
    select: { id: true, orderId: true, sequence: true, status: true, order: { select: { status: true, balanceCents: true, customer: { select: { email: true } } } } },
  });
  if (!ins) throw new DomainError("NOT_FOUND", "La cuota no existe.");
  if (!PAID_STATES.includes(ins.order.status) || ins.order.balanceCents <= 0) throw new DomainError("INVALID_STATE", "Este pedido no tiene cuotas por cobrar.");
  const next = await nextUnpaidInstallment(d.db, ins.orderId);
  if (!next) throw new DomainError("INVALID_STATE", "Este pedido no tiene cuotas por cobrar.");
  if (next.id !== ins.id) throw new DomainError("VALIDATION", `Solo se envía el recordatorio de la siguiente cuota por pagar (la ${next.sequence}).`);
  const sent = await sendInstallmentReminder(d, ins.id, { key: `panel-${d.now().getTime()}-${randomUUID().slice(0, 8)}`, overdue: ins.status === "OVERDUE" });
  if (!sent) throw new DomainError("CONFLICT", "No se pudo enviar el recordatorio. Revisa «Correos al cliente» e inténtalo de nuevo.");
  await withTx(d, (tx) => addOrderEvent(tx, ins.orderId, "INSTALLMENT_REMINDER", { type: "ADMIN", id: user.id }, `Recordatorio de la cuota ${ins.sequence} enviado a ${ins.order.customer.email}`, { installmentId: ins.id }));
  return { sequence: ins.sequence, to: ins.order.customer.email };
}
