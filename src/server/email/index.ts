// Servicio de correo: bandeja EmailOutbox (deduplicada por dedupeKey) + envío por el Mailer inyectado.
// Los correos se envían DESPUÉS de confirmar la transacción de negocio; un fallo de envío nunca revierte
// el pago/matrícula: queda FAILED y el job lo reintenta.
import type { Deps } from "@/server/deps";
import { isUniqueViolation } from "@/server/errors";
import { formatUSD } from "@/server/pricing";
import type { MailAttachment } from "@/server/email/mailer";
import * as T from "@/server/email/templates";

export type EmailTemplate =
  | "order_confirmation"
  | "payment_under_verification"
  | "payment_approved"
  | "payment_rejected"
  | "platform_access"
  | "cohort_details"
  | "certificate_issued"
  | "refund_issued";

export interface SendEmailInput {
  template: EmailTemplate;
  to: string;
  rendered: T.RenderedEmail;
  dedupeKey?: string;
  orderId?: string | null;
  customerId?: string | null;
  attachments?: MailAttachment[];
}

export interface SendEmailResult {
  id: string;
  status: "SENT" | "FAILED" | "QUEUED";
  duplicate: boolean;
}

export async function sendEmail(d: Deps, input: SendEmailInput): Promise<SendEmailResult> {
  if (input.dedupeKey) {
    const existing = await d.db.emailOutbox.findUnique({ where: { dedupeKey: input.dedupeKey } });
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };
  }
  let row;
  try {
    row = await d.db.emailOutbox.create({
      data: {
        template: input.template,
        to: input.to,
        cc: null,
        subject: input.rendered.subject,
        html: input.rendered.html,
        text: input.rendered.text,
        dedupeKey: input.dedupeKey ?? null,
        orderId: input.orderId ?? null,
        customerId: input.customerId ?? null,
      },
    });
  } catch (e) {
    if (input.dedupeKey && isUniqueViolation(e)) {
      const existing = await d.db.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
      return { id: existing.id, status: existing.status, duplicate: true };
    }
    throw e;
  }
  const status = await deliver(d, row.id, input.attachments);
  if (input.orderId && status === "SENT") {
    await d.db.orderEvent.create({ data: { orderId: input.orderId, type: "EMAIL_SENT", actorType: "SYSTEM", note: `${input.template} → ${input.to}`, data: { emailId: row.id } } });
  }
  return { id: row.id, status, duplicate: false };
}

async function deliver(d: Deps, id: string, attachments?: MailAttachment[]): Promise<"SENT" | "FAILED"> {
  const row = await d.db.emailOutbox.findUniqueOrThrow({ where: { id } });
  try {
    const res = await d.mailer.send({ id: row.id, from: d.config.mailFrom, to: row.to, cc: row.cc ?? undefined, bcc: d.config.mailBcc, subject: row.subject, html: row.html, text: row.text ?? "", attachments });
    await d.db.emailOutbox.update({ where: { id }, data: { status: "SENT", sentAt: d.now(), attempts: { increment: 1 }, emlPath: res.emlPath ?? null, lastError: null } });
    return "SENT";
  } catch (e) {
    d.log.error(`[email] fallo al enviar ${id}:`, e);
    await d.db.emailOutbox.update({ where: { id }, data: { status: "FAILED", attempts: { increment: 1 }, lastError: String((e as Error)?.message ?? e).slice(0, 500) } });
    return "FAILED";
  }
}

/** Reintenta correos FAILED/QUEUED (máx. `maxAttempts`). Devuelve cuántos se enviaron. */
export async function retryFailedEmails(d: Deps, maxAttempts = 5): Promise<number> {
  const rows = await d.db.emailOutbox.findMany({ where: { status: { in: ["FAILED", "QUEUED"] }, attempts: { lt: maxAttempts } }, orderBy: { createdAt: "asc" }, take: 100 });
  let sent = 0;
  for (const r of rows) {
    if (r.status === "QUEUED" && d.now().getTime() - r.createdAt.getTime() < 60_000) continue; // puede estar enviándose
    if ((await deliver(d, r.id)) === "SENT") sent++;
  }
  return sent;
}

/** Reenvío manual desde el panel: crea una copia nueva (sin dedupe) del correo indicado. */
export async function resendEmail(d: Deps, emailId: string): Promise<SendEmailResult> {
  const r = await d.db.emailOutbox.findUniqueOrThrow({ where: { id: emailId } });
  return sendEmail(d, { template: r.template as EmailTemplate, to: r.to, rendered: { subject: r.subject, html: r.html, text: r.text ?? "" }, orderId: r.orderId, customerId: r.customerId });
}

// ───────────── Vistas de datos para plantillas ─────────────

export async function buildOrderView(d: Deps, orderId: string): Promise<{ view: T.OrderView; email: string; customerId: string; token: string }> {
  const o = await d.db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { sede: true, cohort: true, choice: true } } },
  });
  const view: T.OrderView = {
    number: o.number,
    statusUrl: `${d.config.appUrl}/pedido/${o.token}`,
    customerFirstName: o.customer.firstName,
    customerEmail: o.customer.email,
    items: o.items.map((it) => ({
      title: it.productTitle,
      modalityLabel: it.modality === "ONLINE" ? "Online" : `Semipresencial — ${it.sede?.name ?? ""}`.trim(),
      choiceLabel: it.choice?.label ?? null,
      planLabel: it.planLabel,
      cohortName: it.cohort?.name ?? null,
      totalCents: it.totalCents,
      dueNowCents: it.dueNowCents,
    })),
    totalCents: o.totalCents,
    dueNowCents: o.dueNowCents,
    amountPaidCents: o.amountPaidCents,
    balanceCents: o.balanceCents,
    paymentMethodLabel: o.paymentMethod ? T.METHOD_LABELS[o.paymentMethod] : null,
    expiresAt: o.expiresAt,
  };
  return { view, email: o.customer.email, customerId: o.customerId, token: o.token };
}

export function paymentAmountLabel(p: { currency: string; amountCents: number; amountUsdCents: number }): string {
  return p.currency === "VES" ? `${T.formatVES(p.amountCents)} (≈ ${formatUSD(p.amountUsdCents)})` : formatUSD(p.amountCents);
}

export async function buildPaymentView(d: Deps, paymentId: string): Promise<T.PaymentView> {
  const p = await d.db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { methodLabel: T.METHOD_LABELS[p.method] ?? p.method, amountLabel: paymentAmountLabel(p), reference: p.reference, date: p.paidAt };
}

/** Envuelve un envío para que nunca propague errores al flujo de negocio. */
export async function safeNotify(d: Deps, label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    d.log.error(`[email] no se pudo preparar ${label}:`, e);
  }
}
