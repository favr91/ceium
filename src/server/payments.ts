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
import sharp from "sharp";
import type { Currency, Modality, PaymentMethod, Prisma, Refund } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import { readSetting, withTx } from "@/server/deps";
import { DomainError, isDomainError, isUniqueViolation } from "@/server/errors";
import { normalizeCapture, normalizeRefund } from "@/server/ports";
import {
  addOrderEvent,
  CLOSED_STATES,
  flagUnderpaidOrder,
  PAID_STATES,
  PREPAID_STATES,
  recomputeBalance,
  reservationTtlMs,
  getManualMethod,
  lockOrder,
  SYSTEM,
  transitionOrder,
  type Actor,
} from "@/server/orders";
import { acquireSeat, confirmReservation, releaseExpiredForCohort, releaseOrderReservations } from "@/server/seats";
import { manualMethodProblems, SETTING_KEYS } from "@/server/settings";
import { closePendingEnrollments, enrollOrder, unenrollOrder, UNENROLLMENT_FAILED } from "@/server/enrollment";
import { reallocateInstallments } from "@/server/installments";
import { buildOrderView, buildPaymentView, safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import { can, requireAdmin, type SessionUser } from "@/server/auth";

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
  const { orderId: lockedOrderId } = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { orderId: true } });
  await lockOrder(tx, lockedOrderId, now);
  const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { items: { include: { reservation: true } } } });
  const result: ApplyResult = { orderId: order.id, firstPaymentSatisfied: false, seatProblem: false, closedOrder: false, shouldEnroll: false };

  // Incremento atómico (no "leído + monto"): dos confirmaciones concurrentes del mismo pedido no se pisan.
  const { amountPaidCents: amountPaid } = await tx.order.update({
    where: { id: order.id },
    data: { amountPaidCents: { increment: p.amountUsdCents }, paidAt: order.paidAt ?? now },
    select: { amountPaidCents: true },
  });
  const balance = await recomputeBalance(tx, order.id);

  // Imputar a cuotas (en orden de secuencia; ver installments.ts).
  const realloc = await reallocateInstallments(tx, order.id, now);
  if (!p.installmentId && realloc.becamePaid[0]) await tx.payment.update({ where: { id: p.id }, data: { installmentId: realloc.becamePaid[0].id } });
  // Mes a mes: cada cuota pagada habilita SU curso del diplomado (y solo ese).
  const unlockedCourses = realloc.becamePaid.filter((i) => i.moodleCourseId != null);

  await addOrderEvent(tx, order.id, "PAYMENT_RECEIVED", actor, `${T.METHOD_LABELS[p.method] ?? p.method}: ${(p.amountUsdCents / 100).toFixed(2)} USD`, {
    paymentId: p.id,
    amountUsdCents: p.amountUsdCents,
    amountPaidCents: amountPaid,
    balanceCents: balance,
    installmentsPaid: realloc.becamePaid.map((i) => i.sequence),
  });

  if (order.status === "CANCELLED" || order.status === "REFUNDED") {
    result.closedOrder = true;
    await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, "Se recibió un pago en un pedido cerrado: requiere reembolso o reapertura manual.", { paymentId: p.id });
    return result;
  }

  if (PREPAID_STATES.includes(order.status)) {
    if (amountPaid >= order.dueNowCents) {
      result.firstPaymentSatisfied = true;
      const r = await satisfyFirstPayment(tx, order.id, actor, now, { balanceCents: balance });
      result.seatProblem = r.seatProblem;
      result.shouldEnroll = !result.seatProblem;
      // Otro pago del mismo primer pago sigue en verificación (p.ej. PayPal cobrado a la vez que se registraba un
      // pago móvil): el médico pagó dos veces. El staff debe rechazar ese comprobante o devolver el dinero.
      const others = await tx.payment.findMany({ where: { orderId: order.id, id: { not: p.id }, status: "AWAITING_VERIFICATION" }, select: { id: true, method: true, reference: true, amountUsdCents: true } });
      if (others.length > 0) {
        const refs = others.map((a) => `${T.METHOD_LABELS[a.method] ?? a.method} ref. ${a.reference ?? "—"} (${(a.amountUsdCents / 100).toFixed(2)} USD)`).join(", ");
        await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, `El pedido quedó pagado, pero hay otro pago por verificar: ${refs}. Si también se cobró, recházalo y devuelve el dinero (o apruébalo y reembolsa el excedente).`, {
          paymentId: p.id,
          awaitingPaymentIds: others.map((a) => a.id),
        });
      }
    } else {
      const stillAwaiting = await tx.payment.count({ where: { orderId: order.id, status: "AWAITING_VERIFICATION" } });
      if (order.status === "AWAITING_VERIFICATION" && stillAwaiting === 0) {
        await transitionOrder(tx, order.id, "PENDING_PAYMENT", {
          actor,
          note: `Pago insuficiente para el primer pago: faltan ${((order.dueNowCents - amountPaid) / 100).toFixed(2)} USD`,
        });
      }
      // Dinero cobrado que no alcanza el primer pago: el cupo queda protegido (seats.ts) y el staff lo ve.
      await flagUnderpaidOrder(tx, order.id, actor);
    }
  } else if (order.status === "PARTIALLY_PAID" && balance <= 0) {
    await transitionOrder(tx, order.id, "PAID", { actor, note: "Saldo cancelado por completo" });
  }
  if (PAID_STATES.includes(order.status) && order.status !== "ENROLLED") result.shouldEnroll = true;
  if (PAID_STATES.includes(order.status) && unlockedCourses.length > 0) {
    result.shouldEnroll = true;
    await addOrderEvent(tx, order.id, "INSTALLMENT_PAID", actor, `Cuota(s) ${unlockedCourses.map((i) => i.sequence).join(", ")} pagada(s): se habilita el siguiente curso del diplomado`, {
      installments: unlockedCourses.map((i) => ({ id: i.id, sequence: i.sequence, moodleCourseId: i.moodleCourseId })),
    });
  }
  return result;
}

/**
 * Primer pago cubierto (por un pago confirmado o por una condonación del admin): adopta el nombre del
 * comprador, convierte las reservas en cupos ocupados (o los vuelve a tomar si vencieron) y pasa el pedido a
 * PAID / PARTIALLY_PAID según el saldo. Devuelve seatProblem si alguna cohorte se llenó entretanto.
 */
export async function satisfyFirstPayment(tx: Tx, orderId: string, actor: Actor, now: Date, opts: { balanceCents: number; note?: string }): Promise<{ seatProblem: boolean }> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { reservation: true } } } });
  let seatProblem = false;
  await adoptBuyerName(tx, order, actor);
  for (const it of order.items) {
    if (it.modality !== "SEMIPRESENCIAL" || !it.reservation) continue;
    const r = await confirmReservation(tx, it.reservation.id, now);
    if (!r.ok) {
      seatProblem = true;
      await addOrderEvent(tx, order.id, "SEAT_UNAVAILABLE", SYSTEM, `La cohorte de «${it.productTitle}» se llenó antes de confirmar el pago: reasigna la cohorte (o vuelve a tomar cupo en la misma cuando se libere) o reembolsa.`, { orderItemId: it.id, cohortId: it.cohortId });
    } else if (r.reacquired) {
      await addOrderEvent(tx, order.id, "SEAT_REACQUIRED", SYSTEM, `Cupo vuelto a tomar para «${it.productTitle}» (la reserva había vencido).`, { orderItemId: it.id });
    }
  }
  const to = opts.balanceCents <= 0 ? "PAID" : "PARTIALLY_PAID";
  await transitionOrder(tx, order.id, to, { actor, note: opts.note ?? (to === "PAID" ? "Pago total recibido" : "Primer pago recibido; queda saldo pendiente") });
  await flagDuplicatePurchase(tx, order.id);
  return { seatProblem };
}

/**
 * El mismo cliente (mismo correo) ya tiene OTRO pedido vivo del mismo programa: cupo en la misma cohorte (pagado
 * o reservado) o, en online, el mismo producto ya pagado. Típico: registró el pago móvil y, mientras se verificaba,
 * volvió a comprar con PayPal para entrar ya; o compró dos veces. Nada lo impedía: dos cobros y dos cupos de la
 * cohorte para una sola persona (una sola cuenta de Moodle) sin que el staff se enterara. No se bloquea el pago (el
 * dinero ya entró); se deja un ATTENTION en ambos pedidos, nombrando el otro, para rechazar/reembolsar uno.
 */
async function flagDuplicatePurchase(tx: Tx, orderId: string): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { id: true, number: true, customerId: true, items: { select: { productId: true, productTitle: true, modality: true, cohortId: true } } } });
  const seen = new Set<string>();
  for (const it of o.items) {
    const others =
      it.modality === "SEMIPRESENCIAL" && it.cohortId
        ? (
            await tx.seatReservation.findMany({
              where: { cohortId: it.cohortId, status: { in: ["HELD", "CONFIRMED"] }, orderId: { not: o.id }, order: { customerId: o.customerId } },
              select: { status: true, cohort: { select: { name: true } }, order: { select: { id: true, number: true } } },
            })
          ).map((r) => ({ id: r.order.id, number: r.order.number, paid: r.status === "CONFIRMED", where: `la cohorte ${r.cohort.name}` }))
        : (
            await tx.order.findMany({
              where: { id: { not: o.id }, customerId: o.customerId, status: { in: [...PAID_STATES] }, items: { some: { productId: it.productId, modality: it.modality } } },
              select: { id: true, number: true },
            })
          ).map((x) => ({ ...x, paid: true, where: `«${it.productTitle}» (online)` }));
    for (const other of others) {
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      const dup = { duplicateOf: other.id, duplicateNumber: other.number, productId: it.productId, cohortId: it.cohortId };
      await addOrderEvent(
        tx,
        o.id,
        "ATTENTION",
        SYSTEM,
        other.paid
          ? `Probable compra duplicada: este cliente ya tiene ${it.modality === "SEMIPRESENCIAL" ? "cupo pagado" : "pagado"} ${it.modality === "SEMIPRESENCIAL" ? "en " : ""}${other.where} por el pedido #${other.number}. Cobró dos veces${it.modality === "SEMIPRESENCIAL" ? " y ocupa dos cupos" : ""}: reembolsa uno de los dos pedidos (liberando su cupo).`
          : `Probable compra duplicada: este cliente tiene además el pedido #${other.number} con cupo reservado en ${other.where}. Si también paga ese pedido, rechaza su comprobante o reembolsa; si no, cancélalo para liberar el cupo.`,
        dup,
      );
      await addOrderEvent(
        tx,
        other.id,
        "ATTENTION",
        SYSTEM,
        other.paid
          ? `Probable compra duplicada: el cliente volvió a pagar ${other.where} en el pedido #${o.number}. Cobró dos veces${it.modality === "SEMIPRESENCIAL" ? " y ocupa dos cupos" : ""}: reembolsa uno de los dos pedidos (liberando su cupo).`
          : `Probable compra duplicada: el cliente ya pagó ${other.where} en el pedido #${o.number}. No apruebes el comprobante de este pedido sin revisarlo: si también se cobró, recházalo y devuelve el dinero; si no, cancela este pedido para liberar el cupo.`,
        { duplicateOf: o.id, duplicateNumber: o.number, productId: it.productId, cohortId: it.cohortId },
      );
    }
  }
}

/**
 * El checkout no está autenticado: el nombre escrito solo pasa al cliente (Moodle y certificado) si este
 * pedido es su PRIMERA compra pagada y aún no tiene cuenta de Moodle. Si no, se conserva el registrado y
 * se avisa al panel cuando difieren.
 */
async function adoptBuyerName(tx: Tx, order: { id: string; customerId: string; buyerFirstName: string | null; buyerLastName: string | null }, actor: Actor) {
  if (!order.buyerFirstName || !order.buyerLastName) return;
  const c = await tx.customer.findUniqueOrThrow({ where: { id: order.customerId } });
  if (c.firstName === order.buyerFirstName && c.lastName === order.buyerLastName) return;
  const otherPaid = await tx.order.count({
    where: { customerId: c.id, id: { not: order.id }, OR: [{ amountPaidCents: { gt: 0 } }, { status: { in: [...PAID_STATES, "REFUNDED"] } }] },
  });
  if (otherPaid === 0 && c.moodleUserId == null) {
    await tx.customer.update({ where: { id: c.id }, data: { firstName: order.buyerFirstName, lastName: order.buyerLastName } });
    await addOrderEvent(tx, order.id, "CUSTOMER_UPDATED", actor, `Nombre del cliente: ${c.firstName} ${c.lastName} → ${order.buyerFirstName} ${order.buyerLastName} (primera compra pagada)`);
    return;
  }
  await addOrderEvent(
    tx,
    order.id,
    "ATTENTION",
    SYSTEM,
    `El nombre escrito en este pedido (${order.buyerFirstName} ${order.buyerLastName}) difiere del registrado (${c.firstName} ${c.lastName}). Se conserva el registrado para Moodle y el certificado; corrígelo desde el panel si corresponde.`,
  );
}

async function afterPaymentApplied(d: Deps, paymentId: string, res: ApplyResult, kind: "paypal" | "manual") {
  const orderId = res.orderId;
  if (res.closedOrder) return; // pedido cerrado: nada que confirmar al cliente (el panel decide / se reembolsa)
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
  /**
   * VES por USD. Solo la usa el panel (adminRecordManualPayment). Para el cliente SIEMPRE se aplica la tasa
   * configurada; la que escriba queda solo como dato declarado en el historial del pedido.
   */
  exchangeRate?: number | string | null;
  paidAt?: Date | null;
  proofFile?: string | null;
  payerName?: string | null;
  payerPhone?: string | null;
  payerCedula?: string | null;
}

const MANUAL_METHODS: PaymentMethod[] = ["PAGO_MOVIL", "TRANSFERENCIA", "ZELLE", "EFECTIVO"];

/** Clave única de una referencia de pago manual (sin espacios ni guiones, en mayúsculas). */
export function manualReferenceKey(method: PaymentMethod, reference: string | null): string | null {
  const norm = canonicalReference(reference);
  return norm ? `${referenceGroup(method)}:${norm}` : null;
}

/**
 * Pago móvil y transferencia son movimientos en bolívares de las mismas cuentas: una referencia es única entre
 * ambos (antes la clave llevaba el método y el mismo pago móvil se podía registrar otra vez «como transferencia»).
 */
function referenceGroup(method: PaymentMethod): string {
  return method === "PAGO_MOVIL" || method === "TRANSFERENCIA" ? "BS" : method;
}

/** Claves con las que pudo guardarse la misma referencia (incluye el formato anterior, con el método). */
function referenceKeyVariants(method: PaymentMethod, reference: string | null): string[] {
  const norm = canonicalReference(reference);
  if (!norm) return [];
  const legacy = referenceGroup(method) === "BS" ? ["PAGO_MOVIL", "TRANSFERENCIA"] : [method];
  return [`${referenceGroup(method)}:${norm}`, ...legacy.map((m) => `${m}:${norm}`)];
}

/**
 * Forma canónica de una referencia bancaria: sin espacios, puntos ni guiones, en mayúsculas y, si es numérica,
 * sin ceros a la izquierda («000123456» y «123456» son el mismo movimiento: cada banco la muestra con otro
 * relleno). Sin esto, la misma referencia con ceros delante pasaba el índice único y el panel la daba por nueva.
 */
export function canonicalReference(reference: string | null | undefined): string {
  const norm = reference?.replace(/[\s.-]+/g, "").toUpperCase() ?? "";
  return /^\d+$/.test(norm) ? norm.replace(/^0+(?=\d)/, "") : norm;
}

/**
 * ¿Dos referencias pueden ser el mismo movimiento bancario? Iguales en forma canónica, o una termina en la otra
 * con al menos 6 caracteres (hay bancos que muestran solo los últimos dígitos). Solo para AVISAR en el panel.
 */
export function sameBankMovement(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalReference(a);
  const y = canonicalReference(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.endsWith(short);
}

/**
 * Checkout público: registra un pago manual con comprobante → AWAITING_VERIFICATION (y el pedido también si
 * era el primer pago). El equivalente en USD se calcula SIEMPRE con la tasa configurada y la moneda del
 * método configurado: el cliente no puede fijar ninguna de las dos.
 */
export async function recordManualPayment(d: Deps, input: ManualPaymentInput) {
  try {
    return await recordManual(d, input, { type: "CUSTOMER" });
  } catch (e) {
    // El comprobante se guardó antes de validar (/pedido/<token>, /api/checkout/comprobante): si el pago no se
    // registra, no debe quedar huérfano en disco (datos personales del pagador sin pedido que los respalde).
    await discardProofFile(d, input.proofFile);
    throw e;
  }
}

async function discardProofFile(d: Deps, proofFile: string | null | undefined) {
  if (!proofFile) return;
  const root = path.resolve(d.config.privateFilesDir, "proofs") + path.sep;
  const abs = path.resolve(proofFile);
  if (!abs.startsWith(root)) return;
  if (await d.db.payment.findFirst({ where: { proofFile }, select: { id: true } })) return; // sí quedó registrado
  await fs.unlink(abs).catch(() => {});
}

/** Día (AAAA-MM-DD) en Venezuela: la fecha declarada del pago se compara en la zona del banco. */
const caracasDay = (t: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
/** Comprobantes del cliente en verificación a la vez por pedido (pago móvil con límite diario: 2–3 transferencias). */
const MAX_AWAITING_PER_ORDER = 3;
/** Un pago de más de este múltiplo de lo adeudado es casi seguro un error de tipeo (decimales, ceros de más). */
const MAX_OVERPAY_FACTOR = 10;

/** Pago manual registrado desde el panel (efectivo en sede, pago recibido por WhatsApp…). Puede fijar la tasa. */
export async function adminRecordManualPayment(d: Deps, user: SessionUser, input: ManualPaymentInput) {
  const admin = await requireAdmin(d.db, user, "payments.verify");
  return recordManual(d, input, { type: "ADMIN", id: admin.id });
}

async function recordManual(d: Deps, input: ManualPaymentInput, actor: Actor) {
  if (!MANUAL_METHODS.includes(input.method)) throw new DomainError("VALIDATION", "Método de pago manual no válido.");
  const isCustomer = actor.type !== "ADMIN";
  if (isCustomer) {
    // El efectivo lo registra el personal de la sede al recibirlo (el cliente no puede declararlo: dejaría el cupo
    // protegido sin haber pagado nada).
    if (input.method === "EFECTIVO") throw new DomainError("VALIDATION", "El pago en efectivo lo registra el personal de la sede al recibirlo.");
    const cfg = await getManualMethod(d, input.method);
    if (!cfg?.enabled || manualMethodProblems(cfg).length) throw new DomainError("VALIDATION", "El método de pago seleccionado no está disponible.");
    if (cfg.currency && cfg.currency !== input.currency) throw new DomainError("VALIDATION", `Este método se paga en ${cfg.currency === "VES" ? "bolívares" : "dólares"}.`, { field: "currency" });
  }
  if (input.currency !== "USD" && input.currency !== "VES") throw new DomainError("VALIDATION", "Moneda no válida.", { field: "currency" });
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new DomainError("VALIDATION", "Ingresa el monto pagado.", { field: "amountCents" });
  const reference = input.reference?.trim() || null;
  if (input.method !== "EFECTIVO" && !reference) throw new DomainError("VALIDATION", "Ingresa el número de referencia del pago.", { field: "reference" });
  if (isCustomer) {
    // Datos del pagador con largo razonable (se guardan y se muestran en el panel).
    const tooLong = ([["bank", input.bank, 80, "El banco"], ["payerName", input.payerName, 120, "El nombre del titular"], ["payerPhone", input.payerPhone, 30, "El teléfono"], ["payerCedula", input.payerCedula, 20, "El número de cédula o RIF"]] as const).find(
      ([, v, max]) => (v ?? "").length > max,
    );
    if (tooLong) throw new DomainError("VALIDATION", `${tooLong[3]} es demasiado largo.`, { field: tooLong[0] });
    // Mismas reglas que el checkout (manual-payment-fields.ts), aplicadas aquí para TODA entrada del cliente:
    // el formulario de /pedido/<token> también llega a este servicio.
    if (reference && !/^[A-Z0-9-]{4,30}$/.test(reference.replace(/[\s.]/g, "").toUpperCase())) {
      throw new DomainError("VALIDATION", "La referencia debe tener entre 4 y 30 dígitos o letras.", { field: "reference" });
    }
    if (input.paidAt != null) {
      if (!(input.paidAt instanceof Date) || Number.isNaN(input.paidAt.getTime())) throw new DomainError("VALIDATION", "Ingresa la fecha del pago.", { field: "paidAt" });
      const day = caracasDay(input.paidAt);
      const today = caracasDay(d.now());
      if (day > today) throw new DomainError("VALIDATION", "La fecha del pago no puede ser posterior a hoy.", { field: "paidAt" });
      if (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`) > 60 * 86_400_000) throw new DomainError("VALIDATION", "La fecha es de hace más de 60 días. Revísala o escríbenos.", { field: "paidAt" });
    }
  }
  const referenceKey = manualReferenceKey(input.method, reference);

  let rate: number | null = null;
  let declaredRate: number | null = null;
  let amountUsdCents = input.amountCents;
  if (input.currency === "VES") {
    const given = input.exchangeRate != null && input.exchangeRate !== "" ? Number(input.exchangeRate) : null;
    const configured = (await readSetting(d.db, SETTING_KEYS.exchangeRate, { vesPerUsd: 0 })).vesPerUsd;
    if (isCustomer) {
      rate = configured;
      if (given != null && given !== configured) declaredRate = Number.isFinite(given) ? given : null;
    } else {
      rate = given ?? configured;
    }
    if (!rate || !Number.isFinite(rate) || rate <= 0) throw new DomainError("VALIDATION", "Falta la tasa de cambio para pagos en bolívares.", { field: "exchangeRate" });
    amountUsdCents = Math.round(input.amountCents / rate);
    if (amountUsdCents <= 0) throw new DomainError("VALIDATION", "El monto es demasiado bajo.", { field: "amountCents" });
  }
  const configuredRate = rate;
  let quotedRate: QuotedRate | null = null;

  const now = d.now();
  const holdTtl = await reservationTtlMs(d, input.method);
  const duplicateRef = () => new DomainError("VALIDATION", "Esa referencia de pago ya fue registrada.", { field: "reference" });
  let paymentId: string;
  try {
    paymentId = await withTx(d, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId }, include: { items: { include: { reservation: true } } } });
    if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
    const acceptsFirst = PREPAID_STATES.includes(order.status);
    const acceptsInstallment = PAID_STATES.includes(order.status) && order.balanceCents > 0;
    if (!acceptsFirst && !acceptsInstallment) throw new DomainError("INVALID_STATE", "Este pedido no admite nuevos pagos.");
    if (isCustomer) {
      // Se serializa con las capturas de PayPal del mismo pedido (secureSeatBeforeCapture también bloquea el pedido).
      await lockOrder(tx, order.id, now);
      // PayPal ya retiene el dinero del primer pago o de la cuota (CAPTURE_PENDING): igual que startPaypalPayment, no se acepta
      // otro pago (p.ej. desde una pestaña del pedido abierta antes). Pagaría dos veces y, si el staff rechazaba ese
      // comprobante, el pedido se cerraba y liberaba el cupo con el dinero de PayPal aún retenido.
      const held = await tx.payment.findFirst({ where: { orderId: order.id, method: "PAYPAL", status: "PENDING", providerStatus: "CAPTURE_PENDING" }, select: { id: true } });
      if (held) throw new DomainError("INVALID_STATE", "PayPal está revisando tu pago anterior de este pedido. Te avisaremos por correo cuando se confirme; no hace falta pagar de nuevo.", { paymentId: held.id });
      // Una orden PayPal de este pedido se está capturando AHORA (el médico la aprobó hace instantes, p. ej. en otra
      // pestaña): ese cobro aún no está imputado; aceptar además este comprobante cobraría dos veces la misma cuota.
      const capturing = await tx.payment.findFirst({
        where: { orderId: order.id, method: "PAYPAL", providerStatus: CAPTURING, status: { in: ["PENDING", "CANCELLED"] }, updatedAt: { gte: new Date(now.getTime() - CAPTURING_LEASE_MS) } },
        select: { id: true },
      });
      if (capturing) throw new DomainError("INVALID_STATE", "Estamos confirmando con PayPal un pago de este pedido que aprobaste hace un momento. Espera unos minutos y revisa tu correo antes de registrar otro pago.", { paymentId: capturing.id });
      // Tope de comprobantes en verificación por pedido: el pago móvil tiene límite diario y un pago puede ir en
      // 2 o 3 transferencias, pero no más (cada uno guarda un archivo y avisa al equipo).
      const awaiting = await tx.payment.count({ where: { orderId: order.id, status: "AWAITING_VERIFICATION" } });
      if (awaiting >= MAX_AWAITING_PER_ORDER) {
        throw new DomainError("INVALID_STATE", `Ya tienes ${awaiting} pagos de este pedido en verificación. Espera a que el equipo los revise (te avisamos por correo) antes de registrar otro.`);
      }
    }
    if (isCustomer && input.currency === "VES" && configuredRate) {
      // La tasa pudo cambiar entre el monto que se le indicó al médico y el registro del comprobante.
      quotedRate = await quotedRateForPayment(tx, order, input.amountCents, configuredRate, input.paidAt ?? now, now, holdTtl);
      rate = quotedRate?.rate ?? configuredRate;
      amountUsdCents = Math.round(input.amountCents / rate);
    }
    if (isCustomer) {
      const owed = Math.max(order.totalCents - order.amountPaidCents, order.dueNowCents - order.amountPaidCents, 0);
      if (amountUsdCents > Math.max(owed, 100) * MAX_OVERPAY_FACTOR) {
        throw new DomainError("VALIDATION", "El monto es mucho mayor que el de tu pedido. Revisa los decimales y los ceros del monto que pagaste.", { field: "amountCents" });
      }
    }
    // Lectura para un error amable; la garantía real es el índice único de referenceKey (ver catch).
    if (referenceKey && (await tx.payment.findFirst({ where: { referenceKey: { in: referenceKeyVariants(input.method, reference) } }, select: { id: true } }))) throw duplicateRef();
    // Primer pago de un pedido cuyo cupo ya se liberó (venció o se rechazó el pago anterior; p.ej. la pestaña
    // del pedido quedó abierta y el médico envía el comprobante después del plazo): se vuelve a tomar el cupo
    // AHORA, en la misma transacción. Si no, el pedido quedaría «en verificación» sin cupo, otro comprador
    // podría ocuparlo y el admin aprobaría un pago sin plaza (correo «pago aprobado» y sin matrícula).
    if (acceptsFirst) {
      for (const it of order.items) {
        const r = it.reservation;
        if (it.modality !== "SEMIPRESENCIAL" || !r || r.status !== "RELEASED") continue;
        const open = isCustomer; // el panel puede registrar el pago aunque la cohorte ya no admita ventas
        let ok = await acquireSeat(tx, r.cohortId, "HELD", { requireOpen: open });
        if (!ok && (await releaseExpiredForCohort(tx, r.cohortId, now)) > 0) ok = await acquireSeat(tx, r.cohortId, "HELD", { requireOpen: open });
        if (!ok) {
          throw new DomainError(
            "SOLD_OUT",
            isCustomer
              ? "Tu reserva venció y esta cohorte ya no tiene cupos, así que no registramos el pago. Si ya lo hiciste, contáctanos y te ayudamos con otra cohorte o el reembolso."
              : `La reserva de «${it.productTitle}» se liberó y la cohorte ya no tiene cupo: reasigna la cohorte antes de registrar el pago.`,
            { cohortId: r.cohortId, orderItemId: it.id },
          );
        }
        await tx.seatReservation.update({ where: { id: r.id }, data: { status: "HELD", expiresAt: new Date(now.getTime() + holdTtl), releasedAt: null, releasedReason: null } });
        await addOrderEvent(tx, order.id, "SEAT_REACQUIRED", actor, `Cupo vuelto a tomar para «${it.productTitle}» al registrar el pago (la reserva se había liberado: ${r.releasedReason ?? "—"}).`, {
          orderItemId: it.id,
          cohortId: r.cohortId,
          previousReason: r.releasedReason,
        });
      }
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
        referenceKey,
        bank: input.bank?.trim() || null,
        payerName: input.payerName ?? null,
        payerPhone: input.payerPhone ?? null,
        payerCedula: input.payerCedula ?? null,
        paidAt: input.paidAt ?? now,
        proofFile: input.proofFile ?? null,
      },
    });
    await addOrderEvent(tx, order.id, "PAYMENT_SUBMITTED", actor, `${T.METHOD_LABELS[input.method]} ref. ${reference ?? "—"}`, {
      paymentId: p.id,
      amountCents: input.amountCents,
      currency: input.currency,
      amountUsdCents,
      ...(rate != null ? { exchangeRate: rate } : {}),
      ...(quotedRate ? { configuredExchangeRate: configuredRate, quotedRateSince: quotedRate.since.toISOString() } : {}),
      ...(declaredRate != null ? { declaredExchangeRate: declaredRate } : {}),
    });
    if (quotedRate) {
      await addOrderEvent(
        tx,
        order.id,
        "NOTE",
        SYSTEM,
        `Pago convertido con la tasa Bs. ${quotedRate.rate} por USD, vigente desde el ${quotedRate.since.toISOString().slice(0, 16).replace("T", " ")} UTC (el día declarado del pago), en vez de la actual (Bs. ${configuredRate}): el monto coincide con lo que se le indicó al médico con esa tasa.`,
        { paymentId: p.id, exchangeRate: quotedRate.rate, configuredExchangeRate: configuredRate },
      );
    }
    if (acceptsFirst && order.status !== "AWAITING_VERIFICATION") {
      await transitionOrder(tx, order.id, "AWAITING_VERIFICATION", { actor, note: "Comprobante recibido; pendiente de verificación", patch: { paymentMethod: input.method } });
    }
    return p.id;
    });
  } catch (e) {
    if (referenceKey && isUniqueViolation(e)) throw duplicateRef();
    throw e;
  }

  await safeNotify(d, "payment_under_verification", async () => {
    const { view, email, customerId } = await buildOrderView(d, input.orderId);
    await sendEmail(d, { template: "payment_under_verification", to: email, rendered: T.paymentUnderVerification(view, await buildPaymentView(d, paymentId)), dedupeKey: `payment_submitted:${paymentId}`, orderId: input.orderId, customerId });
  });
  return d.db.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

interface QuotedRate {
  rate: number;
  since: Date;
}

/**
 * La tasa BCV se actualiza a diario y el médico paga los bolívares que le indicó el correo del pedido (o la página
 * del pedido, o el recordatorio de cuota) con la tasa de ESE momento. Si el staff la actualiza antes de que el médico
 * registre el comprobante, convertir con la tasa nueva dejaba su pago «insuficiente»: el admin lo aprobaba y el pedido
 * quedaba pendiente, sin matrícula y con un correo «pago aprobado».
 *
 * Solo cuando el monto NO cubre lo adeudado con la tasa actual: se buscan las tasas configuradas (historial auditado
 * de la configuración) vigentes el día declarado del pago, nunca antes del pedido ni antes del plazo de verificación
 * manual (72 h). Si con alguna de ellas el monto cubre exactamente lo adeudado (con un margen pequeño hacia arriba:
 * el médico pagó lo que esa tasa le indicó), se usa la mayor de esas tasas. La tasa sigue saliendo de la
 * configuración, nunca del cliente; una tasa mal cargada un momento (p. ej. 18,7 por 187) no infla el pago porque el
 * resultado debe caer en ese margen.
 */
async function quotedRateForPayment(
  tx: Tx,
  order: { id: string; status: string; placedAt: Date; dueNowCents: number; amountPaidCents: number; balanceCents: number },
  amountCents: number,
  configured: number,
  paidAt: Date,
  now: Date,
  holdTtl: number,
): Promise<QuotedRate | null> {
  const targets: number[] = [];
  if (PREPAID_STATES.includes(order.status as never)) targets.push(order.dueNowCents - order.amountPaidCents);
  else {
    const next = await tx.installment.findFirst({ where: { orderId: order.id, status: { notIn: ["PAID", "WAIVED"] } }, orderBy: { sequence: "asc" }, select: { amountCents: true, paidCents: true } });
    if (next) targets.push(next.amountCents - next.paidCents);
    targets.push(order.balanceCents);
  }
  const owed = targets.filter((t) => t > 0);
  const atCurrent = Math.round(amountCents / configured);
  if (!owed.length || owed.every((t) => atCurrent >= t)) return null;

  const day = caracasDay(paidAt);
  const to = Math.min(Date.parse(`${day}T23:59:59.999-04:00`), now.getTime());
  const from = Math.max(Date.parse(`${day}T00:00:00-04:00`), order.placedAt.getTime(), now.getTime() - holdTtl);
  // Día declarado anterior al pedido o fuera del plazo de verificación: se convierte con la tasa actual.
  if (from > to) return null;

  // Historial: (desde cuándo rige, tasa). `updatedAt` del valor lo fija updateSetting con el reloj de la app.
  const rateOf = (v: unknown) => {
    const n = Number((v as { vesPerUsd?: unknown } | null)?.vesPerUsd);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const sinceOf = (v: unknown, fallback: number) => {
    const t = Date.parse(String((v as { updatedAt?: unknown } | null)?.updatedAt ?? ""));
    return Number.isFinite(t) ? t : fallback;
  };
  const logs = await tx.auditLog.findMany({ where: { entityType: "Setting", entityId: SETTING_KEYS.exchangeRate }, orderBy: { createdAt: "desc" }, take: 50, select: { createdAt: true, before: true, after: true } });
  const points = new Map<number, number>();
  for (const l of logs) {
    const a = rateOf(l.after);
    if (a) points.set(sinceOf(l.after, l.createdAt.getTime()), a);
    const b = rateOf(l.before);
    if (b) {
      const t = sinceOf(l.before, Number.NEGATIVE_INFINITY);
      if (!points.has(t)) points.set(t, b);
    }
  }
  const timeline = [...points.entries()].sort((x, y) => x[0] - y[0]);
  const candidates: QuotedRate[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const [since, r] = timeline[i];
    const until = i + 1 < timeline.length ? timeline[i + 1][0] : Number.POSITIVE_INFINITY;
    if (since <= to && until > from && r !== configured) candidates.push({ rate: r, since: new Date(Number.isFinite(since) ? since : from) });
  }
  candidates.sort((x, y) => y.rate - x.rate);
  for (const c of candidates) {
    const usd = Math.round(amountCents / c.rate);
    if (owed.some((t) => atCurrent < t && usd >= t && usd <= t + Math.max(100, Math.round(t * 0.02)))) return c;
  }
  return null;
}

/** Contenedor ISO-BMFF de la familia HEIF (caja `ftyp` con marca heic/heix/heif/mif1/msf1/hevc…). */
function isHeif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (ascii(4, 8) !== "ftyp") return false;
  const size = Math.min(bytes.byteLength, Math.max(16, (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]), 64);
  const brands = [ascii(8, 12)];
  for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, i + 4));
  if (brands.some((b) => b === "avif" || b === "avis")) return false; // AVIF también declara mif1 y los navegadores sí lo muestran
  return brands.some((b) => /^(hei[cfmsx]|hev[cmsx]|mif1|msf1)$/.test(b));
}

/** Guarda un comprobante en PRIVATE_FILES_DIR/proofs/<orderId>/… y devuelve la ruta para `proofFile`. */
export async function storeProofFile(d: Deps, orderId: string, filename: string, bytes: Uint8Array): Promise<string> {
  // Sin HEIC/HEIF: Chrome y Firefox no lo muestran en el panel y sharp no trae el códec HEVC para convertirlo. Se
  // mira también el contenido: una foto HEIC renombrada a .jpg tampoco se podría ver.
  if (/\.hei[cf]$/i.test(filename) || isHeif(bytes)) throw new DomainError("VALIDATION", "Las fotos HEIC del iPhone no se pueden revisar: envía una captura de pantalla (JPG o PNG) o un PDF.");
  if (!/\.(jpg|jpeg|png|webp|pdf)$/i.test(filename)) throw new DomainError("VALIDATION", "El comprobante debe ser una imagen (JPG, PNG o WEBP) o un PDF.");
  if (bytes.byteLength > 10 * 1024 * 1024) throw new DomainError("VALIDATION", "El comprobante no puede superar 10 MB.");
  // El tipo real sale del contenido, no del nombre: un archivo cualquiera renombrado a .jpg no entra.
  const kind = proofKind(bytes);
  if (!kind) throw new DomainError("VALIDATION", "El archivo no es una imagen (JPG, PNG o WEBP) ni un PDF válido.");
  let data: Uint8Array = bytes;
  if (kind !== "pdf") {
    // Las fotos se vuelven a codificar: se orientan, pierden los metadatos (ubicación GPS, modelo del teléfono) y
    // cualquier contenido extra escondido en el archivo. Hasta 2400 px de lado: la referencia se sigue leyendo.
    try {
      const img = sharp(bytes, { limitInputPixels: 100_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true });
      data = kind === "png" ? await img.png({ compressionLevel: 9 }).toBuffer() : kind === "webp" ? await img.webp({ quality: 90 }).toBuffer() : await img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    } catch {
      throw new DomainError("VALIDATION", "No pudimos leer la imagen del comprobante. Envía una captura de pantalla (JPG o PNG) o un PDF.");
    }
  }
  const dir = path.join(/* turbopackIgnore: true */ d.config.privateFilesDir, "proofs", orderId.replace(/[^a-z0-9]/gi, ""));
  const rel = path.join(/* turbopackIgnore: true */ dir, `${crypto.randomBytes(8).toString("hex")}.${kind === "jpeg" ? "jpg" : kind}`);
  // Datos personales: solo el usuario del servidor puede leerlos.
  await fs.mkdir(path.resolve(/* turbopackIgnore: true */ dir), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.resolve(/* turbopackIgnore: true */ rel), data, { mode: 0o600 });
  return rel;
}

/** Tipo del comprobante por su firma (bytes iniciales). */
function proofKind(b: Uint8Array): "jpeg" | "png" | "webp" | "pdf" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(0, 5) === "%PDF-") return "pdf";
  return null;
}

export interface VerifyInput {
  paymentId: string;
  decision: "approve" | "reject";
  note?: string | null;
  /** Corrección del equivalente en USD al aprobar (p.ej. tasa distinta). */
  amountUsdCents?: number;
}

/** Verificación del admin. Aprobar dispara la matrícula si completa el primer pago. Rechazar libera el cupo. */
export async function adminVerifyPayment(d: Deps, user: SessionUser, input: VerifyInput) {
  const admin = await requireAdmin(d.db, user, "payments.verify");
  const adminId = admin.id;
  const now = d.now();
  const actor: Actor = { type: "ADMIN", id: adminId };
  if (input.decision === "reject" && !input.note?.trim()) throw new DomainError("VALIDATION", "Indica el motivo del rechazo.");
  if (input.amountUsdCents != null && (!Number.isInteger(input.amountUsdCents) || input.amountUsdCents <= 0)) throw new DomainError("VALIDATION", "Monto en USD inválido.");

  const out = await withTx(d, async (tx) => {
    const p = await tx.payment.findUnique({ where: { id: input.paymentId } });
    if (!p) throw new DomainError("NOT_FOUND", "El pago no existe.");
    // Bajar el equivalente en USD es conservador; subirlo por encima de lo calculado con la tasa acredita dinero
    // que no está en el comprobante (equivale a ajustar el saldo): solo quien puede ajustar saldos.
    const raise = input.decision === "approve" && input.amountUsdCents != null ? input.amountUsdCents - p.amountUsdCents : 0;
    if (raise > Math.max(100, Math.round(p.amountUsdCents * 0.02)) && !can(admin, "orders.adjustBalance")) {
      throw new DomainError("FORBIDDEN", "Subir el equivalente en USD por encima de lo calculado con la tasa solo lo puede hacer el superadministrador. Apruébalo con el monto calculado o pídele que lo corrija.");
    }
    const claimed = await tx.payment.updateMany({
      where: { id: p.id, status: "AWAITING_VERIFICATION" },
      data:
        input.decision === "approve"
          ? { status: "COMPLETED", verifiedById: adminId, verifiedAt: now, ...(input.amountUsdCents != null ? { amountUsdCents: input.amountUsdCents } : {}) }
          : // Rechazado: la referencia queda libre para registrarla de nuevo (p.ej. con el monto corregido).
            { status: "REJECTED", verifiedById: adminId, verifiedAt: now, rejectionReason: input.note!.trim(), referenceKey: null },
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
      const apply = await applyConfirmedPayment(tx, p.id, actor, now);
      // Pagado de más: PayPal reembolsa el excedente solo; en un pago manual el dinero ya está en el banco, así
      // que el saldo a favor queda a la vista del staff para devolverlo (reembolso manual) o aplicarlo.
      const { balanceCents } = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { balanceCents: true } });
      if (!apply.closedOrder && balanceCents < 0) {
        await addOrderEvent(tx, p.orderId, "ATTENTION", SYSTEM, `El cliente pagó ${(-balanceCents / 100).toFixed(2)} USD de más: devuelve el excedente con un reembolso manual o aplícalo.`, { paymentId: p.id, creditCents: -balanceCents });
      }
      return { approved: true as const, apply, orderClosed: false, next: undefined };
    }
    await addOrderEvent(tx, p.orderId, "PAYMENT_REJECTED", actor, input.note!.trim(), { paymentId: p.id });
    const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
    const stillAwaiting = await tx.payment.count({ where: { orderId: order.id, status: "AWAITING_VERIFICATION" } });
    // Captura de PayPal retenida (CAPTURE_PENDING) del mismo pedido: su dinero sigue en camino. Rechazar el comprobante
    // no cierra el pedido ni libera el cupo (si no, otro médico lo toma y, al confirmar PayPal, este queda cobrado sin
    // cupo): vuelve a «pago pendiente» y el cupo sigue protegido (seats.ts / expireStaleOrders) hasta que PayPal decida.
    const paypalHeld = await tx.payment.count({ where: { orderId: order.id, method: "PAYPAL", status: "PENDING", providerStatus: "CAPTURE_PENDING" } });
    let orderClosed = false;
    if (order.status === "AWAITING_VERIFICATION" && stillAwaiting === 0) {
      if (order.amountPaidCents <= 0 && paypalHeld === 0) {
        await releaseOrderReservations(tx, order.id, "REJECTED", now, actor);
        await transitionOrder(tx, order.id, "REJECTED", { actor, note: `Pago rechazado: ${input.note!.trim()}` });
        orderClosed = true;
      } else {
        await transitionOrder(tx, order.id, "PENDING_PAYMENT", { actor, note: `Pago rechazado: ${input.note!.trim()}` });
        if (order.amountPaidCents > 0) await flagUnderpaidOrder(tx, order.id, actor);
        if (paypalHeld > 0) {
          await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, "Pago rechazado, pero PayPal retiene otro pago de este pedido (en revisión): el cupo se mantiene hasta que PayPal lo confirme o lo rechace.", { paymentId: p.id });
        }
      }
    }
    // Qué le dice el correo al médico: «registra el pago de nuevo» solo si el pedido admite otro pago. Un comprobante
    // duplicado rechazado en un pedido ya pagado (o ya reembolsado/cancelado) no debe invitarlo a pagar otra vez.
    const after = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, balanceCents: true } });
    const next: T.RejectedNextStep = orderClosed
      ? "released"
      : CLOSED_STATES.includes(after.status)
        ? "closed"
        : PAID_STATES.includes(after.status) && after.balanceCents <= 0
          ? "paid"
          : stillAwaiting > 0 || paypalHeld > 0
            ? "other_pending"
            : "retry";
    return { approved: false as const, apply: null, orderClosed, next };
  });

  const payment = await d.db.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
  if (out.approved) {
    await afterPaymentApplied(d, payment.id, out.apply!, "manual");
  } else {
    await safeNotify(d, "payment_rejected", async () => {
      const { view, email, customerId } = await buildOrderView(d, payment.orderId);
      await sendEmail(d, { template: "payment_rejected", to: email, rendered: T.paymentRejected(view, await buildPaymentView(d, payment.id), payment.rejectionReason, out.next), dedupeKey: `payment_rejected:${payment.id}`, orderId: payment.orderId, customerId });
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

/**
 * Crea la orden PayPal por el monto que corresponde ahora (primer pago o siguiente cuota). Con
 * `installmentId` (enlace del correo de recordatorio) cobra exactamente esa cuota, que debe ser la
 * siguiente impaga del pedido.
 */
export async function startPaypalPayment(d: Deps, orderId: string, urls?: { returnUrl?: string; cancelUrl?: string; installmentId?: string | null }): Promise<StartPaypalResult> {
  const now = d.now();
  // PayPal desactivado en Configuración: ningún camino abre un cobro nuevo (el checkout ya lo impide; aquí también
  // los enlaces de pago de la página del pedido y de los recordatorios de cuota enviados antes de desactivarlo).
  // Lo ya aprobado en PayPal se sigue capturando (captura/webhook/conciliación no pasan por aquí).
  if (!(await readSetting(d.db, SETTING_KEYS.paypal, { enabled: true })).enabled) {
    throw new DomainError("VALIDATION", "El pago con PayPal no está disponible en este momento. Elige otro método de pago o escríbenos.");
  }
  const ttl = await reservationTtlMs(d, "PAYPAL");
  const { paymentId, amountCents, order } = await withTx(d, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: { include: { reservation: true } } } });
    if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
    // PayPal ya retiene el dinero de un intento anterior (CAPTURE_PENDING): no se abre otro (pagaría dos
    // veces) ni se cancela ese (su cupo sigue protegido hasta que PayPal lo libere o lo rechace).
    const held = await tx.payment.findFirst({ where: { orderId, method: "PAYPAL", status: "PENDING", providerStatus: "CAPTURE_PENDING" }, select: { id: true } });
    if (held) throw new DomainError("INVALID_STATE", "PayPal está revisando tu pago anterior de este pedido. Te avisaremos por correo cuando se confirme; no hace falta pagar de nuevo.", { paymentId: held.id });
    let amount: number;
    let installmentId: string | null = null;
    if (urls?.installmentId && !PAID_STATES.includes(order.status)) {
      throw new DomainError("INVALID_STATE", order.status === "PENDING_PAYMENT" ? "Primero completa el pago inicial del pedido." : "Este pedido no admite pagos en este momento.");
    }
    if (order.status === "PENDING_PAYMENT") {
      amount = order.dueNowCents - order.amountPaidCents;
      // El comprador va a PayPal: la reserva y el pedido deben durar al menos `ttl` desde AHORA, o el job
      // podría vencer el pedido y liberar el cupo mientras paga. Si la reserva ya se liberó, se vuelve a
      // retener cupo (o se falla); si sigue HELD (aunque vencida y aún sin barrer), se extiende.
      // Tope absoluto: cada intento (una orden PayPal nueva) extiende a lo sumo UNA vez y nunca más allá de
      // `paypalHoldCap` desde placedAt — sin tope, cualquiera con el enlace del pedido podría retener los
      // últimos cupos para siempre pulsando «Pagar con PayPal» cada 30 min sin aprobar nunca.
      const holdsSeats = order.amountPaidCents === 0 && order.items.some((it) => it.modality === "SEMIPRESENCIAL" && it.reservation);
      const cap = holdsSeats ? await paypalHoldCap(tx, order, ttl) : null;
      const until = new Date(Math.min(now.getTime() + ttl, cap?.getTime() ?? Infinity));
      if (cap && until.getTime() <= now.getTime()) {
        throw new DomainError("INVALID_STATE", "Se agotó el tiempo para pagar este pedido y su cupo quedó libre. Vuelve a iniciar la compra.", { holdCap: cap.toISOString() });
      }
      for (const it of order.items) {
        const r = it.reservation;
        if (it.modality !== "SEMIPRESENCIAL" || !r) continue;
        if (r.status === "RELEASED") {
          if (!(await acquireSeat(tx, r.cohortId, "HELD", { requireOpen: true }))) throw new DomainError("SOLD_OUT", "Tu reserva venció y ya no quedan cupos en esta cohorte.");
          await tx.seatReservation.update({ where: { id: r.id }, data: { status: "HELD", expiresAt: until, releasedAt: null, releasedReason: null } });
        } else if (r.status === "HELD" && r.expiresAt.getTime() < until.getTime()) {
          const n = await tx.seatReservation.updateMany({ where: { id: r.id, status: "HELD" }, data: { expiresAt: until } });
          if (n.count !== 1) throw new DomainError("CONFLICT", "Tu reserva cambió mientras se procesaba; intenta de nuevo.");
        }
      }
      const extend = !order.expiresAt || order.expiresAt.getTime() < until.getTime();
      const patch = { ...(order.paymentMethod !== "PAYPAL" ? { paymentMethod: "PAYPAL" as const } : {}), ...(extend ? { expiresAt: until } : {}) };
      if (Object.keys(patch).length > 0) {
        const upd = await tx.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT" }, data: patch });
        if (upd.count !== 1) throw new DomainError("CONFLICT", "El pedido cambió mientras se procesaba; intenta de nuevo.");
      }
      if (extend && cap) {
        await addOrderEvent(tx, order.id, "SEAT_HOLD_EXTENDED", { type: "CUSTOMER" }, `Reserva extendida hasta ${until.toISOString()} (pago con PayPal)`, { until: until.toISOString(), holdCap: cap.toISOString(), previous: order.expiresAt?.toISOString() ?? null });
      }
    } else if (PAID_STATES.includes(order.status) && order.balanceCents <= 0) {
      throw new DomainError("INVALID_STATE", "Este pedido ya está pagado por completo.");
    } else if (PAID_STATES.includes(order.status) && order.balanceCents > 0) {
      // El médico ya registró un pago (Pago Móvil, transferencia…) que el staff está verificando: pagar con PayPal ahora
      // cobraría dos veces lo mismo (p. ej. la cuota del recordatorio). Igual que el primer pago del pedido.
      const awaiting = await tx.payment.findFirst({ where: { orderId, status: "AWAITING_VERIFICATION" }, select: { id: true } });
      if (awaiting) throw new DomainError("INVALID_STATE", "Ya registraste un pago de este pedido y lo estamos verificando. Te avisaremos por correo al aprobarlo; no hace falta pagar de nuevo.", { paymentId: awaiting.id });
      const next = await tx.installment.findFirst({ where: { orderId, status: { in: ["PENDING", "OVERDUE"] } }, orderBy: { sequence: "asc" } });
      if (urls?.installmentId) {
        const target = await tx.installment.findFirst({ where: { id: urls.installmentId, orderId } });
        if (!target) throw new DomainError("NOT_FOUND", "La cuota no existe en este pedido.");
        if (target.status === "PAID" || target.status === "WAIVED") throw new DomainError("INVALID_STATE", `La cuota ${target.sequence} ya está pagada.`);
        if (next && next.id !== target.id) throw new DomainError("INVALID_STATE", `Primero debes pagar la cuota ${next.sequence}.`);
      }
      installmentId = next?.id ?? null;
      amount = Math.min(order.balanceCents, next ? next.amountCents - next.paidCents : order.balanceCents);
    } else if (order.status === "EXPIRED") {
      throw new DomainError("INVALID_STATE", "Este pedido venció. Vuelve a iniciar la compra.");
    } else {
      throw new DomainError("INVALID_STATE", "Este pedido no admite pagos en este momento.");
    }
    if (amount <= 0) throw new DomainError("INVALID_STATE", "No hay monto pendiente por pagar.");
    // Se está capturando ahora mismo un pago PayPal de este pedido (el médico aprobó y volvió a pulsar «Pagar»): abrir
    // otro cobraría dos veces. Pasado el plazo de la captura (sin respuesta de PayPal), ese intento queda como
    // resultado desconocido (si PayPal sí lo cobró, el webhook o la conciliación lo imputan) y se puede volver a pagar.
    const capturingNow = await tx.payment.findFirst({
      where: { orderId, method: "PAYPAL", providerStatus: CAPTURING, status: { in: ["PENDING", "CANCELLED"] }, updatedAt: { gte: new Date(now.getTime() - CAPTURING_LEASE_MS) } },
      select: { id: true },
    });
    if (capturingNow) throw new DomainError("INVALID_STATE", "Estamos confirmando con PayPal tu pago anterior de este pedido. Espera unos minutos y revisa tu correo antes de pagar de nuevo.", { paymentId: capturingNow.id });
    await tx.payment.updateMany({ where: { orderId, method: "PAYPAL", status: "PENDING", providerStatus: CAPTURING }, data: { status: "CANCELLED", providerStatus: "CAPTURE_UNKNOWN" } });
    await tx.payment.updateMany({ where: { orderId, method: "PAYPAL", status: "PENDING" }, data: { status: "CANCELLED" } });
    const p = await tx.payment.create({ data: { orderId, installmentId, method: "PAYPAL", status: "PENDING", amountCents: amount, currency: "USD", amountUsdCents: amount, createdAt: now } });
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

/** Un pedido PayPal retiene su cupo como máximo este múltiplo del TTL de PayPal desde que se creó (30 min → 90 min). */
export const PAYPAL_HOLD_CAP_TTLS = 3;

/**
 * Límite absoluto de la retención de cupo de un pedido sin pagar al iniciar PayPal: el mayor entre el plazo
 * que tuvo al hacer el checkout (72 h si se eligió un método manual: no se le recorta) y
 * placedAt + PAYPAL_HOLD_CAP_TTLS × TTL de PayPal.
 */
async function paypalHoldCap(tx: Tx, order: { id: string; placedAt: Date }, ttl: number): Promise<Date> {
  const created = await tx.orderEvent.findFirst({ where: { orderId: order.id, type: "CREATED" }, orderBy: { createdAt: "asc" }, select: { data: true } });
  const original = Date.parse(String((created?.data as { expiresAt?: unknown } | null)?.expiresAt ?? ""));
  const base = order.placedAt.getTime() + PAYPAL_HOLD_CAP_TTLS * ttl;
  return new Date(Number.isFinite(original) ? Math.max(original, base) : base);
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
export async function onPaypalCaptureCompleted(
  d: Deps,
  input: CaptureCompletedInput,
): Promise<{ alreadyProcessed: boolean; orderId: string; paymentId: string; autoRefundCents?: number; currencyMismatch?: boolean }> {
  const now = d.now();
  const actor: Actor = { type: input.source === "webhook" ? "WEBHOOK" : input.source === "reconcile" ? "SYSTEM" : "CUSTOMER" };
  const p =
    (await d.db.payment.findUnique({ where: { paypalCaptureId: input.captureId } })) ??
    (input.paypalOrderId ? await d.db.payment.findUnique({ where: { paypalOrderId: input.paypalOrderId } }) : null);
  if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura de PayPal.", { captureId: input.captureId, paypalOrderId: input.paypalOrderId });

  // Solo cobramos en USD: una captura en otra moneda no se imputa (el panel la reembolsa desde PayPal).
  const currency = input.currency?.trim().toUpperCase();
  if (currency && currency !== "USD") {
    const flagged = await withTx(d, async (tx) => {
      const n = await tx.payment.updateMany({
        where: { id: p.id, status: { in: ["PENDING", "FAILED", "CANCELLED"] }, NOT: { providerStatus: "CURRENCY_MISMATCH" } },
        data: { status: "FAILED", providerStatus: "CURRENCY_MISMATCH", paypalCaptureId: input.captureId, providerPayload: (input.raw as object) ?? undefined },
      });
      if (n.count === 1) {
        await addOrderEvent(tx, p.orderId, "ATTENTION", SYSTEM, `PayPal capturó ${input.amountCents != null ? (input.amountCents / 100).toFixed(2) : "?"} ${currency} (se esperaba USD). No se imputó al pedido: reembolsa la captura ${input.captureId} desde PayPal.`, { paymentId: p.id, captureId: input.captureId, currency });
      }
      return n.count === 1;
    });
    return { alreadyProcessed: !flagged, orderId: p.orderId, paymentId: p.id, currencyMismatch: true };
  }

  const out = await withTx(d, async (tx) => {
    const before = await tx.payment.findUniqueOrThrow({ where: { id: p.id }, select: { status: true } });
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
    if (before.status === "CANCELLED") {
      // El comprador aprobó un intento que ya había sido reemplazado (p.ej. dos pestañas) o cuyo pedido venció.
      const newer = await tx.payment.count({ where: { orderId: p.orderId, method: "PAYPAL", id: { not: p.id }, createdAt: { gte: p.createdAt } } });
      await addOrderEvent(
        tx,
        p.orderId,
        "ATTENTION",
        SYSTEM,
        newer > 0 ? `Se capturó un intento de PayPal que había sido reemplazado por otro (${input.captureId}).` : `Se capturó un pago de PayPal aprobado después de que venciera el plazo del pedido (${input.captureId}).`,
        { paymentId: p.id, captureId: input.captureId },
      );
    }
    const apply = await applyConfirmedPayment(tx, p.id, actor, now);
    const o = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { balanceCents: true } });
    // Excedente: pedido cerrado (todo) o pagado de más (lo que sobra). Se reembolsa automáticamente.
    const refundCents = apply.closedOrder ? amount : o.balanceCents < 0 ? Math.min(amount, -o.balanceCents) : 0;
    if (refundCents > 0) {
      await addOrderEvent(tx, p.orderId, "ATTENTION", SYSTEM, `Pago PayPal en exceso: se reembolsan automáticamente ${(refundCents / 100).toFixed(2)} USD de la captura ${input.captureId}.`, { paymentId: p.id, refundCents });
    }
    return { apply, refundCents };
  });
  if (!out) return { alreadyProcessed: true, orderId: p.orderId, paymentId: p.id };
  // Webhooks fuera de orden: PayPal pudo avisar un reembolso de esta captura ANTES de que la conociéramos
  // (COMPLETED falló en su primera entrega). Se aplica ahora, antes de confirmar ni matricular: si devolvió todo,
  // el pedido queda reembolsado y no se matricula ni se confirma el pago al médico.
  if ((await applyParkedPaypalRefunds(d, input.captureId)) > 0) {
    const { status } = await d.db.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true } });
    if (status === "REFUNDED") return { alreadyProcessed: false, orderId: p.orderId, paymentId: p.id };
  }
  await afterPaymentApplied(d, p.id, out.apply, "paypal");
  if (out.refundCents > 0) {
    try {
      await executeRefund(
        d,
        { paymentId: p.id, amountCents: out.refundCents, reason: out.apply.closedOrder ? "Pago recibido en un pedido cerrado" : "Pago duplicado: reembolso automático del excedente", unenroll: false, releaseSeat: false, keepCertificate: true, idempotencyKey: `auto-excess-${p.id}` },
        SYSTEM,
      );
    } catch (e) {
      d.log.error(`[paypal] no se pudo reembolsar el excedente del pago ${p.id}`, e);
      await withTx(d, (tx) => addOrderEvent(tx, p.orderId, "ATTENTION", SYSTEM, `No se pudo reembolsar automáticamente el excedente (${(out.refundCents / 100).toFixed(2)} USD): hazlo desde el panel. ${String((e as Error)?.message ?? e)}`, { paymentId: p.id }));
    }
  }
  return { alreadyProcessed: false, orderId: p.orderId, paymentId: p.id, autoRefundCents: out.refundCents || undefined };
}

export async function onPaypalCaptureDenied(d: Deps, input: { captureId?: string | null; paypalOrderId?: string | null; raw?: unknown; source: "webhook" | "return" | "reconcile" }) {
  const p =
    (input.captureId ? await d.db.payment.findUnique({ where: { paypalCaptureId: input.captureId } }) : null) ??
    (input.paypalOrderId ? await d.db.payment.findUnique({ where: { paypalOrderId: input.paypalOrderId } }) : null);
  if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura de PayPal.");
  const wasHeld = p.status === "PENDING" && p.providerStatus === "CAPTURE_PENDING";
  const heldOutcome = await withTx(d, async (tx) => {
    const n = await tx.payment.updateMany({
      where: { id: p.id, status: { in: ["PENDING", "CANCELLED"] } },
      data: { status: "FAILED", providerStatus: "DENIED", paypalCaptureId: input.captureId ?? p.paypalCaptureId, providerPayload: (input.raw as object) ?? undefined },
    });
    if (n.count !== 1) return null;
    await addOrderEvent(tx, p.orderId, "PAYMENT_FAILED", { type: input.source === "webhook" ? "WEBHOOK" : input.source === "reconcile" ? "SYSTEM" : "CUSTOMER" }, "PayPal rechazó el pago", { paymentId: p.id });
    if (!wasHeld) return null;
    // PayPal retuvo la captura (revisión) y días después la rechaza. Al médico se le dijo «PayPal está revisando tu
    // pago; te avisaremos por correo» y no se le dejó pagar de otra forma mientras tanto: hay que avisarle, y si el
    // pedido sigue esperando su primer pago, darle de nuevo el plazo normal con SU cupo (el plazo original venció
    // durante la revisión; sin esto el job lo vencía en la siguiente corrida, justo después del aviso).
    const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { id: true, status: true, amountPaidCents: true, paymentMethod: true } });
    const otherHeld = await tx.payment.count({ where: { orderId: order.id, id: { not: p.id }, OR: [{ status: { in: ["AWAITING_VERIFICATION", "COMPLETED"] } }, { method: "PAYPAL", status: "PENDING", providerStatus: "CAPTURE_PENDING" }] } });
    if (order.status !== "PENDING_PAYMENT" || order.amountPaidCents > 0 || otherHeld > 0) return { next: "other_pending" as const, reopened: false };
    const now = d.now();
    const until = new Date(now.getTime() + (await reservationTtlMs(d, order.paymentMethod && order.paymentMethod !== "PAYPAL" ? order.paymentMethod : "PAGO_MOVIL")));
    const held = await tx.seatReservation.updateMany({ where: { orderId: order.id, status: "HELD", expiresAt: { lt: until } }, data: { expiresAt: until } });
    const o2 = await tx.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT", OR: [{ expiresAt: null }, { expiresAt: { lt: until } }] }, data: { expiresAt: until } });
    await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, `PayPal rechazó el pago que tenía retenido en revisión. Se avisó al médico y se le dio un nuevo plazo para pagar hasta ${until.toISOString()}${held.count ? " con su cupo reservado" : ""}.`, { paymentId: p.id, expiresAt: until.toISOString(), reservations: held.count, orderExtended: o2.count });
    return { next: "retry" as const, reopened: true };
  });
  if (heldOutcome && heldOutcome.next === "retry") {
    await safeNotify(d, "payment_rejected", async () => {
      const { view, email, customerId } = await buildOrderView(d, p.orderId);
      await sendEmail(d, {
        template: "payment_rejected",
        to: email,
        rendered: T.paymentRejected(view, await buildPaymentView(d, p.id), "PayPal no aprobó el pago que tenía en revisión; no se te cobró.", "retry"),
        dedupeKey: `payment_rejected:${p.id}`,
        orderId: p.orderId,
        customerId,
      });
    });
  }
  return { orderId: p.orderId, paymentId: p.id };
}

export type ReturnCaptureStatus = "COMPLETED" | "PENDING" | "FAILED";
/**
 * Por qué un retorno FAILED no es un rechazo de PayPal: el comprador SÍ aprobó, pero la app decidió no capturar
 * (no se le cobró). MANUAL_AWAITING = el pedido ya tiene un pago manual en verificación; NOT_CAPTURED = el pago
 * ya había quedado sin capturar (pedido cerrado, cohorte llena, o un retorno/webhook repetido tras bloquearlo).
 */
export type NotCapturedReason = "MANUAL_AWAITING" | "NOT_CAPTURED" | "DUPLICATE";

/** Return URL de PayPal (?token=<paypalOrderId>): captura la orden. Si el webhook llegó antes, no duplica nada. */
export async function capturePaypalReturn(
  d: Deps,
  paypalOrderId: string,
  source: "return" | "reconcile" | "webhook" = "return",
): Promise<{ status: ReturnCaptureStatus; orderId: string; orderToken: string; notCaptured?: NotCapturedReason }> {
  const p = await d.db.payment.findUnique({ where: { paypalOrderId }, include: { order: { select: { token: true } } } });
  if (!p) throw new DomainError("NOT_FOUND", "No encontramos ese pago de PayPal.");
  const done = (status: ReturnCaptureStatus, notCaptured?: NotCapturedReason) => ({ status, orderId: p.orderId, orderToken: p.order.token, ...(notCaptured ? { notCaptured } : {}) });
  if (p.status === "COMPLETED" || p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED") return done("COMPLETED");
  // Ya se decidió NO capturar esta orden aprobada: es definitivo. Un retorno recargado o un webhook
  // CHECKOUT.ORDER.APPROVED reintentado DESPUÉS de que el admin aprobara el pago móvil no debe cobrarla ahora.
  if (p.providerStatus === "NOT_CAPTURED") {
    const awaiting = await d.db.payment.count({ where: { orderId: p.orderId, status: "AWAITING_VERIFICATION" } });
    return done("FAILED", awaiting > 0 ? "MANUAL_AWAITING" : "NOT_CAPTURED");
  }
  if (p.status !== "PENDING" || p.providerStatus !== "CAPTURE_PENDING") {
    if (await skipCaptureWhileManualAwaiting(d, p.id)) return done("FAILED", "MANUAL_AWAITING");
  }
  // Una orden aprobada y NO capturada no mueve dinero: si el pedido ya no puede recibir este pago (cerrado,
  // o su reserva venció y la cohorte se llenó), no se captura en vez de cobrar y reembolsar después.
  if (p.status !== "PENDING" || p.providerStatus !== "CAPTURE_PENDING") {
    const blocked = await secureSeatBeforeCapture(d, p.id);
    if (blocked) return done("FAILED", blocked.duplicate ? "DUPLICATE" : "NOT_CAPTURED");
  }

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

const NOT_CAPTURED = "NOT_CAPTURED";
/**
 * Orden PayPal aprobada cuya captura está en curso (secureSeatBeforeCapture → captureOrder). Cuenta como «en curso»
 * durante CAPTURING_LEASE_MS (la llamada a PayPal agota su timeout mucho antes): si la captura falló sin respuesta, el
 * médico puede volver a pagar pasado ese plazo (si PayPal sí la cobró, el webhook o la conciliación la imputan).
 */
const CAPTURING = "CAPTURING";
const CAPTURING_LEASE_MS = 2 * 60_000;
/** Tiempo que se aparta la reserva (y el pedido) mientras se captura una orden PayPal aprobada. */
const CAPTURE_WINDOW_MS = 10 * 60_000;
class SeatGone extends Error {}

/**
 * Antes de capturar una orden PayPal aprobada: ¿puede el pedido recibir este pago?
 *  - pedido cerrado (cancelado o reembolsado) → no;
 *  - pedido ya pagado (saldo ≤ 0) o pago mayor que el saldo pendiente → no (cobrar y reembolsar el excedente
 *    duplica el cargo al médico y pierde la comisión de PayPal);
 *  - primer pago de un pedido cuya reserva ya se liberó (venció mientras el comprador estaba en PayPal):
 *    se vuelve a tomar el cupo AHORA (UPDATE condicional) para que la captura no lo pierda; si la cohorte se
 *    llenó entretanto → no.
 * Si no se puede, el pago queda CANCELLED/NOT_CAPTURED con un evento, y devuelve el motivo (la orden de PayPal
 * aprobada sin capturar caduca sola: al comprador no se le cobra). Devuelve null si se puede capturar.
 */
async function secureSeatBeforeCapture(d: Deps, paymentId: string): Promise<{ reason: string; duplicate: boolean } | null> {
  const now = d.now();
  const ttl = await reservationTtlMs(d, "PAYPAL");
  let reason: string | null = null;
  let duplicate: { id: string; number: number } | null = null;
  try {
    await withTx(d, async (tx) => {
      const { orderId } = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { orderId: true } });
      // Serializa las capturas del mismo pedido (dos pestañas aprobadas a la vez): la otra espera a que esta decida
      // y marque su captura en curso, y entonces la ve.
      await lockOrder(tx, orderId, now);
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { orderId: true, amountUsdCents: true, installmentId: true } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { items: { include: { reservation: true } } } });
      // Mismo criterio que applyConfirmedPayment (closedOrder): un pedido REJECTED sí admite un pago nuevo.
      if (order.status === "CANCELLED" || order.status === "REFUNDED") {
        reason = `el pedido está ${order.status === "CANCELLED" ? "cancelado" : "reembolsado"}`;
        throw new SeatGone();
      }
      // Otra orden PayPal del mismo pedido se está capturando ahora mismo (el médico aprobó dos pestañas a la vez):
      // lo que ella cobra aún no está imputado, así que los controles de saldo de abajo la ignorarían y se cobraría
      // dos veces (y luego se reembolsaría el excedente, perdiendo la comisión de PayPal).
      const capturing = await tx.payment.findMany({
        where: { orderId: p.orderId, id: { not: paymentId }, method: "PAYPAL", providerStatus: CAPTURING, status: { in: ["PENDING", "CANCELLED"] }, updatedAt: { gte: new Date(now.getTime() - CAPTURING_LEASE_MS) } },
        select: { amountUsdCents: true, installmentId: true },
      });
      const capturingCents = capturing.reduce((a, c) => a + c.amountUsdCents, 0);
      const markCapturing = () => tx.payment.update({ where: { id: paymentId }, data: { providerStatus: CAPTURING, updatedAt: now } });
      // Pedido ya pagado (p.ej. con pago móvil aprobado mientras una orden PayPal vieja seguía abierta en otra
      // pestaña): capturar y luego reembolsar el excedente le cobra dos veces al médico y la comisión de PayPal
      // no se recupera. No se captura si no se debe nada o si el pago supera lo que se debe.
      if (PAID_STATES.includes(order.status)) {
        if (order.balanceCents <= 0) {
          reason = "el pedido ya está pagado por completo";
          throw new SeatGone();
        }
        if (p.amountUsdCents > order.balanceCents) {
          reason = `el pago (USD ${(p.amountUsdCents / 100).toFixed(2)}) supera el saldo pendiente (USD ${(order.balanceCents / 100).toFixed(2)})`;
          throw new SeatGone();
        }
        // Cuota: el médico ya la pagó por otra vía (su Pago Móvil está en verificación, o otra pestaña de PayPal la
        // cobró o la está cobrando). Capturar le cobraría dos veces la misma cuota (y la imputaría a la siguiente sin
        // que lo pidiera). Igual que en el primer pago (skipCaptureWhileManualAwaiting).
        const awaiting = await tx.payment.findMany({ where: { orderId: p.orderId, status: "AWAITING_VERIFICATION" }, select: { method: true, reference: true } });
        if (awaiting.length > 0) {
          reason = `el pedido ya tiene un pago en verificación (${awaiting.map((a) => `${T.METHOD_LABELS[a.method] ?? a.method} ref. ${a.reference ?? "—"}`).join(", ")})`;
          throw new SeatGone();
        }
        if (p.installmentId) {
          const ins = await tx.installment.findUnique({ where: { id: p.installmentId }, select: { sequence: true, status: true } });
          if (ins && (ins.status === "PAID" || ins.status === "WAIVED" || capturing.some((c) => c.installmentId === p.installmentId))) {
            reason = `la cuota ${ins.sequence} ya está pagada${ins.status === "PAID" || ins.status === "WAIVED" ? "" : " (otra orden de PayPal la está cobrando)"}`;
            throw new SeatGone();
          }
        }
        if (capturingCents > 0 && p.amountUsdCents > order.balanceCents - capturingCents) {
          reason = "otra orden de PayPal de este pedido se está cobrando y cubre el saldo pendiente";
          throw new SeatGone();
        }
        await markCapturing();
        return;
      }
      if (capturingCents > 0) {
        reason = "otra orden de PayPal de este pedido se está cobrando en este momento";
        throw new SeatGone();
      }
      await markCapturing();
      if (order.amountPaidCents > 0 || !PREPAID_STATES.includes(order.status)) return;
      // Compra duplicada: el mismo cliente ya pagó (o tiene un pago en verificación / retenido por PayPal) el mismo
      // programa en OTRO pedido. Capturar le cobraría dos veces y tomaría otro cupo de la cohorte: no se captura.
      const dup = await alreadyPaidElsewhere(tx, order);
      if (dup) {
        duplicate = { id: dup.id, number: dup.number };
        reason = `el cliente ya ${dup.how} ${dup.where} en el pedido #${dup.number} (compra duplicada)`;
        throw new SeatGone();
      }
      // La captura en PayPal tarda (red): mientras tanto el barrido de reservas, la liberación perezosa de otro
      // comprador (reserveSeat) o el vencimiento del pedido podían soltar una reserva HELD ya vencida (o a punto de
      // vencer) y revenderla → cobro sin cupo. Se aparta durante la ventana de captura: la reserva viva y el plazo
      // del pedido se llevan al menos a ahora + CAPTURE_WINDOW_MS (una reserva liberada se vuelve a tomar abajo).
      const captureUntil = new Date(now.getTime() + CAPTURE_WINDOW_MS);
      if (order.status === "PENDING_PAYMENT" && (!order.expiresAt || order.expiresAt.getTime() < captureUntil.getTime())) {
        await tx.order.updateMany({ where: { id: order.id, status: "PENDING_PAYMENT" }, data: { expiresAt: captureUntil } });
      }
      for (const it of order.items) {
        const r = it.reservation;
        if (it.modality === "SEMIPRESENCIAL" && r?.status === "HELD" && r.expiresAt.getTime() < captureUntil.getTime()) {
          const n = await tx.seatReservation.updateMany({ where: { id: r.id, status: "HELD" }, data: { expiresAt: captureUntil } });
          if (n.count === 1) continue;
          // La soltaron entre la lectura y esta escritura: se trata como liberada (abajo se vuelve a tomar).
          r.status = (await tx.seatReservation.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } })).status;
        }
        if (it.modality !== "SEMIPRESENCIAL" || !r || r.status !== "RELEASED") continue;
        if (!(await acquireSeat(tx, r.cohortId, "HELD", { requireOpen: false }))) {
          reason = `la reserva de «${it.productTitle}» venció y la cohorte ya no tiene cupo`;
          throw new SeatGone();
        }
        await tx.seatReservation.update({ where: { id: r.id }, data: { status: "HELD", expiresAt: new Date(now.getTime() + ttl), releasedAt: null, releasedReason: null } });
        await addOrderEvent(tx, order.id, "SEAT_REACQUIRED", SYSTEM, `Cupo vuelto a tomar para «${it.productTitle}» antes de capturar el pago de PayPal (la reserva había vencido).`, { orderItemId: it.id, paymentId });
      }
    });
    return null;
  } catch (e) {
    if (!(e instanceof SeatGone)) throw e;
  }
  await withTx(d, async (tx) => {
    const n = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ["PENDING", "CANCELLED", "FAILED"] }, NOT: { providerStatus: NOT_CAPTURED } },
      data: { status: "CANCELLED", providerStatus: NOT_CAPTURED },
    });
    if (n.count === 1) {
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { orderId: true, paypalOrderId: true } });
      await addOrderEvent(tx, p.orderId, "PAYMENT_NOT_CAPTURED", SYSTEM, `No se capturó el pago de PayPal ${p.paypalOrderId}: ${reason}. No se cobró al comprador.`, {
        paymentId,
        paypalOrderId: p.paypalOrderId,
        ...(duplicate ? { duplicateOf: duplicate.id, duplicateNumber: duplicate.number } : {}),
      });
      if (duplicate) {
        const o = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { number: true } });
        await addOrderEvent(
          tx,
          duplicate.id,
          "ATTENTION",
          SYSTEM,
          `El cliente aprobó en PayPal otra compra del mismo programa (pedido #${o.number}); no se capturó ni se le cobró. Si escribe, confírmale que su compra es este pedido.`,
          { duplicateOf: p.orderId, duplicateNumber: o.number, paymentId },
        );
      }
    }
  });
  return { reason: reason ?? "no se puede recibir este pago", duplicate: duplicate != null };
}

/**
 * ¿El cliente de este pedido (sin pagos aún) ya pagó el mismo programa en OTRO pedido? Cuenta como pagado: cupo
 * CONFIRMED en la misma cohorte (semipresencial) o pedido en PAID_STATES con el mismo producto (online), y también
 * el otro pedido con un pago manual en verificación o una captura de PayPal retenida (el dinero ya salió).
 */
async function alreadyPaidElsewhere(
  tx: Tx,
  order: { id: string; customerId: string; items: { productId: string; productTitle: string; modality: Modality; cohortId: string | null }[] },
): Promise<{ id: string; number: number; how: string; where: string } | null> {
  const inFlight = { some: { OR: [{ status: "AWAITING_VERIFICATION" as const }, { status: "PENDING" as const, providerStatus: "CAPTURE_PENDING" }] } };
  for (const it of order.items) {
    if (it.modality === "SEMIPRESENCIAL" && it.cohortId) {
      const rs = await tx.seatReservation.findMany({
        where: {
          cohortId: it.cohortId,
          orderId: { not: order.id },
          order: { customerId: order.customerId, status: { notIn: ["CANCELLED", "REFUNDED"] } },
          OR: [{ status: "CONFIRMED" }, { status: "HELD", order: { payments: inFlight } }],
        },
        select: { status: true, cohort: { select: { name: true } }, order: { select: { id: true, number: true } } },
        orderBy: { createdAt: "asc" },
        take: 1,
      });
      const r = rs[0];
      if (r) return { id: r.order.id, number: r.order.number, how: r.status === "CONFIRMED" ? "tiene cupo pagado en" : "tiene un pago en verificación por su cupo en", where: `la cohorte ${r.cohort.name}` };
    } else if (it.modality !== "SEMIPRESENCIAL") {
      const o = await tx.order.findFirst({
        where: {
          id: { not: order.id },
          customerId: order.customerId,
          items: { some: { productId: it.productId, modality: it.modality } },
          OR: [{ status: { in: [...PAID_STATES] } }, { status: { notIn: ["CANCELLED", "REFUNDED"] }, payments: inFlight }],
        },
        select: { id: true, number: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      if (o) return { id: o.id, number: o.number, how: PAID_STATES.includes(o.status) ? "pagó" : "tiene un pago en verificación de", where: `«${it.productTitle}» (online)` };
    }
  }
  return null;
}

/**
 * El primer pago del pedido ya está en verificación con un pago manual (el médico abrió PayPal, lo dejó en otra
 * pestaña y registró un pago móvil con comprobante; luego volvió y aprobó PayPal): capturar le cobraría dos
 * veces. No se captura (la orden aprobada sin capturar caduca sola en PayPal) y queda en el historial. Si el
 * admin rechaza el comprobante, el médico puede volver a pagar con PayPal desde su pedido.
 */
async function skipCaptureWhileManualAwaiting(d: Deps, paymentId: string): Promise<boolean> {
  return withTx(d, async (tx) => {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { orderId: true, paypalOrderId: true } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true } });
    if (order.status !== "AWAITING_VERIFICATION") return false;
    const awaiting = await tx.payment.findMany({ where: { orderId: p.orderId, status: "AWAITING_VERIFICATION" }, select: { id: true, method: true, reference: true } });
    if (awaiting.length === 0) return false;
    const n = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ["PENDING", "CANCELLED", "FAILED"] }, NOT: { providerStatus: "NOT_CAPTURED" } },
      data: { status: "CANCELLED", providerStatus: "NOT_CAPTURED" },
    });
    if (n.count === 1) {
      const refs = awaiting.map((a) => `${T.METHOD_LABELS[a.method] ?? a.method} ref. ${a.reference ?? "—"}`).join(", ");
      await addOrderEvent(tx, p.orderId, "PAYMENT_NOT_CAPTURED", SYSTEM, `No se capturó el pago de PayPal ${p.paypalOrderId}: el pedido ya tiene un pago en verificación (${refs}). No se cobró al comprador.`, {
        paymentId,
        paypalOrderId: p.paypalOrderId,
        awaitingPaymentIds: awaiting.map((a) => a.id),
      });
    }
    return true;
  });
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

/** Datos de un reembolso a partir del recurso de PAYMENT.CAPTURE.REFUNDED (la captura sale del enlace «up»). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function refundEventInput(resource: Record<string, any> | null | undefined) {
  if (!resource || typeof resource !== "object") return null;
  const up = (resource.links as { rel: string; href: string }[] | undefined)?.find?.((l) => l.rel === "up")?.href ?? "";
  const captureId: string | null = up.match(/captures\/([^/?]+)/)?.[1] ?? resource.capture_id ?? resource.supplementary_data?.related_ids?.capture_id ?? null;
  if (!captureId || !resource.id) return null;
  return { captureId: String(captureId), refundId: String(resource.id), amountCents: cents(resource.amount?.value), reason: (resource.note_to_payer as string | undefined) ?? null, invoiceId: (resource.invoice_id as string | undefined) ?? null };
}

/**
 * Webhooks fuera de orden: un PAYMENT.CAPTURE.REFUNDED que llegó cuando la captura aún no estaba registrada
 * (p.ej. su PAYMENT.CAPTURE.COMPLETED falló en la primera entrega y PayPal lo reintenta después) quedó guardado
 * con error. En cuanto la captura existe, se aplica (idempotente por id de reembolso de PayPal). Devuelve
 * cuántos reembolsos aparcados se aplicaron.
 */
async function applyParkedPaypalRefunds(d: Deps, captureId: string): Promise<number> {
  if (!(await d.db.payment.findUnique({ where: { paypalCaptureId: captureId }, select: { id: true } }))) return 0;
  const parked = await d.db.webhookEvent.findMany({
    where: { provider: "paypal", eventType: "PAYMENT.CAPTURE.REFUNDED", error: { not: null } },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  let applied = 0;
  for (const ev of parked) {
    const input = refundEventInput((ev.payload as { resource?: Record<string, unknown> } | null)?.resource);
    if (input?.captureId !== captureId) continue;
    try {
      const r = await onPaypalRefundCompleted(d, input);
      await d.db.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: d.now(), error: null } });
      if (!("duplicate" in r && r.duplicate)) applied++;
    } catch (e) {
      d.log.error(`[paypal] no se pudo aplicar el reembolso aparcado ${input.refundId} de la captura ${captureId}`, e);
    }
  }
  return applied;
}

/**
 * Webhook de PayPal: verifica firma, registra el evento (idempotencia por event id) y lo despacha.
 * Devuelve `retry: true` solo ante errores transitorios (la ruta debe responder 5xx para que PayPal reintente).
 */
export async function handlePaypalWebhook(d: Deps, headers: Record<string, string | string[] | undefined> | Headers, rawBody: string) {
  // Cuerpo ilegible → 400 (no es transitorio: PayPal no debe reintentarlo). Se valida ANTES de la firma, que
  // también lo parsea y, si fallara allí, se trataría como error transitorio (500 → reintentos sin fin).
  let evt: { id?: string; event_type?: string; resource?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    evt = JSON.parse(rawBody);
  } catch {
    throw new DomainError("VALIDATION", "Cuerpo de webhook inválido.");
  }
  if (!evt || typeof evt !== "object") throw new DomainError("VALIDATION", "Cuerpo de webhook inválido.");
  const verified = await d.paypal.verifyWebhookSignature(headers, rawBody);
  if (!verified) throw new DomainError("UNAUTHORIZED", "Firma de webhook inválida.");
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
        const r = refundEventInput(resource);
        if (!r) throw new DomainError("VALIDATION", "Reembolso sin captura asociada.");
        await onPaypalRefundCompleted(d, r);
        break;
      }
      case "PAYMENT.CAPTURE.REVERSED": {
        // Contracargo (el banco de la tarjeta devolvió el dinero al comprador) o reverso de PayPal: el dinero ya no
        // está, igual que en un reembolso. Se descuenta del pedido (reabre el saldo; sin saldo en cero no hay
        // certificado) y queda un aviso para el equipo.
        const r = refundEventInput(resource);
        if (!r) throw new DomainError("VALIDATION", "Reverso sin captura asociada.");
        const res = await onPaypalRefundCompleted(d, { ...r, reason: `Contracargo / reverso de PayPal${r.reason ? `: ${r.reason}` : ""}` });
        const p = await d.db.payment.findUnique({ where: { paypalCaptureId: r.captureId }, select: { orderId: true } });
        if (p && !("duplicate" in res && res.duplicate)) {
          await addOrderEvent(d.db, p.orderId, "ATTENTION", { type: "WEBHOOK" }, "PayPal revirtió un pago (contracargo del banco del comprador): el monto se descontó del pedido. Revisa el caso en PayPal y el acceso del médico.", { captureId: r.captureId, refundId: r.refundId });
        }
        break;
      }
      case "CUSTOMER.DISPUTE.CREATED": {
        // El comprador abrió una disputa: todavía no se movió dinero, pero hay que responderla en PayPal a tiempo.
        const disputed = (resource.disputed_transactions as { seller_transaction_id?: string }[] | undefined) ?? [];
        const captureId = disputed.map((t) => t.seller_transaction_id).find(Boolean);
        const p = captureId ? await d.db.payment.findUnique({ where: { paypalCaptureId: captureId }, select: { orderId: true } }) : null;
        if (!p) throw new DomainError("NOT_FOUND", "Disputa de una captura desconocida.");
        await addOrderEvent(d.db, p.orderId, "ATTENTION", { type: "WEBHOOK" }, `El comprador abrió una disputa en PayPal (${String(resource.reason ?? "sin motivo")}, caso ${String(resource.dispute_id ?? "")}). Respóndela en PayPal: si se pierde, PayPal devuelve el dinero y se descontará del pedido.`, { captureId, disputeId: resource.dispute_id ?? null });
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
      // Reembolso de una captura aún desconocida: queda «aparcado» (error) y se aplica cuando llegue la captura
      // (applyParkedPaypalRefunds). Si la captura se registró mientras tanto (carrera), se aplica ya.
      const parkedCapture = evt.event_type === "PAYMENT.CAPTURE.REFUNDED" && e.code === "NOT_FOUND" ? refundEventInput(resource)?.captureId : null;
      if (parkedCapture && (await applyParkedPaypalRefunds(d, parkedCapture)) > 0) return { ok: true, duplicate: false, eventType: evt.event_type, retry: false };
      return { ok: false, duplicate: false, eventType: evt.event_type, retry: false, error: msg };
    }
    await d.db.webhookEvent.update({ where: { id: row.id }, data: { error: msg } });
    return { ok: false, duplicate: false, eventType: evt.event_type, retry: true, error: msg };
  }
}

// ───────────── Reembolsos ─────────────
//
// Reembolso PayPal desde el panel, en tres pasos:
//  1. Transacción con el pedido bloqueado: se crea (o se retoma) una fila Refund PENDING con las opciones
//     del admin. Solo puede haber UNA pendiente por pago: un doble clic u otra pestaña retoma la misma.
//  2. Llamada a PayPal con PayPal-Request-Id = `refund-<id de la fila>`: repetirla nunca reembolsa dos veces.
//  3. Transacción: la fila pasa a COMPLETED y se aplica al pedido (una sola vez).
// Si el webhook PAYMENT.CAPTURE.REFUNDED llega antes del paso 3, adopta la fila pendiente (por invoice_id
// `refund-<id>` o, si falta, por monto) y aplica las opciones que eligió el admin.

export interface RefundOptions {
  /** Desmatricular de Moodle. Por defecto: sí cuando el pedido queda reembolsado por completo. */
  unenroll?: boolean;
  /** Liberar el cupo de la cohorte. Por defecto: sí cuando el pedido queda reembolsado por completo. */
  releaseSeat?: boolean;
  /**
   * Conservar el certificado del diplomado aunque el pedido quede reembolsado por completo (cortesía).
   * Por defecto, un reembolso total REVOCA los certificados emitidos por este pedido.
   */
  keepCertificate?: boolean;
}

export interface RefundInput extends RefundOptions {
  paymentId: string;
  /** USD en centavos; por defecto todo lo reembolsable del pago. */
  amountCents?: number;
  reason?: string | null;
  /** Registrar un reembolso hecho fuera del sistema (obligatorio en métodos manuales). */
  manual?: boolean;
  /**
   * Clave de idempotencia del envío (p.ej. un id generado al abrir el formulario). Reenviar la misma clave
   * devuelve el reembolso ya hecho (o retoma el pendiente) en vez de reembolsar otra vez.
   */
  idempotencyKey?: string | null;
  /**
   * Confirmar que es OTRO reembolso del mismo monto sobre el mismo pago hecho hace menos de
   * REPEAT_WINDOW_MS (sin esto se rechaza como probable doble envío: doble clic, dos pestañas).
   */
  confirmRepeat?: boolean;
}

const REPEAT_WINDOW_MS = 10 * 60_000;

function refundOptionsOf(v: unknown): RefundOptions {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const b = (x: unknown) => (typeof x === "boolean" ? x : undefined);
  return { unenroll: b(o.unenroll), releaseSeat: b(o.releaseSeat), keepCertificate: b(o.keepCertificate) };
}

const optionsJson = (o: RefundOptions) => JSON.parse(JSON.stringify(o)) as object;

interface ApplyRefundInput {
  paymentId: string;
  amountCents: number;
  providerRefundId?: string | null;
  /** Fila Refund PENDING/FAILED creada antes de llamar a PayPal: se completa en vez de crear otra. */
  refundRowId?: string | null;
  requestKey?: string | null;
  manual: boolean;
  reason?: string | null;
  adminId?: string | null;
  options: RefundOptions;
  actor: Actor;
}

type RefundResult = { refund: Refund; fullyRefunded: boolean; orderId: string; duplicate: boolean };

async function applyRefund(tx: Tx, input: ApplyRefundInput, now: Date): Promise<RefundResult> {
  const { orderId: lockedOrderId } = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId }, select: { orderId: true } });
  await lockOrder(tx, lockedOrderId, now);
  const p = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
  const dup = async (refund: RefundResult["refund"]) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: p.orderId }, select: { status: true } });
    return { refund, fullyRefunded: o.status === "REFUNDED", orderId: p.orderId, duplicate: true };
  };
  if (input.providerRefundId) {
    // El otro camino (webhook PAYMENT.CAPTURE.REFUNDED o el panel) ya registró este mismo reembolso.
    const existing = await tx.refund.findUnique({ where: { providerRefundId: input.providerRefundId } });
    if (existing && existing.id !== input.refundRowId) return dup(existing);
  }
  let row = input.refundRowId ? await tx.refund.findUnique({ where: { id: input.refundRowId } }) : null;
  if (input.refundRowId && !row) throw new DomainError("NOT_FOUND", "El reembolso no existe.");
  if (row?.status === "COMPLETED") return dup(row);

  const refundable = p.amountUsdCents - p.refundedCents;
  if (input.amountCents > refundable) throw new DomainError("VALIDATION", `El monto supera lo reembolsable (${(refundable / 100).toFixed(2)} USD).`);
  const done = { status: "COMPLETED" as const, completedAt: now, providerRefundId: input.providerRefundId ?? null, error: null };
  if (row) {
    const n = await tx.refund.updateMany({ where: { id: row.id, status: { not: "COMPLETED" } }, data: { ...done, amountCents: input.amountCents } });
    if (n.count !== 1) return dup(row);
    row = await tx.refund.findUniqueOrThrow({ where: { id: row.id } });
  } else {
    row = await tx.refund.create({
      data: { paymentId: p.id, amountCents: input.amountCents, reason: input.reason ?? null, manual: input.manual, createdById: input.adminId ?? null, requestKey: input.requestKey ?? null, options: optionsJson(input.options), ...done },
    });
  }
  const refund = row;
  const { releaseSeat, keepCertificate } = input.options;
  const { refundedCents: refunded } = await tx.payment.update({ where: { id: p.id }, data: { refundedCents: { increment: input.amountCents } }, select: { refundedCents: true } });
  await tx.payment.update({ where: { id: p.id }, data: { status: refunded >= p.amountUsdCents ? "REFUNDED" : "PARTIALLY_REFUNDED" } });
  const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
  const adjBefore = (await tx.balanceAdjustment.aggregate({ where: { orderId: order.id }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const balanceBefore = order.totalCents + adjBefore - order.amountPaidCents;
  await tx.order.update({ where: { id: order.id }, data: { amountPaidCents: { decrement: input.amountCents } } });
  // Reembolso parcial de CORTESÍA (sin retiro: no libera cupo ni desmatricula) sobre un pedido ya pagado por
  // completo: lo devuelto es un descuento posterior, no una deuda. Sin esto el saldo volvería a ser positivo, la
  // cuota (en el plan de contado, vencida desde el checkout) se reabriría y el job de cuotas le cobraría al médico
  // lo que se le acaba de devolver. Se registra como ajuste (condonación) y se reducen las cuotas pagadas.
  const courtesy = input.options.releaseSeat !== true && input.options.unenroll !== true && PAID_STATES.includes(order.status) && balanceBefore <= 0 && order.amountPaidCents - input.amountCents > 0;
  const forgiven = courtesy ? Math.max(0, balanceBefore + input.amountCents) : 0;
  if (forgiven > 0) await forgiveRefundedAmount(tx, order.id, forgiven, refund.reason ?? input.reason ?? null, input, now);
  const balance = await recomputeBalance(tx, order.id);
  // Las cuotas se vuelven a imputar con el neto pagado: la última cubierta vuelve a quedar pendiente.
  const realloc = await reallocateInstallments(tx, order.id, now);
  await addOrderEvent(tx, order.id, "REFUND", input.actor, refund.reason ?? input.reason ?? null, {
    paymentId: p.id,
    refundId: refund.id,
    amountCents: input.amountCents,
    manual: input.manual,
    balanceCents: balance,
    installmentsReopened: realloc.becameUnpaid.map((i) => i.sequence),
    ...(refund.createdById && input.actor.type !== "ADMIN" ? { requestedById: refund.createdById } : {}),
    options: optionsJson(input.options) as Prisma.InputJsonValue,
  });

  const agg = await tx.payment.aggregate({ where: { orderId: order.id, status: { in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] } }, _sum: { amountUsdCents: true, refundedCents: true } });
  const fullyRefunded = (agg._sum.amountUsdCents ?? 0) > 0 && (agg._sum.refundedCents ?? 0) >= (agg._sum.amountUsdCents ?? 0);
  if (fullyRefunded) {
    if (releaseSeat !== false) await releaseOrderReservations(tx, order.id, "REFUNDED", now, input.actor);
    if (["PAID", "PARTIALLY_PAID", "ENROLLED"].includes(order.status)) {
      await transitionOrder(tx, order.id, "REFUNDED", { actor: input.actor, note: refund.reason ?? "Reembolso total", patch: { cancelledAt: now } });
    }
  } else if (releaseSeat === true) {
    await releaseOrderReservations(tx, order.id, "REFUNDED", now, input.actor);
  }
  // Retiro con retención: un reembolso PARCIAL con el que el admin saca al médico del programa (libera su cupo o
  // lo desmatricula de todos los cursos del pedido) cierra el pedido (REFUNDED, saldo 0). Si no, seguiría
  // «Inscrito» sin cupo ni acceso, con saldo pendiente, y el job de cuotas le pediría pagar el resto.
  if (!fullyRefunded && (releaseSeat === true || input.options.unenroll === true) && ["PAID", "PARTIALLY_PAID", "ENROLLED"].includes(order.status)) {
    const { amountPaidCents: retained } = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { amountPaidCents: true } });
    const note = `${refund.reason ?? "Reembolso parcial"} (retiro del programa; se retuvieron ${(retained / 100).toFixed(2)} USD)`;
    await transitionOrder(tx, order.id, "REFUNDED", { actor: input.actor, note, patch: { cancelledAt: now } });
  }

  // Mes a mes: una cuota que vuelve a quedar impaga con su curso ya matriculado → decisión del admin.
  if (!fullyRefunded) {
    for (const ins of realloc.becameUnpaid) {
      if (ins.moodleCourseId == null) continue;
      const enr = await tx.enrollment.findUnique({ where: { customerId_moodleCourseId: { customerId: order.customerId, moodleCourseId: ins.moodleCourseId } } });
      if (enr?.status === "ENROLLED") {
        await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, `Tras el reembolso la cuota ${ins.sequence} quedó sin pagar, pero su curso (Moodle ${ins.moodleCourseId}) sigue matriculado: desmatricula o registra el pago.`, { installmentId: ins.id, moodleCourseId: ins.moodleCourseId });
      }
    }
  }

  // Certificados emitidos por este pedido: un reembolso total los revoca (salvo keepCertificate); uno
  // parcial que deja saldo lo avisa en el panel (el certificado exige el diplomado pagado completo).
  const certs = await tx.certificate.findMany({ where: { status: "ISSUED", orderItem: { orderId: order.id } } });
  for (const c of certs) {
    if (fullyRefunded && keepCertificate !== true) {
      const reason = "Pedido reembolsado por completo";
      const n = await tx.certificate.updateMany({ where: { id: c.id, status: "ISSUED" }, data: { status: "REVOKED", revokedAt: now, revokeReason: reason } });
      if (n.count === 1) await addOrderEvent(tx, order.id, "CERTIFICATE_REVOKED", input.actor, `Certificado ${c.code} revocado: ${reason}`, { certificateId: c.id, code: c.code, revokedAt: now.toISOString() });
    } else if (balance > 0) {
      await addOrderEvent(tx, order.id, "ATTENTION", SYSTEM, `El certificado ${c.code} sigue vigente, pero el pedido quedó con saldo pendiente (${(balance / 100).toFixed(2)} USD) tras el reembolso: revócalo desde el panel si corresponde.`, { certificateId: c.id });
    }
  }
  return { refund, fullyRefunded, orderId: order.id, duplicate: false };
}

/**
 * Descuento posterior por un reembolso de cortesía: BalanceAdjustment negativo por lo que dejaría de estar pagado
 * y las cuotas pagadas se reducen desde la última (una que queda en 0 pasa a WAIVED, fuera de la imputación), así
 * la reimputación posterior las mantiene pagadas y el pedido no queda con saldo ni cuotas vencidas.
 */
async function forgiveRefundedAmount(tx: Tx, orderId: string, amountCents: number, reason: string | null, input: ApplyRefundInput, now: Date) {
  const note = `Reembolso parcial de cortesía de ${(input.amountCents / 100).toFixed(2)} USD sobre un pedido pagado: lo devuelto se descuenta del total y no queda como deuda${reason ? ` (${reason})` : ""}.`;
  await tx.balanceAdjustment.create({ data: { orderId, amountCents: -amountCents, reason: note, createdById: input.adminId ?? null } });
  const list = await tx.installment.findMany({ where: { orderId, status: { not: "WAIVED" } }, orderBy: { sequence: "desc" } });
  let left = amountCents;
  const touched: { sequence: number; beforeCents: number; afterCents: number; waived: boolean }[] = [];
  for (const ins of list) {
    if (left <= 0) break;
    const take = Math.min(left, ins.amountCents);
    if (take <= 0) continue;
    left -= take;
    const after = ins.amountCents - take;
    const waived = after === 0;
    await tx.installment.update({ where: { id: ins.id }, data: waived ? { status: "WAIVED", paidCents: 0, paidAt: ins.paidAt ?? now } : { amountCents: after } });
    touched.push({ sequence: ins.sequence, beforeCents: ins.amountCents, afterCents: after, waived });
  }
  await addOrderEvent(tx, orderId, "BALANCE_ADJUSTED", input.actor, note, { amountCents: -amountCents, cause: "COURTESY_REFUND", paymentId: input.paymentId, installments: touched });
}

async function afterRefund(d: Deps, r: RefundResult, method: PaymentMethod, unenroll: boolean | undefined, actor: Actor) {
  if (unenroll ?? r.fullyRefunded) {
    try {
      await unenrollOrder(d, r.orderId, actor);
    } catch (e) {
      d.log.error(`[refund] no se pudo desmatricular el pedido ${r.orderId}`, e);
      // El job de matrículas la reintenta (retryFailedUnenrollments) hasta que Moodle responda.
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      await d.db.$transaction(async (tx) => {
        await addOrderEvent(tx, r.orderId, UNENROLLMENT_FAILED, SYSTEM, `No se pudo desmatricular en Moodle: ${msg}`, { refundId: r.refund.id, error: msg });
        await addOrderEvent(tx, r.orderId, "ATTENTION", SYSTEM, `No se pudo desmatricular en Moodle (${msg}). Se reintentará automáticamente; el médico conserva el acceso hasta entonces.`, { refundId: r.refund.id });
      });
    }
  }
  // Sin desmatricular («conservar Moodle») y con una matrícula que nunca se completó: el pedido cerrado ya no se
  // matriculará; no se deja «pendiente» para siempre.
  if (r.fullyRefunded) {
    try {
      await closePendingEnrollments(d, r.orderId, actor);
    } catch (e) {
      d.log.error(`[refund] no se pudieron cerrar las matrículas pendientes del pedido ${r.orderId}`, e);
    }
  }
  await safeNotify(d, "refund_issued", async () => {
    const { view, email, customerId } = await buildOrderView(d, r.orderId);
    await sendEmail(d, { template: "refund_issued", to: email, rendered: T.refundIssued(view, { amountCents: r.refund.amountCents, methodLabel: T.METHOD_LABELS[method] ?? method, reason: r.refund.reason, full: r.fullyRefunded }), dedupeKey: `refund:${r.refund.id}`, orderId: r.orderId, customerId });
  });
}

/** Error de PayPal que asegura que el reembolso NO se hizo (4xx de validación), frente a uno incierto (red, 5xx). */
function isDefinitiveProviderError(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  const code = typeof status === "number" ? status : Number(/\b([45]\d\d)\b/.exec(String((e as Error)?.message ?? e))?.[1] ?? NaN);
  return code >= 400 && code < 500 && code !== 408 && code !== 409 && code !== 429;
}

/** Reembolso desde el panel (solo ADMIN): PayPal vía API (salvo `manual`), métodos manuales como registro. */
export async function refundPayment(d: Deps, user: SessionUser, input: RefundInput) {
  const admin = await requireAdmin(d.db, user, "payments.refund");
  return executeRefund(d, input, { type: "ADMIN", id: admin.id });
}

async function executeRefund(d: Deps, input: RefundInput, actor: Actor): Promise<RefundResult> {
  const now = d.now();
  const adminId = actor.type === "ADMIN" ? (actor.id ?? null) : null;
  const requestKey = input.idempotencyKey?.trim() || null;
  const options: RefundOptions = { unenroll: input.unenroll, releaseSeat: input.releaseSeat, keepCertificate: input.keepCertificate };
  const head = await d.db.payment.findUnique({ where: { id: input.paymentId }, select: { id: true, orderId: true, method: true } });
  if (!head) throw new DomainError("NOT_FOUND", "El pago no existe.");
  const viaApi = head.method === "PAYPAL" && !input.manual;

  // 1. Reservar (o retomar) la fila del reembolso con el pedido bloqueado. Los manuales se aplican aquí mismo.
  type Prep = { kind: "done"; result: RefundResult } | { kind: "call"; rowId: string; captureId: string; amountCents: number; reason: string | null; options: RefundOptions };
  const prep: Prep = await withTx(
    d,
    async (tx): Promise<Prep> => {
      await lockOrder(tx, head.orderId, now);
      if (requestKey) {
        const prev = await tx.refund.findUnique({ where: { requestKey } });
        if (prev && prev.paymentId !== head.id) throw new DomainError("CONFLICT", "Esa clave de reembolso pertenece a otro pago.");
        if (prev?.status === "COMPLETED") {
          const o = await tx.order.findUniqueOrThrow({ where: { id: head.orderId }, select: { status: true } });
          return { kind: "done", result: { refund: prev, fullyRefunded: o.status === "REFUNDED", orderId: head.orderId, duplicate: true } };
        }
        if (prev?.status === "FAILED") throw new DomainError("PAYMENT_PROVIDER", "Ese reembolso ya falló en PayPal; revisa el motivo e inicia uno nuevo.", { refundId: prev.id, cause: prev.error });
        if (prev) {
          const p = await tx.payment.findUniqueOrThrow({ where: { id: head.id } });
          return { kind: "call", rowId: prev.id, captureId: p.paypalCaptureId!, amountCents: prev.amountCents, reason: prev.reason, options: refundOptionsOf(prev.options) };
        }
      }
      const p = await tx.payment.findUniqueOrThrow({ where: { id: head.id } });
      if (p.status !== "COMPLETED" && p.status !== "PARTIALLY_REFUNDED") throw new DomainError("INVALID_STATE", "Solo se pueden reembolsar pagos confirmados.");
      const refundable = p.amountUsdCents - p.refundedCents;
      const pending = await tx.refund.findFirst({ where: { paymentId: p.id, status: "PENDING" }, orderBy: { createdAt: "asc" } });
      if (viaApi && pending) {
        // Doble clic / otra pestaña / reintento tras un error de red: se retoma el MISMO reembolso (mismo
        // PayPal-Request-Id), nunca se abre otro mientras ese no se resuelva.
        if (input.amountCents != null && input.amountCents !== pending.amountCents) {
          throw new DomainError("CONFLICT", `Ya hay un reembolso de ${(pending.amountCents / 100).toFixed(2)} USD en curso para este pago; espera su confirmación.`, { refundId: pending.id });
        }
        return { kind: "call", rowId: pending.id, captureId: p.paypalCaptureId!, amountCents: pending.amountCents, reason: pending.reason, options: refundOptionsOf(pending.options) };
      }
      const amount = input.amountCents ?? refundable;
      if (!Number.isInteger(amount) || amount <= 0 || amount > refundable) throw new DomainError("VALIDATION", `El monto debe estar entre 0.01 y ${(refundable / 100).toFixed(2)} USD.`);
      if (!input.confirmRepeat && actor.type === "ADMIN") {
        // Mismo pago, mismo monto, hace un momento: casi seguro un doble envío (otra pestaña, doble clic).
        const recent = await tx.refund.findFirst({ where: { paymentId: p.id, amountCents: amount, status: { in: ["PENDING", "COMPLETED"] }, createdAt: { gte: new Date(now.getTime() - REPEAT_WINDOW_MS) } } });
        if (recent) throw new DomainError("CONFLICT", `Ya se reembolsaron ${(amount / 100).toFixed(2)} USD de este pago hace un momento. Si de verdad es otro reembolso, confírmalo.`, { refundId: recent.id, needsConfirmRepeat: true });
      }
      if (!viaApi) {
        const result = await applyRefund(tx, { paymentId: p.id, amountCents: amount, manual: true, reason: input.reason, adminId, requestKey, options, actor }, now);
        return { kind: "done", result };
      }
      if (!p.paypalCaptureId) throw new DomainError("INVALID_STATE", "El pago PayPal no tiene captura asociada.");
      const row = await tx.refund.create({
        data: { paymentId: p.id, amountCents: amount, reason: input.reason ?? null, status: "PENDING", manual: false, createdById: adminId, requestKey, options: optionsJson(options), createdAt: now },
      });
      await addOrderEvent(tx, p.orderId, "REFUND_REQUESTED", actor, input.reason ?? null, { paymentId: p.id, refundId: row.id, amountCents: amount, options: optionsJson(options) as Prisma.InputJsonValue });
      return { kind: "call", rowId: row.id, captureId: p.paypalCaptureId, amountCents: amount, reason: row.reason, options };
    },
    { retryUnique: true },
  );

  if (prep.kind === "done") {
    if (!prep.result.duplicate) await afterRefund(d, prep.result, head.method, options.unenroll, actor);
    return prep.result;
  }

  // 2. PayPal, idempotente por fila.
  let providerRefundId: string;
  try {
    const res = normalizeRefund(await d.paypal.refundCapture(prep.captureId, prep.amountCents, { requestId: `refund-${prep.rowId}`, invoiceId: `refund-${prep.rowId}`, noteToPayer: prep.reason ?? undefined }));
    if (res.status === "FAILED" || res.status === "CANCELLED") throw Object.assign(new Error(`PayPal devolvió estado ${res.status}`), { status: 422 });
    providerRefundId = res.id;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    if (isDefinitiveProviderError(e)) {
      await d.db.refund.updateMany({ where: { id: prep.rowId, status: "PENDING" }, data: { status: "FAILED", error: msg } });
      throw new DomainError("PAYMENT_PROVIDER", "PayPal no procesó el reembolso.", { cause: msg, refundId: prep.rowId });
    }
    // Resultado incierto: la fila sigue PENDING. Reintentar retoma el mismo PayPal-Request-Id (no duplica) y
    // el webhook PAYMENT.CAPTURE.REFUNDED la completa si PayPal sí lo hizo.
    await d.db.refund.updateMany({ where: { id: prep.rowId, status: "PENDING" }, data: { error: msg } });
    throw new DomainError("PAYMENT_PROVIDER", "PayPal no respondió. El reembolso quedó en curso: vuelve a intentarlo (no se duplicará) o espera la confirmación de PayPal.", { cause: msg, refundId: prep.rowId, pending: true });
  }

  // 3. Aplicar (o constatar que el webhook ya lo aplicó con estas mismas opciones).
  let result: RefundResult;
  try {
    result = await withTx(d, (tx) =>
      applyRefund(tx, { paymentId: head.id, amountCents: prep.amountCents, providerRefundId, refundRowId: prep.rowId, manual: false, reason: prep.reason, adminId, options: prep.options, actor }, now),
    );
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const existing = await d.db.refund.findUniqueOrThrow({ where: { providerRefundId } });
    const o = await d.db.order.findUniqueOrThrow({ where: { id: head.orderId }, select: { status: true } });
    result = { refund: existing, fullyRefunded: o.status === "REFUNDED", orderId: head.orderId, duplicate: true };
  }
  if (result.duplicate) {
    // El webhook de PayPal lo registró primero, con las opciones del admin (guardadas en la fila).
    await withTx(d, (tx) => addOrderEvent(tx, head.orderId, "NOTE", actor, `Reembolso PayPal ${providerRefundId} confirmado (ya registrado por el webhook de PayPal).`, { refundId: result.refund.id }));
    return result;
  }
  await afterRefund(d, result, head.method, prep.options.unenroll, actor);
  return result;
}

/**
 * Job: reembolsos PayPal que quedaron PENDING (PayPal no respondió / timeout y el webhook PAYMENT.CAPTURE.REFUNDED
 * nunca llegó). Se retoman con el MISMO PayPal-Request-Id (`refund-<fila>`), así que si PayPal ya lo hizo devuelve
 * ese mismo reembolso y se aplica una sola vez con las opciones que eligió el admin (cupo, matrícula, certificado);
 * si no lo hizo, lo hace ahora. Un rechazo definitivo deja la fila FAILED y un ATTENTION en el pedido; si sigue sin
 * respuesta después de `attentionAfterMs`, también se avisa (una vez) para que el equipo lo revise en PayPal.
 */
export async function reconcilePendingRefunds(d: Deps, opts: { minAgeMs?: number; attentionAfterMs?: number } = {}) {
  const now = d.now().getTime();
  const rows = await d.db.refund.findMany({
    where: { status: "PENDING", manual: false, createdAt: { lte: new Date(now - (opts.minAgeMs ?? 5 * 60_000)) } },
    select: { id: true, paymentId: true, amountCents: true, requestKey: true, createdAt: true, payment: { select: { orderId: true } } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const out = { checked: rows.length, completed: 0, pending: 0, failed: 0, errors: 0 };
  const usd = (c: number) => `${(c / 100).toFixed(2)} USD`;
  const attention = async (orderId: string, rowId: string, note: string) => {
    const seen = await d.db.orderEvent.findFirst({ where: { orderId, type: "ATTENTION", note: { contains: rowId } }, select: { id: true } });
    if (!seen) await withTx(d, (tx) => addOrderEvent(tx, orderId, "ATTENTION", SYSTEM, note, { refundId: rowId }));
  };
  for (const r of rows) {
    // Solo si sigue PENDING (otro proceso o el webhook pudo resolverla mientras tanto).
    if ((await d.db.refund.findUnique({ where: { id: r.id }, select: { status: true } }))?.status !== "PENDING") continue;
    try {
      await executeRefund(d, { paymentId: r.paymentId, idempotencyKey: r.requestKey }, SYSTEM);
      out.completed++;
    } catch (e) {
      const row = await d.db.refund.findUnique({ where: { id: r.id }, select: { status: true, error: true } });
      const det = isDomainError(e) ? (e.details ?? {}) : {};
      if (row?.status === "COMPLETED") {
        out.completed++;
      } else if (row?.status === "FAILED") {
        out.failed++;
        await attention(r.payment.orderId, r.id, `PayPal rechazó el reembolso de ${usd(r.amountCents)} (fila ${r.id}): ${String(row.error ?? "").slice(0, 200)}. El dinero NO se devolvió: revísalo e inicia uno nuevo.`);
      } else if (isDomainError(e) && e.code === "INVALID_STATE") {
        // El pago ya no es reembolsable (p.ej. se reembolsó completo por otra vía): la fila no puede completarse.
        await d.db.refund.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "FAILED", error: e.message } });
        out.failed++;
        await attention(r.payment.orderId, r.id, `El reembolso de ${usd(r.amountCents)} (fila ${r.id}) no se pudo confirmar: ${e.message} Revisa en PayPal si el dinero se devolvió.`);
      } else {
        if (det.pending === true) out.pending++;
        else out.errors++;
        d.log.warn(`[paypal] reembolso ${r.id} sigue sin confirmar`, e);
        if (now - r.createdAt.getTime() >= (opts.attentionAfterMs ?? 24 * 3600_000)) {
          await attention(r.payment.orderId, r.id, `El reembolso PayPal de ${usd(r.amountCents)} (fila ${r.id}) sigue sin confirmar desde ${r.createdAt.toISOString()}: PayPal no responde. Revísalo en PayPal.`);
        }
      }
    }
  }
  return out;
}

/** Webhook PAYMENT.CAPTURE.REFUNDED: registra reembolsos hechos desde PayPal (o confirma los nuestros). */
export async function onPaypalRefundCompleted(d: Deps, input: { captureId: string; refundId: string; amountCents?: number; reason?: string | null; invoiceId?: string | null }) {
  if (await d.db.refund.findUnique({ where: { providerRefundId: input.refundId } })) return { duplicate: true };
  const p = await d.db.payment.findUnique({ where: { paypalCaptureId: input.captureId } });
  if (!p) throw new DomainError("NOT_FOUND", "No existe un pago para esa captura.");
  // ¿Es un reembolso pedido desde el panel cuya respuesta aún no se procesó? Se adopta su fila y sus opciones.
  const rowId = input.invoiceId?.match(/^refund-(.+)$/)?.[1];
  let row = rowId ? await d.db.refund.findFirst({ where: { id: rowId, paymentId: p.id } }) : null;
  if (!row) {
    row = await d.db.refund.findFirst({
      where: { paymentId: p.id, status: "PENDING", manual: false, ...(input.amountCents != null ? { amountCents: input.amountCents } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }
  if (row?.status === "COMPLETED") return { duplicate: true };
  const refundable = p.amountUsdCents - p.refundedCents;
  const amount = Math.min(input.amountCents ?? row?.amountCents ?? refundable, refundable);
  if (amount <= 0) return { duplicate: true };
  const options = row ? refundOptionsOf(row.options) : {};
  const actor: Actor = { type: "WEBHOOK" };
  let result;
  try {
    result = await withTx(d, (tx) =>
      applyRefund(
        tx,
        { paymentId: p.id, amountCents: amount, providerRefundId: input.refundId, refundRowId: row?.id ?? null, manual: false, reason: row?.reason ?? input.reason ?? "Reembolso registrado por PayPal", adminId: row?.createdById ?? null, options, actor },
        d.now(),
      ),
    );
  } catch (e) {
    if (isUniqueViolation(e)) return { duplicate: true };
    throw e;
  }
  if (result.duplicate) return { duplicate: true }; // el panel lo registró mientras tanto
  await afterRefund(d, result, "PAYPAL", options.unenroll, actor);
  return result;
}
