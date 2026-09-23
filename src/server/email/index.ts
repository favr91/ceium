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

/**
 * Marcador que sustituye a la contraseña temporal de Moodle en el HTML/texto que se GUARDA.
 * Solo contiene caracteres que no cambian al escapar HTML.
 */
export const TEMP_PASSWORD_PLACEHOLDER = "[[CEIUM_TEMP_PASSWORD]]";

/** Referencia a un secreto que no se persiste (se guarda en EmailOutbox.secretRef). */
export interface SecretRef {
  kind: "moodle_temp_password";
  moodleUserId: number;
}

export interface SendEmailInput {
  template: EmailTemplate;
  to: string;
  /** Si incluye un secreto, debe traer TEMP_PASSWORD_PLACEHOLDER en su lugar (ver `secret`). */
  rendered: T.RenderedEmail;
  dedupeKey?: string;
  orderId?: string | null;
  customerId?: string | null;
  /** Se guardan (ruta/contenido) en EmailOutbox para que reintentos y reenvíos los incluyan. */
  attachments?: MailAttachment[];
  /**
   * Contraseña temporal: se sustituye en el marcador SOLO al enviar y nunca se guarda (ni en BD ni en
   * el .eml). En un reintento/reenvío ya no existe: se genera otra en Moodle (core_user_update_users).
   */
  secret?: SecretRef & { value: string };
  /** Quién provoca el envío (para el historial del pedido). Por defecto SYSTEM. */
  actor?: { type: "SYSTEM" | "ADMIN" | "CUSTOMER" | "WEBHOOK"; id?: string | null };
}

export interface SendEmailResult {
  id: string;
  status: "SENT" | "FAILED" | "QUEUED";
  duplicate: boolean;
}

interface StoredAttachment {
  filename: string;
  path?: string;
  contentBase64?: string;
  contentType?: string;
}

function storeAttachments(list?: MailAttachment[]): StoredAttachment[] | null {
  if (!list?.length) return null;
  return list.map((a) => ({
    filename: a.filename,
    ...(a.path ? { path: a.path } : {}),
    ...(a.content != null ? { contentBase64: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(String(a.content)).toString("base64") } : {}),
    ...(a.contentType ? { contentType: a.contentType } : {}),
  }));
}

function loadAttachments(v: unknown): MailAttachment[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  return (v as StoredAttachment[]).map((a) => ({
    filename: a.filename,
    ...(a.path ? { path: a.path } : {}),
    ...(a.contentBase64 ? { content: Buffer.from(a.contentBase64, "base64") } : {}),
    ...(a.contentType ? { contentType: a.contentType } : {}),
  }));
}

function parseSecretRef(v: unknown): SecretRef | null {
  const r = v as SecretRef | null;
  return r && r.kind === "moodle_temp_password" && Number.isInteger(r.moodleUserId) ? r : null;
}

const scrub = (s: string, secret?: string | false) => (secret ? s.split(secret).join(TEMP_PASSWORD_PLACEHOLDER) : s);

export async function sendEmail(d: Deps, input: SendEmailInput): Promise<SendEmailResult> {
  if (input.dedupeKey) {
    const existing = await d.db.emailOutbox.findUnique({ where: { dedupeKey: input.dedupeKey } });
    if (existing) return { id: existing.id, status: existing.status, duplicate: true };
  }
  const secretValue = input.secret?.value;
  const secretRef: SecretRef | null = input.secret ? { kind: input.secret.kind, moodleUserId: input.secret.moodleUserId } : null;
  let row;
  try {
    row = await d.db.emailOutbox.create({
      data: {
        template: input.template,
        to: input.to,
        cc: null,
        // Defensa en profundidad: si la plantilla recibió el valor real, se reemplaza por el marcador.
        subject: scrub(input.rendered.subject, secretValue),
        html: scrub(scrub(input.rendered.html, secretValue && T.esc(secretValue)), secretValue),
        text: scrub(input.rendered.text, secretValue),
        dedupeKey: input.dedupeKey ?? null,
        orderId: input.orderId ?? null,
        customerId: input.customerId ?? null,
        attachments: (storeAttachments(input.attachments) as object[] | null) ?? undefined,
        secretRef: (secretRef as object | null) ?? undefined,
      },
    });
  } catch (e) {
    if (input.dedupeKey && isUniqueViolation(e)) {
      const existing = await d.db.emailOutbox.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
      return { id: existing.id, status: existing.status, duplicate: true };
    }
    throw e;
  }
  const status = await deliver(d, row.id, { secretValue, actor: input.actor });
  return { id: row.id, status, duplicate: false };
}

/** Entrega (o reintenta) una fila concreta de la bandeja con sus adjuntos y secretos. */
export async function deliverOutboxEmail(d: Deps, id: string): Promise<"SENT" | "FAILED" | "SKIPPED"> {
  if (!(await claimFailed(d, id))) return "SKIPPED";
  return deliver(d, id);
}

/** Reclama una fila FAILED (→ QUEUED) para que dos reintentos simultáneos no la envíen dos veces. */
async function claimFailed(d: Deps, id: string): Promise<boolean> {
  const n = await d.db.emailOutbox.updateMany({ where: { id, status: "FAILED" }, data: { status: "QUEUED" } });
  return n.count === 1;
}

async function deliver(d: Deps, id: string, opts: { secretValue?: string; actor?: SendEmailInput["actor"] } = {}): Promise<"SENT" | "FAILED"> {
  const row = await d.db.emailOutbox.findUniqueOrThrow({ where: { id } });
  const ref = parseSecretRef(row.secretRef);
  let secret = opts.secretValue;
  let regenerated = false;
  try {
    if (ref && !secret) {
      // La contraseña original no se guardó: se emite una nueva (Moodle obliga a cambiarla al entrar).
      secret = await d.moodle.resetTempPassword(ref.moodleUserId);
      regenerated = true;
    }
    const fill = (s: string, escape: boolean) => (ref && secret ? s.split(TEMP_PASSWORD_PLACEHOLDER).join(escape ? T.esc(secret) : secret) : s);
    const res = await d.mailer.send({
      id: row.id,
      from: d.config.mailFrom,
      to: row.to,
      cc: row.cc ?? undefined,
      bcc: d.config.mailBcc,
      subject: row.subject,
      html: fill(row.html, true),
      text: fill(row.text ?? "", false),
      attachments: loadAttachments(row.attachments),
      secrets: secret ? [secret, T.esc(secret)] : undefined,
    });
    await d.db.emailOutbox.update({ where: { id }, data: { status: "SENT", sentAt: d.now(), attempts: { increment: 1 }, emlPath: res.emlPath ?? null, lastError: null } });
    if (row.orderId) {
      const actor = opts.actor ?? { type: "SYSTEM" as const };
      await d.db.orderEvent.create({
        data: {
          orderId: row.orderId,
          type: "EMAIL_SENT",
          actorType: actor.type,
          actorId: actor.type === "ADMIN" ? actor.id ?? null : null,
          note: `${row.template} → ${row.to}${regenerated ? " (con contraseña temporal nueva)" : ""}`,
          data: { emailId: row.id, ...(regenerated ? { passwordReset: true } : {}) },
        },
      });
    }
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
    if (r.status === "FAILED" && !(await claimFailed(d, r.id))) continue; // otro proceso lo está reintentando
    if ((await deliver(d, r.id)) === "SENT") sent++;
  }
  return sent;
}

/**
 * Reenvío manual desde el panel: crea una copia nueva (sin dedupe) del correo indicado, con sus adjuntos.
 * Si el correo llevaba contraseña temporal, se genera otra en Moodle (la anterior nunca se guardó).
 */
export async function resendEmail(d: Deps, emailId: string, adminId?: string | null): Promise<SendEmailResult> {
  const r = await d.db.emailOutbox.findUniqueOrThrow({ where: { id: emailId } });
  const ref = parseSecretRef(r.secretRef);
  const row = await d.db.emailOutbox.create({
    data: {
      template: r.template,
      to: r.to,
      cc: r.cc,
      subject: r.subject,
      html: r.html,
      text: r.text,
      orderId: r.orderId,
      customerId: r.customerId,
      attachments: (r.attachments as object[] | null) ?? undefined,
      secretRef: (ref as object | null) ?? undefined,
    },
  });
  const status = await deliver(d, row.id, { actor: adminId ? { type: "ADMIN", id: adminId } : undefined });
  return { id: row.id, status, duplicate: false };
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
