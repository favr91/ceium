// Lecturas de Cohortes y Sedes del panel (solo lectura: las escrituras pasan por services().cohorts / catalog).
import { prisma } from "@/server/db";
import { services } from "@/server/services";
import { liveHeldCounts } from "@/server/seats";
import type { CohortContext, CohortForm, CohortRow, CohortStatus, ProgramOption, ReservationRow, Seats, SessionItem } from "@/components/admin/cohorts/types";

/** Día de Venezuela (UTC−4) de una fecha guardada → AAAA-MM-DD. */
export const vzDay = (d: Date) => new Date(d.getTime() - 4 * 3600_000).toISOString().slice(0, 10);
export const todayVz = () => vzDay(new Date());

function seatsOf(c: { capacity: number; seatsConfirmed: number; seatsHeld: number }, liveHeld: number): Seats {
  const held = Math.min(liveHeld, c.seatsHeld);
  return { capacity: c.capacity, confirmed: c.seatsConfirmed, held, stale: Math.max(0, c.seatsHeld - held), free: Math.max(0, c.capacity - c.seatsConfirmed - held) };
}

function sessionList(v: unknown): SessionItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ date: String(x.date ?? ""), title: String(x.title ?? ""), startTime: String(x.startTime ?? ""), endTime: String(x.endTime ?? ""), courseSlug: String(x.courseSlug ?? "") }));
}

export async function listCohortRows(): Promise<CohortRow[]> {
  const cohorts = await prisma.cohort.findMany({
    orderBy: [{ startDate: "asc" }, { name: "asc" }],
    include: {
      product: { select: { title: true, type: true, images: { orderBy: { position: "asc" }, take: 1, select: { url: true } } } },
      sede: { select: { name: true } },
    },
  });
  const held = await liveHeldCounts(services().deps);
  return cohorts.map((c) => ({
    id: c.id,
    name: c.name,
    productId: c.productId,
    productTitle: c.product.title,
    productType: c.product.type as "COURSE" | "DIPLOMA",
    image: c.product.images[0]?.url ?? null,
    sedeId: c.sedeId,
    sedeName: c.sede.name,
    startDate: vzDay(c.startDate),
    endDate: vzDay(c.endDate),
    enrollmentDeadline: c.enrollmentDeadline ? vzDay(c.enrollmentDeadline) : null,
    status: c.status as CohortStatus,
    isSample: c.isSample,
    sessions: sessionList(c.sessions).length,
    seats: seatsOf(c, held.get(c.id) ?? 0),
  }));
}

export async function sedeOptions() {
  const s = await prisma.sede.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }], select: { id: true, name: true, slug: true, active: true, address: true } });
  return s;
}

export async function programOptions(): Promise<ProgramOption[]> {
  const ps = await prisma.product.findMany({
    where: { offersSemipresencial: true },
    orderBy: [{ position: "asc" }, { title: "asc" }],
    select: {
      id: true,
      title: true,
      slug: true,
      type: true,
      published: true,
      prices: { where: { modality: "SEMIPRESENCIAL", active: true, choiceId: null }, select: { sedeId: true, priceCents: true } },
      diplomaCourses: { orderBy: { position: "asc" }, select: { course: { select: { title: true, slug: true } } } },
    },
  });
  return ps.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    type: p.type as "COURSE" | "DIPLOMA",
    published: p.published,
    courses: p.diplomaCourses.map((d) => d.course),
    prices: Object.fromEntries(p.prices.filter((x) => x.sedeId).map((x) => [x.sedeId!, x.priceCents])),
  }));
}

function baseCtx(programs: ProgramOption[], sedes: Awaited<ReturnType<typeof sedeOptions>>): CohortContext {
  return { programs, sedes, seats: null, purchasable: null, reservations: [], audit: [], hasSales: false, isSample: false, prevId: null, nextId: null, createdAt: null, updatedAt: null };
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Formulario de alta. `from` = cohorte a duplicar (mismo programa y sede, fechas corridas al siguiente ciclo). */
export async function newCohortEditor(opts: { productId?: string; sedeId?: string; from?: string }): Promise<{ form: CohortForm; ctx: CohortContext }> {
  const [programs, sedes] = await Promise.all([programOptions(), sedeOptions()]);
  const src = opts.from ? await prisma.cohort.findUnique({ where: { id: opts.from } }) : null;
  const today = todayVz();
  let form: CohortForm = {
    id: null,
    productId: programs.some((p) => p.id === opts.productId) ? opts.productId! : "",
    sedeId: sedes.some((s) => s.id === opts.sedeId) ? opts.sedeId! : "",
    name: "",
    startDate: "",
    endDate: "",
    enrollmentDeadline: "",
    capacity: "",
    status: "DRAFT",
    sessions: [],
    notes: "",
    scheduleUrl: "",
  };
  if (src) {
    const s0 = vzDay(src.startDate);
    const e0 = vzDay(src.endDate);
    // El siguiente ciclo empieza después de que termina este (o de hoy, si ya pasó), el mismo día de la semana.
    const wd = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
    let start = addDays(e0 > today ? e0 : today, 1);
    while (wd(start) !== wd(s0)) start = addDays(start, 1);
    const shift = Math.round((Date.parse(start) - Date.parse(s0)) / 86_400_000);
    form = {
      ...form,
      productId: src.productId,
      sedeId: src.sedeId,
      name: `${src.name} (copia)`,
      startDate: start,
      endDate: addDays(e0, shift),
      enrollmentDeadline: src.enrollmentDeadline ? addDays(vzDay(src.enrollmentDeadline), shift) : "",
      capacity: String(src.capacity),
      sessions: sessionList(src.sessions).map((x) => ({ ...x, date: x.date ? addDays(x.date, shift) : "" })),
      notes: src.notes ?? "",
    };
  }
  return { form, ctx: baseCtx(programs, sedes) };
}

function purchasableReason(c: { status: string; enrollmentDeadline: Date | null }, seats: Seats, published: boolean, sedeActive: boolean, price: number | undefined): { ok: boolean; reason: string } {
  if (c.status !== "OPEN") return { ok: false, reason: "El estado no permite ventas: ábrela para venderla." };
  if (c.enrollmentDeadline && vzDay(c.enrollmentDeadline) < todayVz()) return { ok: false, reason: "Pasó el cierre de inscripciones." };
  if (seats.free <= 0) return { ok: false, reason: "No quedan cupos libres." };
  if (!published) return { ok: false, reason: "El programa no está publicado en la tienda." };
  if (price == null) return { ok: false, reason: "El programa no tiene precio semipresencial en esta sede." };
  if (!sedeActive) return { ok: true, reason: "Se puede comprar, aunque la sede está inactiva (no aparece en el pie de la tienda)." };
  return { ok: true, reason: `Se puede comprar en la tienda: ${seats.free} ${seats.free === 1 ? "cupo libre" : "cupos libres"}.` };
}

export async function cohortEditor(id: string): Promise<{ form: CohortForm; ctx: CohortContext } | null> {
  const c = await prisma.cohort.findUnique({ where: { id }, include: { product: { select: { published: true } }, sede: { select: { active: true } } } });
  if (!c) return null;
  const [programs, sedes, held, reservations, items, audit, siblings] = await Promise.all([
    programOptions(),
    sedeOptions(),
    liveHeldCounts(services().deps, [id]),
    prisma.seatReservation.findMany({
      where: { cohortId: id },
      orderBy: [{ createdAt: "desc" }],
      include: {
        order: { select: { id: true, number: true, status: true, amountPaidCents: true, buyerFirstName: true, buyerLastName: true, customer: { select: { firstName: true, lastName: true, email: true } } } },
        orderItem: { select: { planLabel: true, planKind: true } },
      },
    }),
    prisma.orderItem.count({ where: { cohortId: id } }),
    prisma.auditLog.findMany({ where: { entityType: "Cohort", entityId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10, include: { actor: { select: { name: true } } } }),
    prisma.cohort.findMany({ orderBy: [{ startDate: "asc" }, { name: "asc" }], select: { id: true } }),
  ]);
  const seats = seatsOf(c, held.get(id) ?? 0);
  const now = Date.now();
  const liveIds = new Set<string>();
  // Mismo criterio que liveHeldCounts: una HELD vencida sigue viva si el pedido tiene dinero en camino.
  const PROTECTED = new Set(["AWAITING_VERIFICATION", "PAID", "PARTIALLY_PAID", "ENROLLED"]);
  for (const r of reservations) if (r.status === "HELD" && (r.expiresAt.getTime() >= now || PROTECTED.has(r.order.status) || r.order.amountPaidCents > 0)) liveIds.add(r.id);
  const rows: ReservationRow[] = reservations.map((r) => ({
    id: r.id,
    status: r.status as ReservationRow["status"],
    live: r.status === "CONFIRMED" || liveIds.has(r.id),
    orderId: r.order.id,
    orderNumber: r.order.number,
    orderStatus: r.order.status,
    customer: [r.order.buyerFirstName ?? r.order.customer.firstName, r.order.buyerLastName ?? r.order.customer.lastName].filter(Boolean).join(" "),
    email: r.order.customer.email,
    plan: r.orderItem?.planLabel ?? null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    releasedReason: r.releasedReason,
  }));
  const idx = siblings.findIndex((s) => s.id === id);
  const price = programs.find((p) => p.id === c.productId)?.prices[c.sedeId];
  const form: CohortForm = {
    id: c.id,
    productId: c.productId,
    sedeId: c.sedeId,
    name: c.name,
    startDate: vzDay(c.startDate),
    endDate: vzDay(c.endDate),
    enrollmentDeadline: c.enrollmentDeadline ? vzDay(c.enrollmentDeadline) : "",
    capacity: String(c.capacity),
    status: c.status as CohortStatus,
    sessions: sessionList(c.sessions),
    notes: c.notes ?? "",
    scheduleUrl: c.scheduleUrl ?? "",
  };
  return {
    form,
    ctx: {
      ...baseCtx(programs, sedes),
      seats,
      purchasable: purchasableReason(c, seats, c.product.published, c.sede.active, price),
      reservations: rows,
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        when: a.createdAt.toISOString(),
        who: a.actor?.name ?? a.actorEmail ?? null,
        note: a.note,
        fields: Array.isArray(a.changes) ? (a.changes as { field?: string }[]).map((x) => x.field ?? "").filter(Boolean) : [],
      })),
      hasSales: items > 0 || reservations.length > 0 || c.seatsHeld + c.seatsConfirmed > 0,
      isSample: c.isSample,
      prevId: idx > 0 ? siblings[idx - 1].id : null,
      nextId: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1].id : null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    },
  };
}

/** Sedes con su «inventario»: cohortes y cupos por estado. */
export async function sedeRows() {
  const [sedes, rows, prices] = await Promise.all([
    prisma.sede.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
    listCohortRows(),
    prisma.priceEntry.groupBy({ by: ["sedeId"], where: { modality: "SEMIPRESENCIAL", active: true }, _count: { _all: true } }),
  ]);
  const priceCount = new Map(prices.map((p) => [p.sedeId, p._count._all]));
  return sedes.map((s) => {
    const mine = rows.filter((r) => r.sedeId === s.id);
    const open = mine.filter((r) => r.status === "OPEN");
    const sum = (k: keyof Seats) => open.reduce((a, r) => a + r.seats[k], 0);
    const next = open.filter((r) => r.startDate >= todayVz()).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      city: s.city ?? "",
      address: s.address ?? "",
      phone: s.phone ?? "",
      mapUrl: s.mapUrl ?? "",
      active: s.active,
      position: s.position,
      cohorts: mine.length,
      openCohorts: open.length,
      inProgress: mine.filter((r) => r.status === "IN_PROGRESS").length,
      seats: { capacity: sum("capacity"), confirmed: sum("confirmed"), held: sum("held"), stale: sum("stale"), free: sum("free") } as Seats,
      prices: priceCount.get(s.id) ?? 0,
      next: next ? { id: next.id, name: next.name, program: next.productTitle, startDate: next.startDate } : null,
      updatedAt: s.updatedAt.toISOString(),
    };
  });
}
export type SedeRow = Awaited<ReturnType<typeof sedeRows>>[number];
