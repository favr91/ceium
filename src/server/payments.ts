// Pagos: manuales (pago móvil, transferencia, Zelle, efectivo) con verificación del admin, PayPal
// (Orders v2: creación, captura en el return URL y webhooks, ambos idempotentes) y reembolsos.
//
// Regla central: un pago pasa a COMPLETED exactamente UNA vez, mediante un UPDATE condicional
// (status ∈ {PENDING, FAILED, CANCELLED} o AWAITING_VERIFICATION → COMPLETED). Quien gana ese UPDATE
// aplica el pago al pedido; el resto (webhook repetido, return URL simultáneo) no hace nada.
// La matrícula y los correos se disparan DESPUÉS de confirmar la transacción.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Currency, PaymentMethod } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import { readSetting, withTx } from "@/server/deps";
import { DomainError, isDomainError, isUniqueViolation } from "@/server/errors";
import { normalizeCapture, normalizeRefund } from "@/server/ports";
import {
  addOrderEvent,
  PAID_STATES,
  PREPAID_STATES,
  recomputeBalance,
  reservationTtlMs,
  getManualMethod,
  SYSTEM,
  transitionOrder,
  type Actor,
} from "@/server/orders";
import { acquireSeat, confirmReservation, releaseOrderReservations } from "@/server/seats";
import { SETTING_KEYS } from "@/server/settings";
import { enrollOrder, unenrollOrder } from "@/server/enrollment";
import { buildOrderView, buildPaymentView, safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";

// ───────────── Aplicar un pago confirmado al pedido ─────────────

export interface ApplyResult {
  orderId: string;
  /** Este pago completó el primer pago (habilita la matrícula). */
  firstPaymentSatisfied: boolean;
  /** No se pudo confirmar el cupo (cohorte llena tras vencer la reserva): requiere intervención. */
  seatProblem: boolean;
  /** El pedido estaba cerrado (cancelado/reembolsado): el pago requiere reembolso manual. */
  closedOrder: boolean;
  shouldEnroll: boolean;
}

async function applyConfirmedPayment(tx: Tx, paymentId: string, actor: Actor, now: Date): Promise<ApplyResult> {
  const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { items: { include: { reservation: true } } } });
  const result: ApplyResult = { orderId: order.id, firstPaymentSatisfied: false, seatProblem: false, closedOrder: false, shouldEnroll: false };

  const amountPaid = order.amountPaidCents + p.amountUsdCents;
  await tx.order.update({ where: { id: order.id }, data: { amountPaidCents: amountPaid, paidAt: order.paidAt ?? now } });
  const balance = await recomputeBalance(tx, order.id);

  // Imputar a cuotas en orden.
  let remaining = p.amountUsdCents;
  let firstInstallment: string | null = null;
  const pending = await tx.installment.findMany({ where: { orderId: order.id, status: { in: ["PENDING", "OVERDUE"] } }, orderBy: { sequence: "asc" } });
  for (const ins of pending) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, ins.amountCents - ins.paidCents);
    if (take <= 0) continue;
    remaining -= take;
    const paidCents = ins.paidCents + take;
    await tx.installment.update({ where: { id: ins.id }, data: { paidCents, status: paidCents >= ins.amountCents ? "PAID" : ins.status, paidAt: paidCents >= ins.amountCents ? now : ins.paidAt } });
    firstInstallment ??= ins.id;
  }
  if (!p.installmentId && firstInstallment) await tx.payment.update({ where: { id: p.id }, data: { installmentId: firstInstallment } });

  await addOrderEvent(tx, order.id, "PAYMENT_RECEIVED", actor, `${T.METHOD_LABELS[p.method] ?? p.method}: ${(p.amountUsdCents / 100).toFixed(2)} USD`, {
    paymentId: p.id,
    amountUsdCents: p.amountUsdCents,
    amountPaidCents: amountPaid,
    balanceCents: balance,
  });

  if (order.status === "CANCELLED" || order.status === "REFUNDED") {
    result.closedOrder = true;
    await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, "Se recibió un pago en un pedido cerrado: requiere reembolso o reapertura manual.", { paymentId: p.id });
    return result;
  }

  if (PREPAID_STATES.includes(order.status)) {
    if (amountPaid >= order.dueNowCents) {
      result.firstPaymentSatisfied = true;
      for (const it of order.items) {
        if (it.modality !== "SEMIPRESENCIAL" || !it.reservation) continue;
        const r = await confirmReservation(tx, it.reservation.id, now);
        if (!r.ok) {
          result.seatProblem = true;
          await addOrderEvent(tx, order.id, "SEAT_UNAVAILABLE", SYSTEM, `La cohorte de «${it.productTitle}» se llenó antes de confirmar el pago: reasigna la cohorte o reembolsa.`, { orderItemId: it.id, cohortId: it.cohortId });
        } else if (r.reacquired) {
          await addOrderEvent(tx, order.id, "SEAT_REACQUIRED", SYSTEM, `Cupo vuelto a tomar para «${it.productTitle}» (la reserva había vencido).`, { orderItemId: it.id });
        }
      }
      const to = balance <= 0 ? "PAID" : "PARTIALLY_PAID";
      await transitionOrder(tx, order.id, to, { actor, note: to === "PAID" ? "Pago total recibido" : "Primer pago recibido; queda saldo pendiente" });
      result.shouldEnroll = !result.seatProblem;
    } else {
      const stillAwaiting = await tx.payment.count({ where: { orderId: order.id, status: "AWAITING_VERIFICATION" } });
      if (order.status === "AWAITING_VERIFICATION" && stillAwaiting === 0) {
        await transitionOrder(tx, order.id, "PENDING_PAYMENT", {
          actor,
          note: `Pago insuficiente para el primer pago: faltan ${((order.dueNowCents - amountPaid) / 100).toFixed(2)} USD`,
        });
      }
    }
  } else if (order.status === "PARTIALLY_PAID" && balance <= 0) {
    await transitionOrder(tx, order.id, "PAID", { actor, note: "Saldo cancelado por completo" });
  }
  if (PAID_STATES.includes(order.status) && order.status !== "ENROLLED") result.shouldEnroll = true;
  return result;
}

async function afterPaymentApplied(d: Deps, paymentId: string, res: ApplyResult, kind: "paypal" | "manual") {
  const orderId = res.orderId;
  if (res.firstPaymentSatisfied) {
    if (kind === "paypal") {
      await safeNotify(d, "order_confirmation", async () => {
        const { view, email, customerId } = await buildOrderView(d, orderId);
        await sendEmail(d, { template: "order_confirmation", to: email, rendered: T.orderConfirmation(view, { paid: true }), dedupeKey: `order_paid:${orderId}`, orderId, customerId });
      });
    }
  }
  if (kind === "manual" || !res.firstPaymentSatisfied) {
    await safeNotify(d, "payment_approved", async () => {
      const { view, email, customerId } = await buildOrderView(d, orderId);
      await sendEmail(d, { template: "payment_approved", to: email, rendered: T.paymentApproved(view, await buildPaymentView(d, paymentId)), dedupeKey: `payment_approved:${paymentId}`, orderId, customerId });
    });
  }
  if (res.shouldEnroll) {
    try {
      await enrollOrder(d, orderId);
    } catch (e) {
      d.log.error(`[payments] matrícula del pedido ${orderId} falló; el job la reintentará`, e);
    }
  }
}

// ───────────── Pagos manuales ─────────────

export interface ManualPaymentInput {
  orderId: string;
  method: Exclude<PaymentMethod, "PAYPAL">;
  reference?: string | null;
  bank?: string | null;
  amountCents: number;
  currency: Currency;
  /** VES por USD. Si se omite en VES se usa la tasa configurada. */
  exchangeRate?: number | string | null;
  paidAt?: Date | null;
  proofFile?: string | null;
  payerName?: string | null;
  payerPhone?: string | null;
  payerCedula?: string | null;
}

const MANUAL_METHODS: PaymentMethod[] = ["PAGO_MOVIL", "TRANSFERENCIA", "ZELLE", "EFECTIVO"];

/** Registra un pago manual con comprobante → AWAITING_VERIFICATION (y el pedido también si era el primer pago). */
export async function recordManualPayment(d: Deps, input: ManualPaymentInput, actor: Actor = { type: "CUSTOMER" }) {
  if (!MANUAL_METHODS.includes(input.method)) throw new DomainError("VALIDATION", "Método de pago manual no válido.");
  if (actor.type === "CUSTOMER") {
    const cfg = await getManualMethod(d, input.method);
    if (!cfg?.enabled) throw new DomainError("VALIDATION", "El método de pago seleccionado no está disponible.");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("VALIDATION", "Ingresa el monto pagado.", { field: "amountCents" });
  const reference = input.reference?.trim() || null;
  if (input.method !== "EFECTIVO" && !reference) throw new DomainError("VALIDATION", "Ingresa el número de referencia del pago.", { field: "reference" });

  let rate: number | null = null;
  let amountUsdCents = input.amountCents;
  if (input.currency === "VES") {
    rate = input.exchangeRate != null && input.exchangeRate !== "" ? Number(input.exchangeRate) : (await readSetting(d.db, SETTING_KEYS.exchangeRate, { vesPerUsd: 0 })).vesPerUsd;
    if (!rate || !Number.isFinite(rate) || rate <= 0) throw new DomainError("VALIDATION", "Falta la tasa de cambio para pagos en bolívares.", { field: "exchangeRate" });
    amountUsdCents = Math.round(input.amountCents / rate);
  }

  const now = d.now();
  const paymentId = await withTx(d, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId } });
    if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
    const acceptsFirst = PREPAID_STATES.includes(order.status);
    const acceptsInstallment = PAID_STATES.includes(order.status) && order.balanceCents > 0;
    if (!acceptsFirst && !acceptsInstallment) throw new DomainError("INVALID_STATE", "Este pedido no admite nuevos pagos.");
    if (reference) {
      const dup = await tx.payment.findFirst({ where: { method: input.method, reference, status: { notIn: ["REJECTED", "CANCELLED", "FAILED"] } } });
      if (dup) throw new DomainError("VALIDATION", "Esa referencia de pago ya fue registrada.", { field: "reference" });
    }
    const p = await tx.payment.create({
      data: {
        orderId: order.id,
        method: input.method,
        status: "AWAITING_VERIFICATION",
        amountCents: input.amountCents,
        currency: input.currency,
        exchangeRate: rate != null ? String(rate) : null,
        amountUsdCents,
        reference,
        bank: input.bank?.trim() || null,
        payerName: input.payerName ?? null,
        payerPhone: input.payerPhone ?? null,
        payerCedula: input.payerCedula ?? null,
        paidAt: input.paidAt ?? now,
        proofFile: input.proofFile ?? null,
      },
    });
    await addOrderEvent(tx, order.id, "PAYMENT_SUBMITTED", actor, `${T.METHOD_LABELS[input.method]} ref. ${reference ?? "—"}`, { paymentId: p.id, amountCents: input.amountCents, currency: input.currency, amountUsdCents });
    if (acceptsFirst && order.status !== "AWAITING_VERIFICATION") {
      await transitionOrder(tx, order.id, "AWAITING_VERIFICATION", { actor, note: "Comprobante recibido; pendiente de verificación", patch: { paymentMethod: input.method } });
    }
    return p.id;
  });

  await safeNotify(d, "payment_under_verification", async () => {
    const { view, email, customerId } = await buildOrderView(d, input.orderId);
    await sendEmail(d, { template: "payment_under_verification", to: email, rendered: T.paymentUnderVerification(view, await buildPaymentView(d, paymentId)), dedupeKey: `payment_submitted:${paymentId}`, orderId: input.orderId, customerId });
  });
  return d.db.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

/** Guarda un comprobante en PRIVATE_FILES_DIR/proofs/<orderId>/… y devuelve la ruta para `proofFile`. */
export async function storeProofFile(d: Deps, orderId: string, filename: string, bytes: Uint8Array): Promise<string> {
  const ext = (path.extname(filename).toLowerCase().match(/^\.(jpg|jpeg|png|webp|pdf|heic)$/)?.[0]) ?? "";
  if (!ext) throw new DomainError("VALIDATION", "El comprobante debe ser una imagen (JPG, PNG, WEBP, HEIC) o un PDF.");
  if (bytes.byteLength > 10 * 1024 * 1024) throw new DomainError("VALIDATION", "El comprobante no puede superar 10 MB.");
  const rel = path.join(d.config.privateFilesDir, "proofs", orderId.replace(/[^a-z0-9]/gi, ""), `${crypto.randomBytes(8).toString("hex")}${ext}`);
  await fs.mkdir(path.dirname(path.resolve(rel)), { recursive: true });
  await fs.writeFile(path.resolve(rel), bytes);
  return rel;
}

export interface VerifyInput {
  paymentId: string;
  decision: "approve" | "reject";
  adminId: string;
  note?: string | null;
  /** Corrección del equivalente en USD al aprobar (p.ej. tasa distinta). */
  amountUsdCents?: number;
}

/** Verificación del admin. Aprobar dispara la matrícula si completa el primer pago. Rechazar libera el cupo. */
export async function adminVerifyPayment(d: Deps, input: VerifyInput) {
  const now = d.now();
  const actor: Actor = { type: "ADMIN", id: input.adminId };
  if (input.decision === "reject" && !input.note?.trim()) throw new DomainError("VALIDATION", "Indica el motivo del rechazo.");
  if (input.amountUsdCents != null && (!Number.isInteger(input.amountUsdCents) || input.amountUsdCents <= 0)) throw new DomainError("VALIDATION", "Monto en USD inválido.");

  const out = await withTx(d, async (tx) => {
    const p = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (!p) throw new DomainError("NOT_FOUND", "El pago no existe.");
    const claimed = await tx.payment.updateMany({
      where: { id: p.id, status: "AWAITING_VERIFICATION" },
      data:
        input.decision === "approve"
          ? { status: "COMPLETED", verifiedById: input.adminId, verifiedAt: now, ...(input.amountUsdCents != null ? { amountUsdCents: input.amountUsdCents } : {}) }
          : { status: "REJECTED", verifiedById: input.adminId, verifiedAt: now, rejectionReason: input.note!.trim() },
    });
    if (claimed.count !== 1) throw new DomainError("INVALID_STATE", "Este pago ya fue verificado.");

    if (input.decision === "approve") {
      const corrected = input.amountUsdCents != null && input.amountUsdCents !== p.amountUsdCents;
      const note = [input.note?.trim() || "Pago aprobado", corrected ? `Equivalente en USD corregido: ${(p.amountUsdCents / 100).toFixed(2)} → ${(input.amountUsdCents! / 100).toFixed(2)}` : null].filter(Boolean).join(". ");
      await addOrderEvent(tx, p.orderId, "PAYMENT_VERIFIED", actor, note, {
        paymentId: p.id,
        amountUsdCentsBefore: p.amountUsdCents,
        amountUsdCentsAfter: input.amountUsdCents ?? p.amountUsdCents,
        corrected,
      });
      return { approved: true as const, apply: await applyConfirmedPayment(tx, p.id, actor, now), orderClosed: false };
    }
    await addOrderEvent(tx, p.orderId, "PAYMENT_REJECTED", actor, input.note!.trim(), { paymentId: p.id });
    const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
    const stillAwaiting = await tx.payment.count({ where: { orderId: order.id, status: "AWAITING_VERIFICATION" } });
    let orderClosed = false;
    if (order.status === "AWAITING_VERIFICATION" && stillAwaiting === 0) {
      if (order.amountPaidCents <= 0) {
        await releaseOrderReservations(tx, order.id, "REJECTED", now);
        await transitionOrder(tx, order.id, "REJECTED", { actor, note: `Pago rechazado: ${input.note!.trim()}` });
        orderClosed = true;
      } else {
        await transitionOrder(tx, order.id, "PENDING_PAYMENT", { actor, note: `Pago rechazado: ${input.note!.trim()}` });
      }
    }
    return { approved: false as const, apply: null, orderClosed };
  });

  const payment = await d.db.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
  if (out.approved) {
    await afterPaymentApplied(d, payment.id, out.apply!, "manual");
  } else {
    await safeNotify(d, "payment_rejected", async () => {
      const { view, email, customerId } = await buildOrderView(d, payment.orderId);
      await sendEmail(d, { template: "payment_rejected", to: email, rendered: T.paymentRejected(view, await buildPaymentView(d, payment.id), payment.rejectionReason, out.orderClosed), dedupeKey: `payment_rejected:${payment.id}`, orderId: payment.orderId, customerId });
    });
  }
  return payment;
}

// ───────────── PayPal ─────────────

export interface StartPaypalResult {
  paymentId: string;
  paypalOrderId: string;
  approveUrl: string;
  amountCents: number;
}

/** Crea la orden PayPal por el monto que corresponde ahora (primer pago o siguiente cuota). */
export async function startPaypalPayment(d: Deps, orderId: string, urls?: { returnUrl?: string; cancelUrl?: string }): Promise<StartPaypalResult> {
  const now = d.now();
  const ttl = await reservationTtlMs(d, "PAYPAL");
  const { paymentId, amountCents, order } = await withTx(d, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { reservation: true } } } });
    if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
    let amount: number;
    if (order.status === "PENDING_PAYMENT") {
      amount = order.dueNowCents - order.amountPaidCents;
      // Si la reserva se liberó (venció y otro comprador limpió), volver a retener cupo o fallar.
      for (const it of order.items) {
        const r = it.reservation;
        if (it.modality !== "SEMIPRESENCIAL" || !r || r.status !== "RELEASED") continue;
        if (!(await acquireSeat(tx, r.cohortId, "HELD", { requireOpen: true }))) throw new DomainError("SOLD_OUT", "Tu reserva venció y ya no quedan cupos en esta cohorte.");
        await tx.seatReservation.update({ where: { id: r.id }, data: { status: "HELD", expiresAt: new Date(now.getTime() + ttl), releasedAt: null, releasedReason: null } });
      }
      if (order.paymentMethod !== "PAYPAL") await tx.order.update({ where: { id: order.id }, data: { paymentMethod: "PAYPAL" } });
    } else if (PAID_STATES.includes(order.status) && order.balanceCents > 0) {
      const next = await tx.installment.findFirst({ where: { orderId, status: { in: ["PENDING", "OVERDUE"] } }, orderBy: { sequence: "asc" } });
      amount = Math.min(order.balanceCents, next ? next.amountCents - next.paidCents : order.balanceCents);
    } else if (order.status === "EXPIRED") {
      throw new DomainError("INVALID_STATE", "Este pedido venció. Vuelve a iniciar la compra.");
    } else {
      throw new DomainError("INVALID_STATE", "Este pedido no admite pagos en este momento.");
    }
    if (amount <= 0) throw new DomainError("INVALID_STATE", "No hay monto pendiente por pagar.");
    await tx.payment.updateMany({ where: { orderId, method: "PAYPAL", status: "PENDING" }, data: { status: "CANCELLED" } });
    const p = await tx.payment.create({ data: { orderId, method: "PAYPAL", status: "PENDING", amountCents: amount, currency: "USD", amountUsdCents: amount, createdAt: now } });
    return { paymentId: p.id, amountCents: amount, order };
  });

  const base = d.config.appUrl;
  try {
    const res = await d.paypal.createOrder({
      amountCents,
      currency: "USD",
      orderId: order.id,
      invoiceId: `${order.number}-${paymentId.slice(-6)}`,
      description: `CEIUM — Pedido #${order.number}`,
      returnUrl: urls?.returnUrl ?? `${base}/pedido/${order.token}/paypal/retorno`,
      cancelUrl: urls?.cancelUrl ?? `${base}/pedido/${order.token}?paypal=cancelado`,
    });
    await d.db.payment.update({ where: { id: paymentId }, data: { paypalOrderId: res.id, providerStatus: "CREATED" } });
    await d.db.$transaction((tx) => addOrderEvent(tx, order.id, "PAYPAL_ORDER_CREATED", { type: "CUSTOMER" }, null, { paymentId, paypalOrderId: res.id, amountCents }));
    return { paymentId, paypalOrderId: res.id, approveUrl: res.approveUrl, amountCents };
  } catch (e) {
    await d.db.payment.update({ where: { id: paymentId }, data: { status: "FAILED", providerStatus: "CREATE_FAILED", providerPayload: { error: String((e as Error)?.message ?? e) } } });
    throw new DomainError("PAYMENT_PROVIDER", "No pudimos iniciar el pago con PayPal. Intenta de nuevo.", { cause: String((e as Error)?.message ?? e) });
  }
}

export interface CaptureCompletedInput {
  captureId: string;
  paypalOrderId?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  raw?: unknown;
  /** return = URL de retorno; webhook = PAYMENT.CAPTURE.COMPLETED; reconcile = job que consulta PayPal. */
  source: "webhook" | "return" | "reconcile";
}

/**
 * PAYMENT.CAPTURE.COMPLETED (webhook) o captura exitosa en el return URL. Idempotente: puede llegar
 * dos veces (o las dos a la vez); solo la primera aplica el pago y dispara la matrícula.
 */
export async function onPaypalCaptureCompleted(d: Deps, input: CaptureCompletedInput): Promise<{ alreadyProcessed: boolean; orderId: string; paymentId: string }> {
  const now = d.now();
  const actor: Actor = { type: input.source === "webhook" ? "WEBHOOK" : input.source === "reconcile" ? "SYSTEM" : "CUSTOMER" };
  const p =
    (await d.db.payment.findUnique({ where: { paypalCaptureId: input.captureId } })) ??
    (input.paypalOrderId ? await d.db.payment.findUnique({ where: { paypalOrderId: input.paypalOrderId } }) : null);
  if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura de PayPal.", { captureId: input.captureId, paypalOrderId: input.paypalOrderId });

  const out = await withTx(d, async (tx) => {
    const amount = input.amountCents ?? p.amountCents;
    const claimed = await tx.payment.updateMany({
      where: { id: p.id, status: { in: ["PENDING", "FAILED", "CANCELLED"] } },
      data: { status: "COMPLETED", paypalCaptureId: input.captureId, providerStatus: "COMPLETED", paidAt: now, amountCents: amount, amountUsdCents: amount, providerPayload: (input.raw as object) ?? undefined },
    });
    if (claimed.count !== 1) return null;
    await addOrderEvent(tx, p.orderId, "PAYMENT_CAPTURED", actor, `PayPal ${input.captureId} (${{ webhook: "webhook", return: "retorno", reconcile: "conciliación" }[input.source]})`, { paymentId: p.id, captureId: input.captureId, amountCents: amount });
    if (amount !== p.amountCents) {
      await addOrderEvent(tx, p.orderId, "ATTENTION", SYSTEM, `El monto capturado (${(amount / 100).toFixed(2)}) difiere del esperado (${(p.amountCents / 100).toFixed(2)}).`, { paymentId: p.id });
    }
    return applyConfirmedPayment(tx, p.id, actor, now);
  });
  if (!out) return { alreadyProcessed: true, orderId: p.orderId, paymentId: p.id };
  await afterPaymentApplied(d, p.id, out, "paypal");
  return { alreadyProcessed: false, orderId: p.orderId, paymentId: p.id };
}

export async function onPaypalCaptureDenied(d: Deps, input: { captureId?: string | null; paypalOrderId?: string | null; raw?: unknown; source: "webhook" | "return" | "reconcile" }) {
  const p =
    (input.captureId ? await d.db.payment.findUnique({ where: { paypalCaptureId: input.captureId } }) : null) ??
    (input.paypalOrderId ? await d.db.payment.findUnique({ where: { paypalOrderId: input.paypalOrderId } }) : null);
  if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura de PayPal.");
  await withTx(d, async (tx) => {
    const n = await tx.payment.updateMany({
      where: { id: p.id, status: { in: ["PENDING", "CANCELLED"] } },
      data: { status: "FAILED", providerStatus: "DENIED", paypalCaptureId: input.captureId ?? p.paypalCaptureId, providerPayload: (input.raw as object) ?? undefined },
    });
    if (n.count === 1) await addOrderEvent(tx, p.orderId, "PAYMENT_FAILED", { type: input.source === "webhook" ? "WEBHOOK" : input.source === "reconcile" ? "SYSTEM" : "CUSTOMER" }, "PayPal rechazó el pago", { paymentId: p.id });
  });
  return { orderId: p.orderId, paymentId: p.id };
}

export type ReturnCaptureStatus = "COMPLETED" | "PENDING" | "FAILED";

/** Return URL de PayPal (?token=<paypalOrderId>): captura la orden. Si el webhook llegó antes, no duplica nada. */
export async function capturePaypalReturn(d: Deps, paypalOrderId: string, source: "return" | "reconcile" | "webhook" = "return"): Promise<{ status: ReturnCaptureStatus; orderId: string; orderToken: string }> {
  const p = await d.db.payment.findUnique({ where: { paypalOrderId }, include: { order: { select: { token: true } } } });
  if (!p) throw new DomainError("NOT_FOUND", "No encontramos ese pago de PayPal.");
  const done = (status: ReturnCaptureStatus) => ({ status, orderId: p.orderId, orderToken: p.order.token });
  if (p.status === "COMPLETED" || p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED") return done("COMPLETED");

  let res;
  try {
    res = normalizeCapture(await d.paypal.captureOrder(paypalOrderId));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/ORDER_ALREADY_CAPTURED/i.test(msg)) {
      const again = await d.db.payment.findUniqueOrThrow({ where: { id: p.id } });
      return done(again.status === "COMPLETED" ? "COMPLETED" : "PENDING");
    }
    if (/INSTRUMENT_DECLINED|PAYER_ACTION_REQUIRED|UNPROCESSABLE/i.test(msg)) return done("FAILED");
    throw new DomainError("PAYMENT_PROVIDER", "PayPal no respondió al confirmar el pago. Si se debitó, lo confirmaremos automáticamente.", { cause: msg });
  }
  const capStatus = (res.captureStatus ?? res.status).toUpperCase();
  if (capStatus === "COMPLETED" && res.captureId) {
    await onPaypalCaptureCompleted(d, { captureId: res.captureId, paypalOrderId, amountCents: res.amountCents, currency: res.currency, raw: res.raw, source });
    return done("COMPLETED");
  }
  if (capStatus === "PENDING") {
    await markCapturePending(d, p.id, res.captureId ?? null);
    return done("PENDING");
  }
  await onPaypalCaptureDenied(d, { captureId: res.captureId, paypalOrderId, raw: res.raw, source });
  return done("FAILED");
}

/**
 * PayPal retuvo la captura (revisión, eCheck…): el pago sigue PENDING con providerStatus CAPTURE_PENDING.
 * Queda en el historial del pedido (visible para el cliente y el panel) y el pedido NO vence mientras tanto.
 */
async function markCapturePending(d: Deps, paymentId: string, captureId: string | null) {
  await withTx(d, async (tx) => {
    const n = await tx.payment.updateMany({
      where: { id: paymentId, status: "PENDING", NOT: { providerStatus: "CAPTURE_PENDING" } },
      data: { providerStatus: "CAPTURE_PENDING", ...(captureId ? { paypalCaptureId: captureId } : {}) },
    });
    if (n.count === 1) {
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      await addOrderEvent(tx, p.orderId, "PAYMENT_PENDING_REVIEW", SYSTEM, "PayPal retuvo el pago para revisión. Tu cupo se mantiene; te avisaremos al confirmarse.", { paymentId, captureId });
    }
  });
}

export type PaypalSyncResult = ReturnCaptureStatus | "NOT_APPROVED" | "VOIDED" | "SKIPPED";

/**
 * Consulta la orden en PayPal y la lleva a término: APPROVED → captura; COMPLETED → aplica la captura
 * (COMPLETED) o la marca pendiente/denegada; VOIDED → cancela el pago. Cubre al comprador que aprueba y
 * cierra la pestaña antes del retorno (sin retorno no hay captura y, por tanto, tampoco webhook).
 */
export async function syncPaypalOrder(d: Deps, paypalOrderId: string): Promise<PaypalSyncResult> {
  const p = await d.db.payment.findUnique({ where: { paypalOrderId } });
  if (!p) throw new DomainError("NOT_FOUND", "No encontramos ese pago de PayPal.");
  if (p.status !== "PENDING") return "SKIPPED";
  const o = normalizeCapture(await d.paypal.getOrder(paypalOrderId));
  const status = o.status.toUpperCase();
  if (status === "APPROVED") return (await capturePaypalReturn(d, paypalOrderId, "reconcile")).status;
  if (status === "COMPLETED") {
    const cap = (o.captureStatus ?? "").toUpperCase();
    if (cap === "COMPLETED" && o.captureId) {
      await onPaypalCaptureCompleted(d, { captureId: o.captureId, paypalOrderId, amountCents: o.amountCents, currency: o.currency, raw: o.raw, source: "reconcile" });
      return "COMPLETED";
    }
    if (cap === "PENDING") {
      await markCapturePending(d, p.id, o.captureId ?? null);
      return "PENDING";
    }
    await onPaypalCaptureDenied(d, { captureId: o.captureId, paypalOrderId, raw: o.raw, source: "reconcile" });
    return "FAILED";
  }
  if (status === "VOIDED") {
    await d.db.payment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "CANCELLED", providerStatus: "VOIDED" } });
    return "VOIDED";
  }
  return "NOT_APPROVED"; // CREATED / PAYER_ACTION_REQUIRED: el comprador aún no aprueba
}

/**
 * Job: concilia pagos PayPal PENDING con orden creada (aprobados sin captura o captura retenida).
 * Solo toca los creados hace más de `minAgeMs`, para no competir con el retorno en curso (aun así, la
 * captura y su aplicación son idempotentes).
 */
export async function reconcilePaypalPayments(d: Deps, opts: { minAgeMs?: number; maxAgeMs?: number } = {}) {
  const now = d.now().getTime();
  const rows = await d.db.payment.findMany({
    where: {
      method: "PAYPAL",
      status: "PENDING",
      paypalOrderId: { not: null },
      createdAt: { lte: new Date(now - (opts.minAgeMs ?? 2 * 60_000)), gte: new Date(now - (opts.maxAgeMs ?? 30 * 24 * 3600_000)) },
    },
    select: { paypalOrderId: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const out: Record<string, number> = { checked: rows.length, captured: 0, pending: 0, failed: 0, errors: 0 };
  for (const r of rows) {
    try {
      const s = await syncPaypalOrder(d, r.paypalOrderId!);
      if (s === "COMPLETED") out.captured++;
      else if (s === "PENDING") out.pending++;
      else if (s === "FAILED") out.failed++;
    } catch (e) {
      out.errors++;
      d.log.warn(`[paypal] no se pudo conciliar ${r.paypalOrderId}`, e);
    }
  }
  return out;
}

const cents = (v: unknown): number | undefined => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

/**
 * Webhook de PayPal: verifica firma, registra el evento (idempotencia por event id) y lo despacha.
 * Devuelve `retry: true` solo ante errores transitorios (la ruta debe responder 5xx para que PayPal reintente).
 */
export async function handlePaypalWebhook(d: Deps, headers: Record<string, string | string[] | undefined> | Headers, rawBody: string) {
  const verified = await d.paypal.verifyWebhookSignature(headers, rawBody);
  if (!verified) throw new DomainError("UNAUTHORIZED", "Firma de webhook inválida.");
  let evt: { id?: string; event_type?: string; resource?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    evt = JSON.parse(rawBody);
  } catch {
    throw new DomainError("VALIDATION", "Cuerpo de webhook inválido.");
  }
  if (!evt.id || !evt.event_type) throw new DomainError("VALIDATION", "Evento de webhook incompleto.");
  const resource = evt.resource ?? {};

  let row = await d.db.webhookEvent.findUnique({ where: { eventId: evt.id } });
  if (row?.processedAt) return { ok: true, duplicate: true, eventType: evt.event_type, retry: false };
  if (!row) {
    try {
      row = await d.db.webhookEvent.create({ data: { provider: "paypal", eventId: evt.id, eventType: evt.event_type, resourceId: resource.id ?? null, payload: evt as object, verified: true } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return { ok: true, duplicate: true, eventType: evt.event_type, retry: false };
    }
  }

  try {
    switch (evt.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        await onPaypalCaptureCompleted(d, {
          captureId: resource.id,
          paypalOrderId: resource.supplementary_data?.related_ids?.order_id ?? null,
          amountCents: cents(resource.amount?.value),
          currency: resource.amount?.currency_code,
          raw: resource,
          source: "webhook",
        });
        break;
      case "CHECKOUT.ORDER.APPROVED":
        // El comprador aprobó: capturar aunque no vuelva al sitio (idempotente con el retorno).
        if (!resource.id) throw new DomainError("VALIDATION", "Orden aprobada sin id.");
        await capturePaypalReturn(d, String(resource.id), "webhook");
        break;
      case "PAYMENT.CAPTURE.PENDING": {
        const orderId = resource.supplementary_data?.related_ids?.order_id ?? null;
        const p = orderId ? await d.db.payment.findUnique({ where: { paypalOrderId: orderId } }) : null;
        if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura de PayPal.");
        await markCapturePending(d, p.id, resource.id ?? null);
        break;
      }
      case "PAYMENT.CAPTURE.DENIED":
        await onPaypalCaptureDenied(d, { captureId: resource.id, paypalOrderId: resource.supplementary_data?.related_ids?.order_id ?? null, raw: resource, source: "webhook" });
        break;
      case "PAYMENT.CAPTURE.REFUNDED": {
        const up = (resource.links as { rel: string; href: string }[] | undefined)?.find((l) => l.rel === "up")?.href ?? "";
        const captureId = up.match(/captures\/([^/?]+)/)?.[1] ?? resource.capture_id ?? null;
        if (!captureId) throw new DomainError("VALIDATION", "Reembolso sin captura asociada.");
        await onPaypalRefundCompleted(d, { captureId, refundId: resource.id, amountCents: cents(resource.amount?.value), reason: resource.note_to_payer ?? null });
        break;
      }
      default:
        break; // eventos no usados: se registran y se ignoran
    }
    await d.db.webhookEvent.update({ where: { id: row.id }, data: { processedAt: d.now(), error: null } });
    return { ok: true, duplicate: false, eventType: evt.event_type, retry: false };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    if (isDomainError(e)) {
      // Error permanente (pago desconocido, datos inválidos): se registra y no se reintenta.
      await d.db.webhookEvent.update({ where: { id: row.id }, data: { processedAt: d.now(), error: msg } });
      return { ok: false, duplicate: false, eventType: evt.event_type, retry: false, error: msg };
    }
    await d.db.webhookEvent.update({ where: { id: row.id }, data: { error: msg } });
    return { ok: false, duplicate: false, eventType: evt.event_type, retry: true, error: msg };
  }
}

// ───────────── Reembolsos ─────────────

export interface RefundInput {
  paymentId: string;
  /** USD en centavos; por defecto todo lo reembolsable del pago. */
  amountCents?: number;
  reason?: string | null;
  adminId?: string | null;
  /** Registrar un reembolso hecho fuera del sistema (obligatorio en métodos manuales). */
  manual?: boolean;
  /** Desmatricular de Moodle. Por defecto: sí cuando el pedido queda reembolsado por completo. */
  unenroll?: boolean;
  /** Liberar el cupo de la cohorte. Por defecto: sí cuando el pedido queda reembolsado por completo. */
  releaseSeat?: boolean;
}

interface ApplyRefundInput {
  paymentId: string;
  amountCents: number;
  providerRefundId?: string | null;
  manual: boolean;
  reason?: string | null;
  adminId?: string | null;
  releaseSeat?: boolean;
  actor: Actor;
}

async function applyRefund(tx: Tx, input: ApplyRefundInput, now: Date) {
  const p = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
  if (input.providerRefundId) {
    // El otro camino (webhook PAYMENT.CAPTURE.REFUNDED o el panel) ya registró este mismo reembolso.
    const existing = await tx.refund.findUnique({ where: { providerRefundId: input.providerRefundId } });
    if (existing) {
      const o = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true } });
      return { refund: existing, fullyRefunded: o.status === "REFUNDED", orderId: p.orderId, duplicate: true as const };
    }
  }
  const refundable = p.amountUsdCents - p.refundedCents;
  if (input.amountCents > refundable) throw new DomainError("VALIDATION", `El monto supera lo reembolsable (${(refundable / 100).toFixed(2)} USD).`);
  const refund = await tx.refund.create({
    data: { paymentId: p.id, amountCents: input.amountCents, reason: input.reason ?? null, status: "COMPLETED", providerRefundId: input.providerRefundId ?? null, manual: input.manual, createdById: input.adminId ?? null, completedAt: now },
  });
  const refunded = p.refundedCents + input.amountCents;
  await tx.payment.update({ where: { id: p.id }, data: { refundedCents: refunded, status: refunded >= p.amountUsdCents ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
  const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
  await tx.order.update({ where: { id: order.id }, data: { amountPaidCents: order.amountPaidCents - input.amountCents } });
  const balance = await recomputeBalance(tx, order.id);
  await addOrderEvent(tx, order.id, "REFUND", input.actor, input.reason ?? null, { paymentId: p.id, refundId: refund.id, amountCents: input.amountCents, manual: input.manual, balanceCents: balance });

  const agg = await tx.payment.aggregate({ where: { orderId: order.id, status: { in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] } }, _sum: { amountUsdCents: true, refundedCents: true } });
  const fullyRefunded = (agg._sum.amountUsdCents ?? 0) > 0 && (agg._sum.refundedCents ?? 0) >= (agg._sum.amountUsdCents ?? 0);
  if (fullyRefunded) {
    if (input.releaseSeat !== false) await releaseOrderReservations(tx, order.id, "REFUNDED", now);
    if (["PAID", "PARTIALLY_PAID", "ENROLLED"].includes(order.status)) {
      await transitionOrder(tx, order.id, "REFUNDED", { actor: input.actor, note: input.reason ?? "Reembolso total", patch: { cancelledAt: now } });
    }
  } else if (input.releaseSeat === true) {
    await releaseOrderReservations(tx, order.id, "REFUNDED", now);
  }
  return { refund, fullyRefunded, orderId: order.id, duplicate: false as const };
}

async function afterRefund(d: Deps, r: { refund: { id: string; amountCents: number; reason: string | null }; fullyRefunded: boolean; orderId: string }, method: PaymentMethod, unenroll: boolean | undefined, actor: Actor) {
  if (unenroll ?? r.fullyRefunded) {
    try {
      await unenrollOrder(d, r.orderId, actor);
    } catch (e) {
      d.log.error(`[refund] no se pudo desmatricular el pedido ${r.orderId}`, e);
      await d.db.$transaction((tx) => addOrderEvent(tx, r.orderId, "ATTENTION", SYSTEM, `No se pudo desmatricular en Moodle: ${String((e as Error)?.message ?? e)}`));
    }
  }
  await safeNotify(d, "refund_issued", async () => {
    const { view, email, customerId } = await buildOrderView(d, r.orderId);
    await sendEmail(d, { template: "refund_issued", to: email, rendered: T.refundIssued(view, { amountCents: r.refund.amountCents, methodLabel: T.METHOD_LABELS[method] ?? method, reason: r.refund.reason, full: r.fullyRefunded }), dedupeKey: `refund:${r.refund.id}`, orderId: r.orderId, customerId });
  });
}

/** Reembolso desde el panel: PayPal vía API (salvo `manual`), métodos manuales como registro. */
export async function refundPayment(d: Deps, input: RefundInput) {
  const now = d.now();
  const actor: Actor = input.adminId ? { type: "ADMIN", id: input.adminId } : SYSTEM;
  const p = await d.db.payment.findUnique({ where: { id: input.paymentId } });
  if (!p) throw new DomainError("NOT_FOUND", "El pago no existe.");
  if (p.status !== "COMPLETED" && p.status !== "PARTIALLY_REFUNDED") throw new DomainError("INVALID_STATE", "Solo se pueden reembolsar pagos confirmados.");
  const refundable = p.amountUsdCents - p.refundedCents;
  const amount = input.amountCents ?? refundable;
  if (!Number.isInteger(amount) || amount <= 0 || amount > refundable) throw new DomainError("VALIDATION", `El monto debe estar entre 0.01 y ${(refundable / 100).toFixed(2)} USD.`);

  const viaApi = p.method === "PAYPAL" && !input.manual;
  let providerRefundId: string | null = null;
  if (viaApi) {
    if (!p.paypalCaptureId) throw new DomainError("INVALID_STATE", "El pago PayPal no tiene captura asociada.");
    try {
      const partial = amount !== refundable || p.refundedCents > 0;
      const res = normalizeRefund(await d.paypal.refundCapture(p.paypalCaptureId, partial ? amount : undefined));
      if (res.status === "FAILED" || res.status === "CANCELLED") throw new Error(`PayPal devolvió estado ${res.status}`);
      providerRefundId = res.id;
    } catch (e) {
      await d.db.refund.create({ data: { paymentId: p.id, amountCents: amount, reason: input.reason ?? null, status: "FAILED", manual: false, createdById: input.adminId ?? null } });
      throw new DomainError("PAYMENT_PROVIDER", "PayPal no procesó el reembolso.", { cause: String((e as Error)?.message ?? e) });
    }
  } else if (p.method === "PAYPAL" && input.manual) {
    // registro manual explícito de un reembolso PayPal hecho desde el dashboard
  }

  let result;
  try {
    result = await withTx(d, (tx) =>
      applyRefund(tx, { paymentId: p.id, amountCents: amount, providerRefundId, manual: !viaApi, reason: input.reason, adminId: input.adminId, releaseSeat: input.releaseSeat, actor }, now),
    );
  } catch (e) {
    // Carrera con el webhook PAYMENT.CAPTURE.REFUNDED que registró este mismo reembolso primero.
    if (providerRefundId && isUniqueViolation(e)) {
      const existing = await d.db.refund.findUniqueOrThrow({ where: { providerRefundId } });
      const o = await d.db.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true } });
      result = { refund: existing, fullyRefunded: o.status === "REFUNDED", orderId: p.orderId, duplicate: true as const };
    } else throw e;
  }
  if (result.duplicate) {
    // PayPal ya lo había notificado: el reembolso SÍ se hizo. Se deja constancia de quién lo pidió; la
    // desmatrícula y el correo ya los hizo el webhook (salvo que el admin pidiera desmatricular en uno parcial).
    await withTx(d, (tx) => addOrderEvent(tx, p.orderId, "NOTE", actor, `Reembolso PayPal ${providerRefundId} solicitado desde el panel (ya registrado por el webhook de PayPal).`, { refundId: result.refund.id }));
    if (input.unenroll === true && !result.fullyRefunded) await afterRefund(d, result, p.method, true, actor);
    return result;
  }
  await afterRefund(d, result, p.method, input.unenroll, actor);
  return result;
}

/** Webhook PAYMENT.CAPTURE.REFUNDED: registra reembolsos hechos desde PayPal (o confirma los nuestros). */
export async function onPaypalRefundCompleted(d: Deps, input: { captureId: string; refundId: string; amountCents?: number; reason?: string | null }) {
  if (await d.db.refund.findUnique({ where: { providerRefundId: input.refundId } })) return { duplicate: true };
  const p = await d.db.payment.findUnique({ where: { paypalCaptureId: input.captureId } });
  if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura.");
  const amount = Math.min(input.amountCents ?? p.amountUsdCents - p.refundedCents, p.amountUsdCents - p.refundedCents);
  if (amount <= 0) return { duplicate: true };
  const actor: Actor = { type: "WEBHOOK" };
  let result;
  try {
    result = await withTx(d, (tx) => applyRefund(tx, { paymentId: p.id, amountCents: amount, providerRefundId: input.refundId, manual: false, reason: input.reason ?? "Reembolso registrado por PayPal", actor }, d.now()));
  } catch (e) {
    if (isUniqueViolation(e)) return { duplicate: true };
    throw e;
  }
  if (result.duplicate) return { duplicate: true }; // el panel lo registró mientras tanto
  await afterRefund(d, result, "PAYPAL", undefined, actor);
  return result;
}
