// Cotización: matriz de precios (producto × modalidad × sede × opción) + plan de pago → montos y cuotas.
import type { Modality, PlanKind } from "@/generated/prisma/client";
import type { Db, Tx } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { computePlanAmounts, priceScopeKey } from "@/server/pricing";

export interface QuoteInput {
  productId: string;
  modality: Modality;
  /** Obligatoria en SEMIPRESENCIAL; se ignora en ONLINE (precio sin sede). */
  sedeId?: string | null;
  /** Obligatoria si el producto tiene opciones (p.ej. "Cursos disponibles"). */
  choiceId?: string | null;
  planKind: PlanKind;
}

export interface QuoteInstallment {
  sequence: number;
  amountCents: number;
  /** Vencimiento sugerido: la 1.ª hoy, luego cada mes. */
  dueDate: Date;
}

export interface Quote {
  productId: string;
  productTitle: string;
  productType: "COURSE" | "DIPLOMA";
  modality: Modality;
  sedeId: string | null;
  choiceId: string | null;
  priceEntryId: string;
  paymentPlanId: string;
  planKind: PlanKind;
  planLabel: string;
  discountPct: number;
  listCents: number;
  discountCents: number;
  totalCents: number;
  dueNowCents: number;
  installments: QuoteInstallment[];
}

export function addMonths(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export async function quote(db: Db | Tx, input: QuoteInput, now: Date = new Date()): Promise<Quote> {
  const product = await db.product.findUnique({ where: { id: input.productId }, include: { choices: true } });
  if (!product || !product.published) throw new DomainError("NOT_FOUND", "El programa no existe o no está disponible.");
  if (input.modality === "ONLINE" && !product.offersOnline) throw new DomainError("VALIDATION", "Este programa no se ofrece en modalidad online.");
  if (input.modality === "SEMIPRESENCIAL" && !product.offersSemipresencial) throw new DomainError("VALIDATION", "Este programa no se ofrece en modalidad semipresencial.");

  const sedeId = input.modality === "ONLINE" ? null : input.sedeId ?? null;
  if (input.modality === "SEMIPRESENCIAL" && !sedeId) throw new DomainError("VALIDATION", "Selecciona una sede.");

  let choiceId: string | null = null;
  if (product.choices.length > 0) {
    if (!input.choiceId) throw new DomainError("VALIDATION", "Selecciona una opción del programa.");
    if (!product.choices.some((c) => c.id === input.choiceId)) throw new DomainError("VALIDATION", "La opción seleccionada no pertenece a este programa.");
    choiceId = input.choiceId;
  }

  const price = await db.priceEntry.findUnique({ where: { productId_scopeKey: { productId: product.id, scopeKey: priceScopeKey({ modality: input.modality, sedeId, choiceId }) } } });
  if (!price || !price.active) throw new DomainError("NOT_FOUND", "No hay precio configurado para esa combinación de modalidad y sede.");

  const plan = await db.paymentPlan.findFirst({ where: { productId: product.id, kind: input.planKind, active: true } });
  if (!plan) throw new DomainError("VALIDATION", "El plan de pago seleccionado no está disponible para este programa.");
  if (plan.kind === "MONTHLY" && plan.installments < 2) throw new DomainError("VALIDATION", "El plan mes a mes está mal configurado (cuotas < 2).");

  const amounts = computePlanAmounts(
    { priceCents: price.priceCents, installmentCents: price.installmentCents },
    { kind: plan.kind, discountPct: plan.discountPct, installments: plan.installments },
  );

  return {
    productId: product.id,
    productTitle: product.title,
    productType: product.type,
    modality: input.modality,
    sedeId,
    choiceId,
    priceEntryId: price.id,
    paymentPlanId: plan.id,
    planKind: plan.kind,
    planLabel: plan.label,
    discountPct: plan.discountPct,
    listCents: amounts.listCents,
    discountCents: amounts.discountCents,
    totalCents: amounts.totalCents,
    dueNowCents: amounts.dueNowCents,
    installments: amounts.schedule.map((amountCents, i) => ({ sequence: i + 1, amountCents, dueDate: addMonths(now, i) })),
  };
}
