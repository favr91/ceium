// Correcciones del panel sobre un pedido: ajustes de saldo, condonación de cuotas y reasignación de cohorte.
//
// Saldo y cuotas NUNCA divergen: balance = total + Σ ajustes − pagado, y la suma de las cuotas no
// condonadas es siempre total + Σ ajustes. Por eso todo ajuste se refleja en el calendario de cuotas:
//  - Condonar (monto negativo): se descuenta de las cuotas impagas en orden de secuencia (o de la cuota
//    indicada). Una cuota condonada por completo queda WAIVED (cuenta como pagada: en el plan mes a mes
//    habilita su curso, y la matrícula se dispara); una condonada en parte baja su monto.
//  - Cargo extra (monto positivo): se agrega una cuota nueva al final, sin curso asociado.
// Tras el ajuste: si el pedido no tenía el primer pago y la condonación lo cubre, se confirma el cupo y
// pasa a PAID/PARTIALLY_PAID; un PARTIALLY_PAID que queda en 0 pasa a PAID. Luego se matricula lo habilitado.
import type { OrderStatus } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import { withTx } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { addOrderEvent, PAID_STATES, lockOrder, recomputeBalance, reservationTtlMs, transitionOrder, type Actor } from "@/server/orders";
import { reassignItemCohort } from "@/server/seats";
import { reallocateInstallments } from "@/server/installments";
import { satisfyFirstPayment } from "@/server/payments";
import { enrollOrder, resendCohortDetails } from "@/server/enrollment";
import { formatUSD } from "@/server/pricing";

const ADJUSTABLE: readonly OrderStatus[] = ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"];
const FIRST_PAYMENT_PENDING: readonly OrderStatus[] = ["PENDING_PAYMENT", "AWAITING_VERIFICATION"];

export interface AdjustmentResult {
  balanceCents: number;
  dueNowCents: number;
  orderStatus: OrderStatus;
  /** Cuotas tocadas: monto antes/después y si quedaron condonadas. */
  installments: { id: string; sequence: number; beforeCents: number; afterCents: number; waived: boolean }[];
  /** La condonación cubrió el primer pago (cupo confirmado, pedido pagado). */
  firstPaymentSatisfied: boolean;
  seatProblem: boolean;
  enrollment?: Awaited<ReturnType<typeof enrollOrder>> | { status: "ERROR"; reason: string };
}

interface AdjustInput {
  orderId: string;
  amountCents: number;
  reason: string;
  adminId: string;
  /** Condonar solo esta cuota. */
  installmentId?: string | null;
  eventType: "BALANCE_ADJUSTED" | "INSTALLMENT_WAIVED";
}

async function applyAdjustment(tx: Tx, input: AdjustInput, now: Date) {
  const actor: Actor = { type: "ADMIN", id: input.adminId };
  await lockOrder(tx, input.orderId, now);
  const order = await tx.order.findUnique({ where: { id: input.orderId } });
  if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
  if (!ADJUSTABLE.includes(order.status)) throw new DomainError("INVALID_STATE", `No se puede ajustar el saldo de un pedido en estado ${order.status}.`);
  const list = await tx.installment.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
  const placed = (order.placedAt ?? order.createdAt).getTime();
  const isInitial = (dueDate: Date | null) => !dueDate || dueDate.getTime() <= placed;
  const touched: AdjustmentResult["installments"] = [];
  let takenInitial = 0;

  if (input.amountCents < 0) {
    const forgive = -input.amountCents;
    const balance = await recomputeBalance(tx, order.id);
    if (forgive > balance) throw new DomainError("VALIDATION", `La condonación (${formatUSD(forgive)}) supera el saldo pendiente (${formatUSD(Math.max(0, balance))}).`);
    const unpaid = list.filter((i) => i.status !== "PAID" && i.status !== "WAIVED" && i.amountCents > i.paidCents);
    let targets = unpaid;
    if (input.installmentId) {
      const t = list.find((i) => i.id === input.installmentId);
      if (!t) throw new DomainError("NOT_FOUND", "La cuota no existe en este pedido.");
      if (t.status === "PAID" || t.status === "WAIVED" || t.amountCents <= t.paidCents) throw new DomainError("INVALID_STATE", `La cuota ${t.sequence} ya está saldada.`);
      if (forgive > t.amountCents - t.paidCents) throw new DomainError("VALIDATION", `La cuota ${t.sequence} solo tiene ${formatUSD(t.amountCents - t.paidCents)} pendientes.`);
      targets = [t];
    }
    let left = forgive;
    for (const ins of targets) {
      if (left <= 0) break;
      const take = Math.min(left, ins.amountCents - ins.paidCents);
      if (take <= 0) continue;
      left -= take;
      const after = ins.amountCents - take;
      const waived = after === 0;
      // Condonada por completo: WAIVED conserva su monto original (historial) y queda fuera de la imputación.
      await tx.installment.update({ where: { id: ins.id }, data: waived ? { status: "WAIVED", paidCents: 0, paidAt: now } : { amountCents: after } });
      if (isInitial(ins.dueDate)) takenInitial += take;
      touched.push({ id: ins.id, sequence: ins.sequence, beforeCents: ins.amountCents, afterCents: after, waived });
    }
    if (left > 0) throw new DomainError("CONFLICT", "El calendario de cuotas no cuadra con el saldo; revisa el pedido antes de ajustar.");
  } else {
    const seq = (list.at(-1)?.sequence ?? 0) + 1;
    const ins = await tx.installment.create({ data: { orderId: order.id, sequence: seq, amountCents: input.amountCents, dueDate: now } });
    touched.push({ id: ins.id, sequence: seq, beforeCents: 0, afterCents: input.amountCents, waived: false });
  }

  await tx.balanceAdjustment.create({ data: { orderId: order.id, amountCents: input.amountCents, reason: input.reason, createdById: input.adminId } });
  const balance = await recomputeBalance(tx, order.id);
  await reallocateInstallments(tx, order.id, now);

  let dueNow = order.dueNowCents;
  if (FIRST_PAYMENT_PENDING.includes(order.status) && takenInitial > 0) {
    dueNow = Math.max(0, order.dueNowCents - takenInitial);
    await tx.order.update({ where: { id: order.id }, data: { dueNowCents: dueNow } });
  }
  await addOrderEvent(tx, order.id, input.eventType, actor, input.reason, {
    amountCents: input.amountCents,
    balanceCents: balance,
    dueNowCents: dueNow,
    installments: touched.map((t) => ({ sequence: t.sequence, beforeCents: t.beforeCents, afterCents: t.afterCents, waived: t.waived })),
  });

  let firstPaymentSatisfied = false;
  let seatProblem = false;
  if (FIRST_PAYMENT_PENDING.includes(order.status) && order.amountPaidCents >= dueNow) {
    firstPaymentSatisfied = true;
    seatProblem = (await satisfyFirstPayment(tx, order.id, actor, now, { balanceCents: balance, note: "Primer pago cubierto por un ajuste del administrador" })).seatProblem;
  } else if (order.status === "PARTIALLY_PAID" && balance <= 0) {
    await transitionOrder(tx, order.id, "PAID", { actor, note: "Saldo cancelado por ajuste del administrador" });
  }
  const after = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
  return { balanceCents: balance, dueNowCents: dueNow, orderStatus: after.status, installments: touched, firstPaymentSatisfied, seatProblem };
}

async function runAdjustment(d: Deps, input: AdjustInput): Promise<AdjustmentResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) throw new DomainError("VALIDATION", "El ajuste debe ser un monto entero distinto de cero (centavos).");
  const reason = input.reason?.trim();
  if (!reason) throw new DomainError("VALIDATION", "Indica el motivo del ajuste.");
  const r: AdjustmentResult = await withTx(d, (tx) => applyAdjustment(tx, { ...input, reason }, d.now()));
  // Cuotas condonadas (mes a mes: su curso) o primer pago cubierto → matricular lo que corresponda.
  if (PAID_STATES.includes(r.orderStatus) && !r.seatProblem) {
    try {
      r.enrollment = await enrollOrder(d, input.orderId, { actor: { type: "ADMIN", id: input.adminId } });
    } catch (e) {
      d.log.error(`[corrections] matrícula tras ajuste del pedido ${input.orderId} falló; el job la reintentará`, e);
      r.enrollment = { status: "ERROR", reason: String((e as Error)?.message ?? e) };
    }
  }
  return r;
}

/**
 * Ajuste manual de saldo (centavos USD): negativo condona (de la siguiente cuota impaga en adelante),
 * positivo agrega un cargo como cuota nueva al final. Devuelve el saldo resultante.
 */
export async function adjustBalance(d: Deps, orderId: string, amountCents: number, reason: string, adminId: string): Promise<number> {
  return (await adjustBalanceDetailed(d, orderId, amountCents, reason, adminId)).balanceCents;
}

/** Igual que adjustBalance, con el detalle (cuotas tocadas, estado, matrícula) para el panel. */
export async function adjustBalanceDetailed(d: Deps, orderId: string, amountCents: number, reason: string, adminId: string): Promise<AdjustmentResult> {
  return runAdjustment(d, { orderId, amountCents, reason, adminId, eventType: "BALANCE_ADJUSTED" });
}

/**
 * Condona lo que falta de una cuota (beca de un mes, curso bonificado). En el plan mes a mes la cuota
 * condonada habilita su curso del diplomado y se matricula de inmediato.
 */
export async function waiveInstallment(d: Deps, installmentId: string, reason: string, adminId: string): Promise<AdjustmentResult> {
  const ins = await d.db.installment.findUnique({ where: { id: installmentId } });
  if (!ins) throw new DomainError("NOT_FOUND", "La cuota no existe.");
  const pending = ins.amountCents - ins.paidCents;
  if (ins.status === "PAID" || ins.status === "WAIVED" || pending <= 0) throw new DomainError("INVALID_STATE", `La cuota ${ins.sequence} ya está saldada.`);
  return runAdjustment(d, { orderId: ins.orderId, amountCents: -pending, reason, adminId, installmentId, eventType: "INSTALLMENT_WAIVED" });
}

/**
 * Corrección manual: reasignar la cohorte de un ítem (o volver a tomar cupo en la misma si se había
 * perdido). En un pedido ya pagado el cupo nuevo queda CONFIRMED y se dispara la matrícula (o, si ya estaba
 * matriculado, se envían los datos de la nueva cohorte).
 */
export async function reassignCohort(d: Deps, orderItemId: string, newCohortId: string, adminId: string, note?: string) {
  const item = await d.db.orderItem.findUnique({ where: { id: orderItemId }, include: { order: { select: { paymentMethod: true } } } });
  if (!item) throw new DomainError("NOT_FOUND", "El ítem del pedido no existe.");
  const ttlMs = await reservationTtlMs(d, item.order.paymentMethod ?? "PAYPAL");
  const now = d.now();
  const res = await withTx(d, async (tx) => {
    const r = await reassignItemCohort(tx, orderItemId, newCohortId, now, { ttlMs });
    await addOrderEvent(tx, item.orderId, "COHORT_REASSIGNED", { type: "ADMIN", id: adminId }, note ?? null, { from: r.from, to: r.to, confirmed: r.confirmed, seatRestored: r.seatRestored });
    return r;
  });
  const order = await d.db.order.findUniqueOrThrow({ where: { id: item.orderId }, select: { status: true } });
  let enrollment: Awaited<ReturnType<typeof enrollOrder>> | { status: "ERROR"; reason: string } | undefined;
  if (order.status === "ENROLLED") {
    await resendCohortDetails(d, item.orderId);
  } else if (PAID_STATES.includes(order.status)) {
    // PAID/PARTIALLY_PAID sin matricular (p.ej. el pago llegó sin cupo): matricular ya. Al completarse,
    // la matrícula envía el acceso a la plataforma y los datos de la cohorte.
    try {
      enrollment = await enrollOrder(d, item.orderId, { actor: { type: "ADMIN", id: adminId } });
    } catch (e) {
      d.log.error(`[corrections] matrícula tras reasignar el pedido ${item.orderId} falló; el job la reintentará`, e);
      enrollment = { status: "ERROR", reason: String((e as Error)?.message ?? e) };
    }
  }
  return { ...res, enrollment };
}
