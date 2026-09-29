// Datos del checkout (/checkout). Solo servidor. Todo sale de la BD: el carrito (cookie) se vuelve a cotizar
// con `quote()` (misma regla que `createCheckout`), las cohortes con su cupo al día y los métodos de pago con
// `listPaymentOptions` (solo los habilitados y con datos reales).
//
// «Pedido en curso»: al confirmar, `createCheckout` crea el pedido y RESERVA el cupo de cada programa
// semipresencial. La cookie `ceium_checkout` recuerda ese pedido junto con la firma del carrito; mientras el
// pedido siga pendiente y el carrito no cambie, /checkout muestra la cuenta regresiva de la reserva y vuelve a
// usar el mismo pedido (volver atrás desde PayPal o enviar dos veces no crea otro pedido ni otra reserva).
import { cookies } from "next/headers";
import type { Modality, PlanKind } from "@/generated/prisma/client";
import { CART_COOKIE, dropMissingProducts, parseCartCookie, resolveCart, type CartLine } from "@/server/cart";
import { prisma } from "@/server/db";
import { readSetting } from "@/server/deps";
import { isDomainError } from "@/server/errors";
import { quote } from "@/server/quote";
import { getCohortAvailability } from "@/server/seats";
import { services } from "@/server/services";
import { SETTING_KEYS } from "@/server/settings";

export const CHECKOUT_COOKIE = "ceium_checkout";
export const CHECKOUT_COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 4 };

export type MethodKey = "PAYPAL" | "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "EFECTIVO";

export interface CheckoutCohortView {
  name: string;
  sede: string;
  startLabel: string;
  endLabel: string;
  available: number;
  capacity: number;
}

export interface CheckoutLineView {
  key: string;
  title: string;
  href: string;
  imageUrl: string | null;
  imageAlt: string;
  modality: Modality;
  /** «Semipresencial / Barquisimeto / Paga todo (10% de descuento)», como la variante en Shopify. */
  variant: string;
  planKind: PlanKind;
  /** Lo que se paga hoy por este programa. */
  dueNowCents: number;
  /** Total del programa con el plan (después del descuento). */
  totalCents: number;
  listCents: number;
  discountCents: number;
  planNote: string | null;
  cohort: CheckoutCohortView | null;
  error: string | null;
}

export interface MethodView {
  method: MethodKey;
  label: string;
  currency: "USD" | "VES";
  vesPerUsd: number | null;
  /** Origen y fecha de la tasa Bs/USD fijada en el panel: «BCV · 23 sep 2026». */
  rateLabel?: string | null;
  /** Datos para pagar (solo con un pedido en curso: se muestran después de reservar el cupo). */
  details?: { label: string; value: string }[];
  instructions?: string;
}

export const DETAIL_LABELS: Record<string, string> = {
  banco: "Banco",
  telefono: "Teléfono",
  cedulaRif: "Cédula / RIF",
  titular: "Titular",
  cuenta: "Número de cuenta",
  tipo: "Tipo de cuenta",
  correo: "Correo Zelle",
  lugar: "Dónde pagar",
};

export interface PendingOrderView {
  token: string;
  number: number;
  status: string;
  method: MethodKey | null;
  expiresAt: string | null;
  /** Vence la primera reserva de cupo viva (null si el pedido no tiene programas semipresenciales). */
  holdExpiresAt: string | null;
  /** Lo que falta del primer pago. */
  dueNowCents: number;
  customer: { email: string; firstName: string; lastName: string; cedula: string | null; phone: string | null; specialty: string | null; city: string | null; country: string | null };
}

export interface CheckoutView {
  lines: CheckoutLineView[];
  count: number;
  listCents: number;
  discountCents: number;
  totalCents: number;
  dueNowCents: number;
  blocked: boolean;
  hasSemipresencial: boolean;
  methods: MethodView[];
  ttl: { paypalMinutes: number; manualHours: number };
  pending: PendingOrderView | null;
}

const TZ = "America/Caracas";
function shortDate(d: Date): string {
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }).format(d).replace(/\./g, "");
}

/** Firma del carrito: el pedido en curso solo se reutiliza si el carrito no cambió. */
export function cartSignature(lines: CartLine[]): string {
  return lines
    .map((l) => [l.productId, l.modality, l.sedeId ?? "", l.cohortId ?? "", l.choiceId ?? "", l.planKind].join("|"))
    .sort()
    .join(";");
}

export function encodePendingCookie(token: string, signature: string): string {
  return Buffer.from(JSON.stringify({ t: token, s: signature }), "utf8").toString("base64url");
}

export function decodePendingCookie(raw: string | undefined): { token: string; signature: string } | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; s?: unknown };
    if (typeof o.t !== "string" || typeof o.s !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(o.t)) return null;
    return { token: o.t, signature: o.s };
  } catch {
    return null;
  }
}

export async function readCheckoutCookies() {
  const jar = await cookies();
  const lines = await dropMissingProducts(prisma, parseCartCookie(jar.get(CART_COOKIE)?.value));
  return { lines, pendingRef: decodePendingCookie(jar.get(CHECKOUT_COOKIE)?.value) };
}

/**
 * Pedido en curso reutilizable: mismo carrito, aún PENDING_PAYMENT, sin vencer y con todas sus reservas vivas.
 * Cualquier otra cosa (pagado, vencido, carrito distinto) ⇒ null y el checkout vuelve a empezar.
 */
export async function findPendingOrder(lines: CartLine[], ref: { token: string; signature: string } | null, now = new Date()) {
  if (!ref || !lines.length || ref.signature !== cartSignature(lines)) return null;
  const order = await prisma.order.findUnique({
    where: { token: ref.token },
    include: { customer: true, items: { include: { reservation: true } }, payments: { select: { status: true, method: true, providerStatus: true } } },
  });
  if (!order || order.status !== "PENDING_PAYMENT") return null;
  if (order.expiresAt && order.expiresAt.getTime() <= now.getTime()) return null;
  const semi = order.items.filter((i) => i.modality === "SEMIPRESENCIAL");
  if (semi.some((i) => !i.reservation || i.reservation.status !== "HELD" || i.reservation.expiresAt.getTime() <= now.getTime())) return null;
  return order;
}

async function rateLabel(): Promise<string | null> {
  const r = await readSetting<{ source?: string; updatedAt?: string; valueDate?: string } | null>(prisma, SETTING_KEYS.exchangeRate, null);
  // Tasa automática: su fecha valor BCV (mediodía UTC = ese día en Caracas). Tasa manual: cuándo se guardó.
  const ts = r?.valueDate ? Date.parse(`${r.valueDate}T12:00:00Z`) : r?.updatedAt ? Date.parse(r.updatedAt) : NaN;
  const parts = [r?.source?.trim() || null, Number.isFinite(ts) ? shortDate(new Date(ts)) : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export async function paymentMethods(withDetails = false): Promise<MethodView[]> {
  const opts = await services().orders.listPaymentOptions();
  const rate = opts.some((o) => o.currency === "VES") ? await rateLabel() : null;
  return opts.map((o) => ({
    method: o.method as MethodKey,
    label: o.label,
    currency: o.currency,
    vesPerUsd: o.currency === "VES" && Number.isFinite(o.vesPerUsd) ? Number(o.vesPerUsd) : null,
    rateLabel: o.currency === "VES" ? rate : null,
    ...(withDetails && o.method !== "PAYPAL"
      ? { details: Object.entries(o.details ?? {}).map(([k, value]) => ({ label: DETAIL_LABELS[k] ?? k, value })), instructions: o.instructions }
      : {}),
  }));
}

export async function getCheckoutView(): Promise<CheckoutView> {
  const now = new Date();
  const { lines, pendingRef } = await readCheckoutCookies();
  const cart = await resolveCart({ db: prisma, now: () => now }, lines);

  const order = await findPendingOrder(lines, pendingRef, now);
  const [methods, ttlPaypal, ttlManual] = await Promise.all([
    paymentMethods(!!order),
    readSetting(prisma, SETTING_KEYS.reservationTtlPaypal, { minutes: 30 }),
    readSetting(prisma, SETTING_KEYS.reservationTtlManual, { hours: 72 }),
  ]);

  const cohortIds = lines.map((l) => l.cohortId).filter((x): x is string => !!x);
  const cohorts = cohortIds.length ? await prisma.cohort.findMany({ where: { id: { in: cohortIds } }, include: { sede: true } }) : [];

  const out: CheckoutLineView[] = [];
  for (const r of cart.lines) {
    const raw = lines.find((l) => l.key === r.key)!;
    let listCents = r.programTotalCents;
    let discountCents = 0;
    if (!r.error) {
      try {
        const q = await quote(prisma, { productId: raw.productId, modality: raw.modality, sedeId: raw.sedeId, choiceId: raw.choiceId, planKind: raw.planKind }, now);
        listCents = q.listCents;
        discountCents = q.discountCents;
      } catch (e) {
        if (!isDomainError(e)) throw e;
      }
    }
    let cohort: CheckoutCohortView | null = null;
    const c = raw.modality === "SEMIPRESENCIAL" ? cohorts.find((x) => x.id === raw.cohortId) : undefined;
    if (c) {
      const av = await getCohortAvailability({ db: prisma, now: () => now }, c.id);
      cohort = { name: c.name, sede: c.sede.name, startLabel: shortDate(c.startDate), endLabel: shortDate(c.endDate), available: av.available, capacity: av.capacity };
    }
    const value = (n: string) => r.options.find((o) => o.name === n)?.value;
    const variant = [r.options.find((o) => !["Modalidad", "Sede", "Cohorte", "Forma de pago"].includes(o.name))?.value, value("Modalidad"), raw.modality === "SEMIPRESENCIAL" ? value("Sede") : null, r.planLabel || null]
      .filter(Boolean)
      .join(" / ");
    out.push({
      key: r.key,
      title: r.title,
      href: r.href,
      imageUrl: r.imageUrl,
      imageAlt: r.imageAlt,
      modality: raw.modality,
      variant,
      planKind: r.planKind,
      dueNowCents: r.priceCents,
      totalCents: r.programTotalCents,
      listCents,
      discountCents,
      planNote: r.planNote,
      cohort,
      error: r.error,
    });
  }
  const ok = out.filter((l) => !l.error);

  let pending: PendingOrderView | null = null;
  if (order) {
    const holds = order.items.map((i) => i.reservation?.expiresAt).filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime());
    pending = {
      token: order.token,
      number: order.number,
      status: order.status,
      method: (order.paymentMethod as MethodKey | null) ?? null,
      expiresAt: order.expiresAt?.toISOString() ?? null,
      holdExpiresAt: holds[0]?.toISOString() ?? null,
      dueNowCents: Math.max(0, order.dueNowCents - order.amountPaidCents),
      customer: {
        email: order.customer.email,
        firstName: order.buyerFirstName ?? order.customer.firstName,
        lastName: order.buyerLastName ?? order.customer.lastName,
        cedula: order.customer.cedula,
        phone: order.customer.phone,
        specialty: order.customer.specialty,
        city: order.customer.city,
        country: order.customer.country,
      },
    };
  }

  return {
    lines: out,
    count: out.length,
    listCents: ok.reduce((a, l) => a + l.listCents, 0),
    discountCents: ok.reduce((a, l) => a + l.discountCents, 0),
    totalCents: ok.reduce((a, l) => a + l.totalCents, 0),
    dueNowCents: ok.reduce((a, l) => a + l.dueNowCents, 0),
    blocked: cart.blocked,
    hasSemipresencial: out.some((l) => l.modality === "SEMIPRESENCIAL"),
    methods,
    ttl: { paypalMinutes: ttlPaypal.minutes, manualHours: ttlManual.hours },
    pending,
  };
}
