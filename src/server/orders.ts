// Pedidos: checkout (validación de cohorte + reserva de cupo + montos) y máquina de estados.
// Toda transición pasa por transitionOrder(): valida la transición, la aplica con UPDATE condicional
// (status esperado) y deja un OrderEvent con actor, antes/después y nota.
import crypto from "node:crypto";
import type { ActorType, Modality, OrderStatus, PaymentMethod, PlanKind, Prisma } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import { HOUR, MINUTE, readSetting, withTx } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { quote, type Quote } from "@/server/quote";
import { releaseOrderReservations, reserveSeat } from "@/server/seats";
import { exchangeRateStatus, manualMethodProblems, SETTING_KEYS, type ExchangeRateSetting, type ManualMethodConfig } from "@/server/settings";
import { buildOrderView, safeNotify, sendEmail } from "@/server/email";
import * as T from "@/server/email/templates";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { formatUSD } from "@/server/pricing";

// ───────────── Máquina de estados ─────────────

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ["AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "CANCELLED", "EXPIRED"],
  AWAITING_VERIFICATION: ["PAID", "PARTIALLY_PAID", "PENDING_PAYMENT", "REJECTED", "CANCELLED"],
  PARTIALLY_PAID: ["ENROLLED", "PAID", "REFUNDED", "CANCELLED"],
  PAID: ["ENROLLED", "REFUNDED", "CANCELLED"],
  ENROLLED: ["REFUNDED"],
  // Un pago puede llegar tarde (PayPal capturado tras vencer la reserva, comprobante subido tarde):
  EXPIRED: ["AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "CANCELLED"],
  REJECTED: ["AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "CANCELLED"],
  CANCELLED: [],
  REFUNDED: [],
};

/** Estados en los que el primer pago ya fue confirmado. */
export const PAID_STATES: readonly OrderStatus[] = ["PAID", "PARTIALLY_PAID", "ENROLLED"];
/** Estados previos al primer pago confirmado. */
export const PREPAID_STATES: readonly OrderStatus[] = ["PENDING_PAYMENT", "AWAITING_VERIFICATION", "EXPIRED", "REJECTED"];
/**
 * Estados terminales sin deuda: el pedido se cerró (reembolso total o cancelación), así que el cliente no
 * debe nada y balanceCents = 0. Un pago que llegue después se trata como pago en pedido cerrado (ATTENTION).
 */
export const CLOSED_STATES: readonly OrderStatus[] = ["REFUNDED", "CANCELLED"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface Actor {
  type: ActorType;
  id?: string | null;
}
export const SYSTEM: Actor = { type: "SYSTEM" };

export async function addOrderEvent(tx: Tx, orderId: string, type: string, actor: Actor, note?: string | null, data?: Prisma.InputJsonValue) {
  return tx.orderEvent.create({ data: { orderId, type, actorType: actor.type, actorId: actor.type === "ADMIN" ? actor.id ?? null : null, note: note ?? null, data: data ?? undefined } });
}

export interface TransitionOptions {
  actor: Actor;
  note?: string | null;
  data?: Prisma.InputJsonValue;
  /** Campos extra a escribir junto con el cambio de estado. */
  patch?: Prisma.OrderUpdateManyMutationInput;
}

/**
 * Cambia el estado del pedido si la transición es legal. Concurrencia: UPDATE … WHERE status = <actual>;
 * si otro proceso cambió el estado entretanto, relee y vuelve a validar.
 */
export async function transitionOrder(tx: Tx, orderId: string, to: OrderStatus, opts: TransitionOptions): Promise<{ from: OrderStatus; to: OrderStatus }> {
  for (let i = 0; i < 3; i++) {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
    if (!order) throw new DomainError("NOT_FOUND", "El pedido no existe.");
    const from = order.status;
    if (!canTransition(from, to)) throw new DomainError("INVALID_TRANSITION", `Transición no permitida: ${from} → ${to}.`, { from, to });
    const closing = CLOSED_STATES.includes(to) ? { balanceCents: 0 } : {};
    const n = await tx.order.updateMany({ where: { id: orderId, status: from }, data: { ...(opts.patch ?? {}), ...closing, status: to } });
    if (n.count === 1) {
      await tx.orderEvent.create({
        data: { orderId, type: "STATUS_CHANGE", fromStatus: from, toStatus: to, actorType: opts.actor.type, actorId: opts.actor.type === "ADMIN" ? opts.actor.id ?? null : null, note: opts.note ?? null, data: opts.data ?? undefined },
      });
      return { from, to };
    }
  }
  throw new DomainError("CONFLICT", "El pedido cambió mientras se procesaba; intenta de nuevo.");
}

/**
 * Bloquea la fila del pedido hasta el commit. Llamar al INICIO de toda transacción que lee y luego escribe
 * importes del pedido (pagos, reembolsos, ajustes): en Postgres (READ COMMITTED) el UPDATE toma el lock de
 * fila, así dos confirmaciones simultáneas del mismo pedido se serializan y la segunda lee lo que la
 * primera confirmó. En SQLite la transacción (BEGIN IMMEDIATE) ya es exclusiva; esto no cuesta nada.
 */
export async function lockOrder(tx: Tx, orderId: string, now: Date = new Date()): Promise<void> {
  await tx.order.updateMany({ where: { id: orderId }, data: { updatedAt: now } });
}

/**
 * Recalcula balance = total + ajustes − pagado. En un pedido cerrado (CLOSED_STATES: reembolsado o
 * cancelado) el saldo es 0: el cliente no debe nada y el panel no debe mostrar una deuda falsa.
 */
export async function recomputeBalance(tx: Tx, orderId: string): Promise<number> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalCents: true, amountPaidCents: true, status: true } });
  const adj = await tx.balanceAdjustment.aggregate({ where: { orderId }, _sum: { amountCents: true } });
  const balance = CLOSED_STATES.includes(o.status) ? 0 : o.totalCents + (adj._sum.amountCents ?? 0) - o.amountPaidCents;
  await tx.order.update({ where: { id: orderId }, data: { balanceCents: balance } });
  return balance;
}

// ───────────── Checkout ─────────────

export interface CheckoutCustomerInput {
  email: string;
  firstName: string;
  lastName: string;
  cedula?: string | null;
  phone?: string | null;
  specialty?: string | null;
  city?: string | null;
  country?: string | null;
}

export interface CheckoutItemInput {
  productId: string;
  modality: Modality;
  sedeId?: string | null;
  cohortId?: string | null;
  choiceId?: string | null;
  planKind: PlanKind;
}

export interface CheckoutInput {
  customer: CheckoutCustomerInput;
  items: CheckoutItemInput[];
  paymentMethod: PaymentMethod;
  customerNote?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function reservationTtlMs(d: Pick<Deps, "db">, method: PaymentMethod): Promise<number> {
  if (method === "PAYPAL") return (await readSetting(d.db, SETTING_KEYS.reservationTtlPaypal, { minutes: 30 })).minutes * MINUTE;
  return (await readSetting(d.db, SETTING_KEYS.reservationTtlManual, { hours: 72 })).hours * HOUR;
}

export async function getManualMethod(d: Pick<Deps, "db">, method: PaymentMethod): Promise<ManualMethodConfig | null> {
  const list = await readSetting<ManualMethodConfig[]>(d.db, SETTING_KEYS.manualMethods, []);
  return list.find((m) => m.method === method) ?? null;
}

async function assertMethodEnabled(d: Deps, method: PaymentMethod) {
  if (method === "PAYPAL") {
    const cfg = await readSetting(d.db, SETTING_KEYS.paypal, { enabled: true });
    if (!cfg.enabled) throw new DomainError("VALIDATION", "El pago con PayPal no está disponible en este momento.");
    return;
  }
  const m = await getManualMethod(d, method);
  if (!m || !m.enabled) throw new DomainError("VALIDATION", "El método de pago seleccionado no está disponible.");
  const why = await manualMethodUnavailableReason(d, m);
  if (why) {
    d.log.warn(`[checkout] método ${m.method} habilitado pero no ofrecible: ${why}`);
    throw new DomainError("VALIDATION", "El método de pago seleccionado no está disponible en este momento. Elige otro método.");
  }
}

/** Motivo por el que un método manual habilitado no se puede ofrecer (datos de ejemplo, tasa Bs/USD de ejemplo). */
async function manualMethodUnavailableReason(d: Pick<Deps, "db" | "now">, m: ManualMethodConfig): Promise<string | null> {
  const problems = manualMethodProblems(m);
  if (problems.length) return problems.join(" ");
  if (m.currency === "VES") {
    const st = exchangeRateStatus(await readSetting<ExchangeRateSetting | null>(d.db, SETTING_KEYS.exchangeRate, null), d.now());
    if (!st.usable) return st.problems.join(" ");
  }
  return null;
}

export interface PaymentOption {
  method: PaymentMethod;
  label: string;
  currency: "USD" | "VES";
  /** Métodos manuales: datos para pagar e instrucciones (ya validados: sin datos de ejemplo). */
  details?: Record<string, string>;
  instructions?: string;
  /** Métodos en bolívares: tasa Bs/USD vigente. */
  vesPerUsd?: number;
}

/** Métodos de pago que la tienda puede ofrecer ahora (PayPal si está activo + manuales habilitados y completos). */
export async function listPaymentOptions(d: Deps): Promise<PaymentOption[]> {
  const out: PaymentOption[] = [];
  if ((await readSetting(d.db, SETTING_KEYS.paypal, { enabled: true })).enabled) out.push({ method: "PAYPAL", label: "PayPal", currency: "USD" });
  const rate = await readSetting<ExchangeRateSetting | null>(d.db, SETTING_KEYS.exchangeRate, null);
  for (const m of await readSetting<ManualMethodConfig[]>(d.db, SETTING_KEYS.manualMethods, [])) {
    if (!m.enabled || (await manualMethodUnavailableReason(d, m))) continue;
    out.push({ method: m.method, label: m.label, currency: m.currency, details: m.details, instructions: m.instructions, ...(m.currency === "VES" ? { vesPerUsd: Number(rate?.vesPerUsd) } : {}) });
  }
  return out;
}

async function nextOrderNumber(tx: Tx): Promise<number> {
  const setting = await readSetting(tx, SETTING_KEYS.orderNextNumber, { next: 1001 });
  const max = await tx.order.aggregate({ _max: { number: true } });
  const n = Math.max(setting.next, (max._max.number ?? 0) + 1);
  await tx.setting.upsert({ where: { key: SETTING_KEYS.orderNextNumber }, create: { key: SETTING_KEYS.orderNextNumber, value: { next: n + 1 } }, update: { value: { next: n + 1 } } });
  return n;
}

function validateCustomer(c: CheckoutCustomerInput): CheckoutCustomerInput {
  const email = c.email?.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new DomainError("VALIDATION", "Ingresa un correo electrónico válido.", { field: "email" });
  const firstName = c.firstName?.trim();
  const lastName = c.lastName?.trim();
  if (!firstName) throw new DomainError("VALIDATION", "Ingresa tu nombre.", { field: "firstName" });
  if (!lastName) throw new DomainError("VALIDATION", "Ingresa tu apellido.", { field: "lastName" });
  return { ...c, email, firstName, lastName };
}

/**
 * Crea el pedido: valida programa/modalidad/sede/cohorte, cotiza, crea cliente+pedido+ítems+cuotas y
 * reserva el cupo de cada ítem semipresencial, todo en UNA transacción (sin cupo ⇒ nada se crea).
 * Correo: para pagos manuales se envía la confirmación de pedido con los datos para pagar.
 */
export async function createCheckout(d: Deps, input: CheckoutInput) {
  if (!input.items?.length) throw new DomainError("VALIDATION", "El carrito está vacío.");
  const customer = validateCustomer(input.customer);
  await assertMethodEnabled(d, input.paymentMethod);
  const now = d.now();

  // Cotizaciones y validación de cohortes (lecturas; la disponibilidad real se decide al reservar).
  const quotes: { q: Quote; item: CheckoutItemInput }[] = [];
  for (const item of input.items) {
    let sedeId = item.sedeId ?? null;
    if (item.modality === "SEMIPRESENCIAL") {
      if (!item.cohortId) throw new DomainError("VALIDATION", "Selecciona una cohorte para la modalidad semipresencial.");
      const cohort = await d.db.cohort.findUnique({ where: { id: item.cohortId } });
      if (!cohort || cohort.productId !== item.productId) throw new DomainError("VALIDATION", "La cohorte seleccionada no corresponde a este programa.");
      if (sedeId && sedeId !== cohort.sedeId) throw new DomainError("VALIDATION", "La cohorte seleccionada es de otra sede.");
      sedeId = cohort.sedeId;
    } else if (item.cohortId) {
      throw new DomainError("VALIDATION", "La modalidad online no usa cohortes.");
    }
    quotes.push({ q: await quote(d.db, { productId: item.productId, modality: item.modality, sedeId, choiceId: item.choiceId, planKind: item.planKind }, now), item });
  }

  const ttl = await reservationTtlMs(d, input.paymentMethod);
  const expiresAt = new Date(now.getTime() + ttl);
  const subtotal = quotes.reduce((a, x) => a + x.q.listCents, 0);
  const discount = quotes.reduce((a, x) => a + x.q.discountCents, 0);
  const total = quotes.reduce((a, x) => a + x.q.totalCents, 0);
  const dueNow = quotes.reduce((a, x) => a + x.q.dueNowCents, 0);

  // Calendario de cuotas: una fila por ítem y cuota, ordenadas por mes y luego por ítem (secuencia global).
  // Las del mes 0 suman dueNow. Mes a mes: cada fila lleva el curso del diplomado que habilita.
  const schedule = quotes
    .flatMap(({ q }, itemIndex) => q.installments.map((ins, month) => ({ itemIndex, month, ins })))
    .sort((a, b) => a.month - b.month || a.itemIndex - b.itemIndex);

  const orderId = await withTx(d, async (tx) => {
    // El checkout no está autenticado: un correo existente NO permite cambiar el nombre (va a Moodle y al
    // certificado). El nombre escrito queda en el pedido (buyerFirstName/LastName) y el cliente solo lo
    // adopta si este pedido es su primera compra pagada (ver adoptBuyerName en payments.ts). Los demás
    // datos de contacto solo completan campos vacíos.
    const existing = await tx.customer.findUnique({ where: { email: customer.email } });
    const cust = existing
      ? await tx.customer.update({
          where: { id: existing.id },
          data: {
            ...(!existing.cedula && customer.cedula ? { cedula: customer.cedula } : {}),
            ...(!existing.phone && customer.phone ? { phone: customer.phone } : {}),
            ...(!existing.specialty && customer.specialty ? { specialty: customer.specialty } : {}),
            ...(!existing.city && customer.city ? { city: customer.city } : {}),
          },
        })
      : await tx.customer.create({
          data: {
            email: customer.email,
            firstName: customer.firstName,
            lastName: customer.lastName,
            cedula: customer.cedula ?? null,
            phone: customer.phone ?? null,
            specialty: customer.specialty ?? null,
            city: customer.city ?? null,
            country: customer.country ?? "VE",
          },
        });
    const number = await nextOrderNumber(tx);
    const order = await tx.order.create({
      data: {
        number,
        token: crypto.randomBytes(18).toString("base64url"),
        customerId: cust.id,
        status: "PENDING_PAYMENT",
        paymentMethod: input.paymentMethod,
        currency: "USD",
        subtotalCents: subtotal,
        discountCents: discount,
        totalCents: total,
        dueNowCents: dueNow,
        amountPaidCents: 0,
        balanceCents: total,
        buyerFirstName: customer.firstName,
        buyerLastName: customer.lastName,
        customerNote: input.customerNote ?? null,
        expiresAt,
        placedAt: now,
      },
    });
    const itemIds: string[] = [];
    for (const { q, item } of quotes) {
      const oi = await tx.orderItem.create({
        data: {
          orderId: order.id,
          productId: q.productId,
          productTitle: q.productTitle,
          productType: q.productType,
          modality: q.modality,
          sedeId: q.sedeId,
          cohortId: item.modality === "SEMIPRESENCIAL" ? item.cohortId! : null,
          choiceId: q.choiceId,
          paymentPlanId: q.paymentPlanId,
          planKind: q.planKind,
          planLabel: q.planLabel,
          quantity: 1,
          unitPriceCents: q.listCents,
          discountCents: q.discountCents,
          totalCents: q.totalCents,
          dueNowCents: q.dueNowCents,
        },
      });
      itemIds.push(oi.id);
      if (q.productType === "DIPLOMA") {
        if (q.diplomaCourses.length === 0) throw new DomainError("VALIDATION", `El diplomado «${q.productTitle}» no tiene cursos configurados.`);
        await tx.orderItemCourse.createMany({ data: q.diplomaCourses.map((c, i) => ({ orderItemId: oi.id, courseId: c.productId, position: i + 1 })) });
      }
      if (item.modality === "SEMIPRESENCIAL") await reserveSeat(tx, { cohortId: item.cohortId!, orderId: order.id, orderItemId: oi.id, ttlMs: ttl, now });
    }
    for (const [i, s] of schedule.entries()) {
      await tx.installment.create({
        data: {
          orderId: order.id,
          orderItemId: itemIds[s.itemIndex],
          sequence: i + 1,
          amountCents: s.ins.amountCents,
          dueDate: s.ins.dueDate,
          courseId: s.ins.course?.productId ?? null,
          moodleCourseId: s.ins.course?.moodleCourseId ?? null,
        },
      });
    }
    await addOrderEvent(tx, order.id, "CREATED", { type: "CUSTOMER", id: cust.id }, `Pedido #${number} creado (${input.paymentMethod})`, {
      totalCents: total,
      dueNowCents: dueNow,
      expiresAt: expiresAt.toISOString(),
    });
    return order.id;
  }, { retryUnique: true }); // P2002 aquí = otra transacción creó el mismo cliente o tomó el mismo número

  if (input.paymentMethod !== "PAYPAL") await notifyOrderReceived(d, orderId);
  return getOrder(d, orderId);
}

export async function getOrder(d: Pick<Deps, "db">, orderId: string) {
  return d.db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { reservation: true, cohort: true, sede: true } }, installments: { orderBy: { sequence: "asc" }, include: { course: { select: { id: true, title: true } } } }, payments: true },
  });
}

export async function getOrderByToken(d: Pick<Deps, "db">, token: string) {
  const o = await d.db.order.findUnique({ where: { token }, select: { id: true } });
  if (!o) throw new DomainError("NOT_FOUND", "El pedido no existe.");
  return getOrder(d, o.id);
}

/** Correo "Recibimos tu pedido" con los datos del método manual y el monto en la moneda del método. */
export async function notifyOrderReceived(d: Deps, orderId: string) {
  await safeNotify(d, "order_confirmation", async () => {
    const { view, email, customerId } = await buildOrderView(d, orderId);
    const order = await d.db.order.findUniqueOrThrow({ where: { id: orderId } });
    const m = order.paymentMethod ? await getManualMethod(d, order.paymentMethod) : null;
    let manual: T.ManualInstructionsView | undefined;
    if (m) {
      let amountLabel = formatUSD(order.dueNowCents);
      if (m.currency === "VES") {
        const rate = await readSetting(d.db, SETTING_KEYS.exchangeRate, { vesPerUsd: 0 });
        if (rate.vesPerUsd > 0) amountLabel = `${T.formatVES(Math.round(order.dueNowCents * rate.vesPerUsd))} (${formatUSD(order.dueNowCents)} a Bs. ${rate.vesPerUsd.toLocaleString("es-VE")} por USD)`;
      }
      manual = { label: m.label, details: m.details, instructions: m.instructions, amountLabel };
    }
    await sendEmail(d, { template: "order_confirmation", to: email, rendered: T.orderConfirmation(view, { paid: false, manual }), dedupeKey: `order_received:${orderId}`, orderId, customerId });
  });
}

// ───────────── Vencimiento / cancelación / correcciones ─────────────

// ───────────── Pagos insuficientes ─────────────
// Un pedido PENDING_PAYMENT con dinero cobrado (amountPaidCents > 0) no alcanzó el primer pago: p. ej. un
// pago móvil en VES aprobado que, por la tasa, quedó corto. Ese pedido NO vence ni libera su cupo (seats.ts),
// así que necesita a una persona: completar el pago (el enlace de PayPal cobra solo la diferencia), registrar
// el resto a mano o reembolsar. Se marca con ATTENTION al quedar así y otra vez (una sola) al pasar su plazo,
// y aparece en listUnderpaidOrders (cola del panel).

/** Estados previos al primer pago en los que un pedido puede quedar con dinero cobrado insuficiente. */
const UNDERPAID_STATES: readonly OrderStatus[] = ["PENDING_PAYMENT", "EXPIRED", "REJECTED"];
const UNDERPAID_NOTE = "Pago insuficiente para el primer pago";
const UNDERPAID_STALE_NOTE = "Venció el plazo de pago con un pago parcial cobrado";

/** Deja un ATTENTION: el pedido quedó en PENDING_PAYMENT con un pago cobrado que no cubre el primer pago. */
export async function flagUnderpaidOrder(tx: Tx, orderId: string, actor: Actor = SYSTEM): Promise<void> {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, amountPaidCents: true, dueNowCents: true } });
  if (!UNDERPAID_STATES.includes(o.status) || o.amountPaidCents <= 0 || o.amountPaidCents >= o.dueNowCents) return;
  const missing = o.dueNowCents - o.amountPaidCents;
  const seat = o.status === "PENDING_PAYMENT" ? "El cupo se mantiene" : `El pedido está ${o.status === "EXPIRED" ? "vencido" : "rechazado"} y sin cupo reservado`;
  await addOrderEvent(
    tx,
    orderId,
    "ATTENTION",
    actor,
    `${UNDERPAID_NOTE}: cobrado ${formatUSD(o.amountPaidCents)} de ${formatUSD(o.dueNowCents)}; faltan ${formatUSD(missing)}. ${seat}: pide al cliente la diferencia, registra el resto o reembolsa.`,
    { underpaid: true, amountPaidCents: o.amountPaidCents, dueNowCents: o.dueNowCents, missingCents: missing },
  );
}

export interface UnderpaidOrderRow {
  id: string;
  number: number;
  customerEmail: string;
  customerName: string;
  amountPaidCents: number;
  dueNowCents: number;
  missingCents: number;
  status: OrderStatus;
  expiresAt: Date | null;
  overdue: boolean;
}

/**
 * Cola del panel: pedidos antes del primer pago (PENDING_PAYMENT, o EXPIRED/REJECTED que recibieron un pago
 * tardío) con dinero cobrado que no alcanza el primer pago.
 */
export async function listUnderpaidOrders(d: Deps, user: SessionUser): Promise<UnderpaidOrderRow[]> {
  await requireAdmin(d.db, user, "orders.view");
  const now = d.now();
  const rows = await d.db.order.findMany({
    where: { status: { in: [...UNDERPAID_STATES] }, amountPaidCents: { gt: 0 } },
    include: { customer: { select: { email: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows
    .filter((o) => o.amountPaidCents < o.dueNowCents)
    .map((o) => ({
      id: o.id,
      number: o.number,
      customerEmail: o.customer.email,
      customerName: `${o.customer.firstName} ${o.customer.lastName}`.trim(),
      amountPaidCents: o.amountPaidCents,
      dueNowCents: o.dueNowCents,
      missingCents: o.dueNowCents - o.amountPaidCents,
      status: o.status,
      expiresAt: o.expiresAt,
      overdue: !!o.expiresAt && o.expiresAt.getTime() < now.getTime(),
    }));
}

/**
 * Job: pedidos PENDING_PAYMENT vencidos → EXPIRED (libera cupos). runJobs concilia antes los pagos
 * PayPal (reconcilePaypalPayments) para no vencer un pedido que el comprador ya aprobó. Un pedido vencido
 * con dinero cobrado (pago insuficiente) no se vence: se le deja un ATTENTION (una sola vez) para el staff.
 */
export async function expireStaleOrders(d: Deps): Promise<number> {
  const now = d.now();
  const stale = await d.db.order.findMany({ where: { status: "PENDING_PAYMENT", expiresAt: { lt: now } }, select: { id: true } });
  let n = 0;
  for (const o of stale) {
    const done = await withTx(d, async (tx) => {
      const cur0 = await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { status: true, amountPaidCents: true, dueNowCents: true } });
      const completed = await tx.payment.count({ where: { orderId: o.id, status: "COMPLETED" } });
      if (cur0.status === "PENDING_PAYMENT" && (cur0.amountPaidCents > 0 || completed > 0)) {
        const flagged = await tx.orderEvent.count({ where: { orderId: o.id, type: "ATTENTION", note: { startsWith: UNDERPAID_STALE_NOTE } } });
        if (flagged === 0) {
          const missing = Math.max(0, cur0.dueNowCents - cur0.amountPaidCents);
          await addOrderEvent(
            tx,
            o.id,
            "ATTENTION",
            SYSTEM,
            `${UNDERPAID_STALE_NOTE} (${formatUSD(cur0.amountPaidCents)}; faltan ${formatUSD(missing)}). No se venció ni se liberó el cupo: completa el pago o reembolsa.`,
            { underpaid: true, stale: true, amountPaidCents: cur0.amountPaidCents, dueNowCents: cur0.dueNowCents, missingCents: missing },
          );
        }
        return false;
      }
      const pending = await tx.payment.count({ where: { orderId: o.id, status: { in: ["AWAITING_VERIFICATION", "COMPLETED"] } } });
      if (pending > 0) return false;
      // PayPal retuvo la captura (CAPTURE_PENDING): el dinero está en camino; se mantiene el cupo.
      const inFlight = await tx.payment.count({ where: { orderId: o.id, method: "PAYPAL", status: "PENDING", providerStatus: "CAPTURE_PENDING" } });
      if (inFlight > 0) return false;
      const cur = await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { status: true } });
      if (cur.status !== "PENDING_PAYMENT") return false;
      await releaseOrderReservations(tx, o.id, "EXPIRED", now);
      await tx.payment.updateMany({ where: { orderId: o.id, status: "PENDING" }, data: { status: "CANCELLED" } });
      await transitionOrder(tx, o.id, "EXPIRED", { actor: SYSTEM, note: "Venció el plazo de pago; cupo liberado." });
      return true;
    });
    if (done) n++;
  }
  return n;
}

export async function cancelOrder(d: Deps, user: SessionUser, orderId: string, note?: string) {
  const admin = await requireAdmin(d.db, user, "orders.cancel");
  const actor: Actor = { type: "ADMIN", id: admin.id };
  const now = d.now();
  return withTx(d, async (tx) => {
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (o.amountPaidCents > 0) throw new DomainError("INVALID_STATE", "El pedido tiene pagos confirmados: usa un reembolso en lugar de cancelar.");
    const awaiting = await tx.payment.count({ where: { orderId, status: "AWAITING_VERIFICATION" } });
    if (awaiting > 0) throw new DomainError("INVALID_STATE", "Hay pagos pendientes de verificación: recházalos antes de cancelar.");
    await releaseOrderReservations(tx, orderId, "CANCELLED", now);
    await tx.payment.updateMany({ where: { orderId, status: "PENDING" }, data: { status: "CANCELLED" } });
    return transitionOrder(tx, orderId, "CANCELLED", { actor, note: note ?? "Pedido cancelado", patch: { cancelledAt: now } });
  });
}

// Ajustes de saldo, condonación de cuotas y reasignación de cohorte: ver corrections.ts (necesitan
// disparar la matrícula y confirmar cupos, que viven en enrollment.ts / payments.ts).

export async function addNote(d: Deps, user: SessionUser, orderId: string, note: string) {
  const admin = await requireAdmin(d.db, user, "orders.note");
  if (!note?.trim()) throw new DomainError("VALIDATION", "Escribe la nota.");
  return d.db.$transaction((tx) => addOrderEvent(tx, orderId, "NOTE", { type: "ADMIN", id: admin.id }, note.trim()));
}
