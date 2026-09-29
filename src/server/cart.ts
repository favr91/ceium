// Carrito de la tienda. Vive en una cookie (sin cuentas de cliente, como la tienda Shopify original) y guarda
// SOLO la selección del médico: programa + modalidad + sede + cohorte + opción + plan de pago. Nada de precios:
// cada vez que se muestra, `resolveCart` vuelve a cotizar contra la BD con `quote()` (misma regla que el
// checkout), así un cambio de precio, una cohorte llena o un programa cerrado se ven en el carrito al instante.
//
// Uso desde la app (server actions / route handlers):
//   const lines = parseCartCookie(cookieStore.get(CART_COOKIE)?.value)
//   const next = await addCartLine(prisma, lines, input)      // valida y normaliza (cohorte por defecto…)
//   cookieStore.set(CART_COOKIE, serializeCart(next), CART_COOKIE_OPTIONS)
//   const cart = await resolveCart({ db: prisma, now: () => new Date() }, lines)
import type { Modality, PlanKind } from "@/generated/prisma/client";
import type { Db } from "@/server/deps";
import { DomainError, isDomainError } from "@/server/errors";
import { quote } from "@/server/quote";
import { getCohortAvailability } from "@/server/seats";

export const CART_COOKIE = "ceium_cart";
export const CART_COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" && !(process.env.APP_URL ?? "").startsWith("http://"), maxAge: 60 * 60 * 24 * 30 };
/** Una inscripción es personal: un mismo programa no puede estar dos veces ni con cantidad > 1. */
export const MAX_QUANTITY = 1;
const MAX_LINES = 20;

export interface CartLine {
  /** Id estable de la línea (el formulario de cantidad/eliminar la referencia). */
  key: string;
  productId: string;
  modality: Modality;
  sedeId: string | null;
  cohortId: string | null;
  choiceId: string | null;
  planKind: PlanKind;
}

export interface CartLineInput {
  productId: string;
  modality: Modality;
  sedeId?: string | null;
  cohortId?: string | null;
  choiceId?: string | null;
  planKind: PlanKind;
}

const MODALITIES: readonly Modality[] = ["ONLINE", "SEMIPRESENCIAL"];
const PLANS: readonly PlanKind[] = ["FULL", "HALF", "MONTHLY"];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function optId(v: unknown): string | null {
  return typeof v === "string" && ID_RE.test(v) ? v : null;
}

/** Lee la cookie. Tolera basura (cookie manipulada o de una versión vieja): devuelve solo líneas válidas. */
export function parseCartCookie(raw: string | undefined | null): CartLine[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: CartLine[] = [];
  const seen = new Set<string>();
  for (const x of data.slice(0, MAX_LINES)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const key = optId(o.k);
    const productId = optId(o.p);
    const modality = o.m === "S" ? "SEMIPRESENCIAL" : o.m === "O" ? "ONLINE" : null;
    const planKind = PLANS.find((p) => p === o.pl) ?? null;
    if (!key || !productId || !modality || !planKind || seen.has(productId)) continue;
    seen.add(productId);
    out.push({
      key,
      productId,
      modality,
      sedeId: modality === "ONLINE" ? null : optId(o.s),
      cohortId: modality === "ONLINE" ? null : optId(o.c),
      choiceId: optId(o.ch),
      planKind,
    });
  }
  return out;
}

export function serializeCart(lines: CartLine[]): string {
  const compact = lines.slice(0, MAX_LINES).map((l) => ({
    k: l.key,
    p: l.productId,
    m: l.modality === "ONLINE" ? "O" : "S",
    ...(l.sedeId ? { s: l.sedeId } : {}),
    ...(l.cohortId ? { c: l.cohortId } : {}),
    ...(l.choiceId ? { ch: l.choiceId } : {}),
    pl: l.planKind,
  }));
  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

function newKey(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Valida una entrada externa (form/JSON) sin tocar la BD. */
export function parseLineInput(raw: Record<string, unknown>): CartLineInput {
  const productId = optId(raw.productId);
  const modality = MODALITIES.find((m) => m === String(raw.modality ?? "").toUpperCase()) ?? null;
  const planKind = PLANS.find((p) => p === String(raw.planKind ?? "").toUpperCase()) ?? null;
  if (!productId) throw new DomainError("VALIDATION", "Selecciona un programa.");
  if (!modality) throw new DomainError("VALIDATION", "Selecciona la modalidad.");
  if (!planKind) throw new DomainError("VALIDATION", "Selecciona la forma de pago.");
  return { productId, modality, planKind, sedeId: optId(raw.sedeId), cohortId: optId(raw.cohortId), choiceId: optId(raw.choiceId) };
}

/**
 * Agrega (o reemplaza) la línea de un programa. Valida contra la BD con `quote()` y, en semipresencial, fija la
 * cohorte: la elegida (debe ser del programa y la sede, abierta y con cupo) o, si no se eligió, la próxima
 * cohorte abierta con cupo de esa sede. El cupo NO se reserva aquí: se reserva al crear el pedido en el checkout.
 */
export async function addCartLine(db: Db, lines: CartLine[], raw: CartLineInput, now: Date = new Date()): Promise<CartLine[]> {
  const input = parseLineInput(raw as unknown as Record<string, unknown>);
  let sedeId = input.modality === "ONLINE" ? null : input.sedeId ?? null;
  let cohortId: string | null = null;
  if (input.modality === "SEMIPRESENCIAL") {
    if (input.cohortId) {
      const c = await db.cohort.findUnique({ where: { id: input.cohortId } });
      if (!c || c.productId !== input.productId) throw new DomainError("VALIDATION", "La cohorte seleccionada no corresponde a este programa.");
      if (sedeId && c.sedeId !== sedeId) throw new DomainError("VALIDATION", "La cohorte seleccionada es de otra sede.");
      sedeId = c.sedeId;
      const av = await getCohortAvailability({ db, now: () => now }, c.id);
      if (!av.purchasable) throw new DomainError("SOLD_OUT", av.available <= 0 ? "Esta cohorte ya no tiene cupos disponibles." : "Las inscripciones de esta cohorte están cerradas.");
      cohortId = c.id;
    } else {
      if (!sedeId) throw new DomainError("VALIDATION", "Selecciona una sede.");
      cohortId = await defaultCohortId(db, input.productId, sedeId, now);
      if (!cohortId) throw new DomainError("SOLD_OUT", "No hay cohortes con cupos disponibles en esta sede.");
    }
  }
  // Mismas reglas que el checkout: precio configurado, plan activo, inscripciones abiertas…
  await quote(db, { productId: input.productId, modality: input.modality, sedeId, choiceId: input.choiceId, planKind: input.planKind }, now);

  const existing = lines.find((l) => l.productId === input.productId);
  const line: CartLine = { key: existing?.key ?? newKey(), productId: input.productId, modality: input.modality, sedeId, cohortId, choiceId: input.choiceId ?? null, planKind: input.planKind };
  const next = existing ? lines.map((l) => (l.productId === input.productId ? line : l)) : [line, ...lines]; // lo último agregado, arriba (como Shopify)
  if (next.length > MAX_LINES) throw new DomainError("VALIDATION", `El carrito admite hasta ${MAX_LINES} programas.`);
  return next;
}

/**
 * Quita las líneas cuyo programa ya no existe (se borró, o la cookie viene de una BD anterior). Todo lo que lee
 * el carrito pasa por aquí, así la burbuja del header y la página del carrito cuentan las mismas líneas, y la
 * siguiente escritura del carrito limpia la cookie.
 */
export async function dropMissingProducts(db: Db, lines: CartLine[]): Promise<CartLine[]> {
  if (lines.length === 0) return lines;
  const found = await db.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } }, select: { id: true } });
  const ids = new Set(found.map((p) => p.id));
  return lines.filter((l) => ids.has(l.productId));
}

export function removeCartLine(lines: CartLine[], key: string): CartLine[] {
  return lines.filter((l) => l.key !== key);
}

/** Próxima cohorte (por fecha de inicio) abierta y con cupo del programa en esa sede. */
export async function defaultCohortId(db: Db, productId: string, sedeId: string, now: Date = new Date()): Promise<string | null> {
  const cohorts = await db.cohort.findMany({ where: { productId, sedeId, status: "OPEN" }, orderBy: { startDate: "asc" } });
  for (const c of cohorts) {
    if ((await getCohortAvailability({ db, now: () => now }, c.id)).purchasable) return c.id;
  }
  return null;
}

// ───────────── Vista del carrito ─────────────

export interface CartOption {
  name: string;
  value: string;
}

export interface ResolvedCartLine {
  key: string;
  productId: string;
  slug: string;
  href: string;
  title: string;
  productType: "COURSE" | "DIPLOMA";
  imageUrl: string | null;
  imageAlt: string;
  /** "Modalidad: Online", "Sede: Barquisimeto", "Cohorte: …", "Forma de pago: …" (en el orden de la ficha). */
  options: CartOption[];
  planKind: PlanKind;
  planLabel: string;
  /** Lo que se paga ahora por esta línea (como el precio de la variante en Shopify). */
  priceCents: number;
  /** Total del programa con el plan elegido. */
  programTotalCents: number;
  /** Precio de lista del programa (sin descuento del plan). */
  listCents: number;
  /** Descuento del plan (p. ej. 10% por pago total); 0 si el plan no tiene. */
  discountCents: number;
  discountPct: number;
  /** Aclaración del plan (mitad / mes a mes): cuánto queda y cómo se paga. */
  planNote: string | null;
  /** Aviso de cupos (semipresencial, pocos cupos). */
  seatNote: string | null;
  /** La línea no se puede comprar tal cual (sin precio, cohorte llena, inscripciones cerradas…). */
  error: string | null;
  quantity: number;
}

export interface ResolvedCart {
  lines: ResolvedCartLine[];
  count: number;
  /** Total estimado a pagar hoy (suma de los primeros pagos). */
  dueNowCents: number;
  /** Suma de los totales de los programas (≥ dueNowCents si hay planes fraccionados). */
  programTotalCents: number;
  /** Suma de los descuentos de los planes elegidos. */
  discountCents: number;
  hasSplitPlans: boolean;
  /** Hay líneas con error: el checkout queda bloqueado hasta corregirlas. */
  blocked: boolean;
}

const LOW_SEATS = 5;

function fmtDate(d: Date): string {
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Caracas" }).format(d).replace(/\./g, "");
}

function usd(cents: number): string {
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function resolveCart(d: { db: Db; now: () => Date }, lines: CartLine[]): Promise<ResolvedCart> {
  const { db } = d;
  const now = d.now();
  if (lines.length === 0) return { lines: [], count: 0, dueNowCents: 0, programTotalCents: 0, discountCents: 0, hasSplitPlans: false, blocked: false };
  const products = await db.product.findMany({
    where: { id: { in: lines.map((l) => l.productId) } },
    include: { images: { orderBy: { position: "asc" }, take: 1 }, choices: true },
  });
  const sedeIds = lines.map((l) => l.sedeId).filter((x): x is string => !!x);
  const cohortIds = lines.map((l) => l.cohortId).filter((x): x is string => !!x);
  const [sedes, cohorts] = await Promise.all([
    sedeIds.length ? db.sede.findMany({ where: { id: { in: sedeIds } } }) : [],
    cohortIds.length ? db.cohort.findMany({ where: { id: { in: cohortIds } } }) : [],
  ]);

  const out: ResolvedCartLine[] = [];
  for (const l of lines) {
    const p = products.find((x) => x.id === l.productId);
    if (!p) continue; // programa borrado: la línea desaparece
    const sede = sedes.find((s) => s.id === l.sedeId) ?? null;
    const cohort = cohorts.find((c) => c.id === l.cohortId) ?? null;
    const choice = p.choices.find((c) => c.id === l.choiceId) ?? null;
    let error: string | null = null;
    let seatNote: string | null = null;
    let planLabel = "";
    let priceCents = 0;
    let programTotalCents = 0;
    let listCents = 0;
    let discountCents = 0;
    let discountPct = 0;
    let planNote: string | null = null;

    try {
      const q = await quote(db, { productId: p.id, modality: l.modality, sedeId: l.sedeId, choiceId: l.choiceId, planKind: l.planKind }, now);
      planLabel = q.planLabel;
      priceCents = q.dueNowCents;
      programTotalCents = q.totalCents;
      listCents = q.listCents;
      discountCents = q.discountCents;
      discountPct = q.discountPct;
      const rest = q.totalCents - q.dueNowCents;
      if (q.planKind === "HALF" && rest > 0) planNote = `Hoy pagas la mitad; el saldo de ${usd(rest)} se paga después.`;
      if (q.planKind === "MONTHLY" && q.installments.length > 1) {
        planNote = `Pagas el primer curso ahora; luego ${q.installments.length - 1} cuotas mensuales de ${usd(q.installments[1].amountCents)} (un curso por mes).`;
      }
    } catch (e) {
      if (!isDomainError(e)) throw e;
      error = e.message;
      const plan = await db.paymentPlan.findFirst({ where: { productId: p.id, kind: l.planKind } });
      planLabel = plan?.label ?? "";
    }

    if (l.modality === "SEMIPRESENCIAL" && !error) {
      if (!cohort || cohort.productId !== p.id) error = "Elige una cohorte para la modalidad semipresencial.";
      else {
        const av = await getCohortAvailability(d, cohort.id);
        if (!av.purchasable) error = av.available <= 0 ? "Sin cupo. Esta cohorte ya no tiene cupos disponibles; elige otra cohorte." : "Las inscripciones de esta cohorte están cerradas.";
        else if (av.available <= LOW_SEATS) seatNote = av.available === 1 ? "¡Queda 1 cupo!" : `¡Quedan ${av.available} cupos!`;
      }
    }

    const options: CartOption[] = [];
    if (choice) options.push({ name: choice.groupName, value: choice.label });
    options.push({ name: "Modalidad", value: l.modality === "ONLINE" ? "Online" : "Semipresencial" });
    options.push({ name: "Sede", value: l.modality === "ONLINE" ? "Online" : sede?.name ?? "—" });
    if (cohort && l.modality === "SEMIPRESENCIAL") options.push({ name: "Cohorte", value: `${cohort.name.replace(/^Cohorte\s+/i, "")} · inicia el ${fmtDate(cohort.startDate)}` });
    if (planLabel) options.push({ name: "Forma de pago", value: planLabel });

    const img = p.images[0];
    out.push({
      key: l.key,
      productId: p.id,
      slug: p.slug,
      href: `/products/${p.slug}`,
      title: p.title,
      productType: p.type,
      imageUrl: img?.url ?? null,
      imageAlt: img?.alt ?? p.title,
      options,
      planKind: l.planKind,
      planLabel,
      priceCents,
      programTotalCents,
      listCents,
      discountCents,
      discountPct,
      planNote,
      seatNote,
      error,
      quantity: 1,
    });
  }
  const ok = out.filter((l) => !l.error);
  return {
    lines: out,
    count: out.length,
    dueNowCents: ok.reduce((a, l) => a + l.priceCents, 0),
    programTotalCents: ok.reduce((a, l) => a + l.programTotalCents, 0),
    discountCents: ok.reduce((a, l) => a + l.discountCents, 0),
    hasSplitPlans: ok.some((l) => l.programTotalCents > l.priceCents),
    blocked: out.some((l) => !!l.error),
  };
}

/** Líneas listas para `createCheckout` (el checkout las vuelve a validar todas). */
export function cartCheckoutItems(lines: CartLine[]) {
  return lines.map((l) => ({ productId: l.productId, modality: l.modality, sedeId: l.sedeId, cohortId: l.cohortId, choiceId: l.choiceId, planKind: l.planKind }));
}
