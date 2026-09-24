// Datos de prueba para los e2e, creados con los MISMOS servicios de dominio que usan el panel y la tienda
// (nada de SQL directo ni atajos en la app). Se ejecuta con el entorno de la app bajo prueba
// (DATABASE_URL de la BD e2e o del carril):
//   npx tsx scripts/e2e-fixture.ts diploma-cohort '{"capacity":3}'
//   npx tsx scripts/e2e-fixture.ts checkout '{"productId":"…","cohortId":"…","planKind":"FULL","email":"…"}'
//   npx tsx scripts/e2e-fixture.ts setting '{"key":"enrollment.retry","value":{"maxAttempts":8,"baseDelaySeconds":5}}'
// Imprime una sola línea `@@JSON <resultado>` (lo demás es log).
import "dotenv/config";
import { createDefaultDeps, createServices, services } from "../src/server/services";
import type { SessionUser } from "../src/server/auth";

const DEFAULT_DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";

async function adminSession(): Promise<SessionUser> {
  const db = services().deps.db;
  const a = await db.adminUser.findFirstOrThrow({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, name: true, role: true } });
  return a as SessionUser;
}

type Input = Record<string, unknown>;

const commands: Record<string, (input: Input) => Promise<unknown>> = {
  /** Cohorte NUEVA (abierta) de un diplomado semipresencial en una sede, con el cupo pedido. */
  async "diploma-cohort"(input) {
    const s = services();
    const db = s.deps.db;
    const product = await db.product.findUniqueOrThrow({
      where: { slug: String(input.product ?? DEFAULT_DIPLOMA) },
      include: { diplomaCourses: { orderBy: { position: "asc" }, include: { course: { select: { id: true, title: true, moodleCourseId: true } } } } },
    });
    const sede = await db.sede.findUniqueOrThrow({ where: { slug: String(input.sede ?? "barquisimeto") } });
    const start = new Date(Date.now() + 30 * 24 * 3600_000);
    const sessions = product.diplomaCourses.map((dc, i) => ({ date: new Date(start.getTime() + i * 28 * 24 * 3600_000).toISOString().slice(0, 10), title: dc.course.title }));
    const cohort = await s.cohorts.createCohort(await adminSession(), {
      productId: product.id,
      sedeId: sede.id,
      name: String(input.name ?? `Cohorte e2e ${Date.now().toString(36)}`),
      startDate: start,
      endDate: new Date(start.getTime() + product.diplomaCourses.length * 28 * 24 * 3600_000),
      capacity: Number(input.capacity ?? 3),
      status: "OPEN",
      sessions,
      notes: "Cohorte creada por el e2e de compra con PayPal.",
    });
    return {
      productId: product.id,
      productTitle: product.title,
      sedeId: sede.id,
      sedeName: sede.name,
      cohortId: cohort.id,
      cohortName: cohort.name,
      capacity: cohort.capacity,
      courses: product.diplomaCourses.map((dc) => ({ id: dc.course.id, title: dc.course.title, moodleCourseId: dc.course.moodleCourseId })),
    };
  },

  /** Cohorte NUEVA (abierta) de un curso semipresencial en una sede, con el cupo pedido (como en el panel). */
  async "course-cohort"(input) {
    const s = services();
    const db = s.deps.db;
    const product = await db.product.findUniqueOrThrow({ where: { slug: String(input.product) }, select: { id: true, title: true, type: true, moodleCourseId: true } });
    if (product.type !== "COURSE") throw new Error(`${input.product} no es un curso`);
    const sede = await db.sede.findUniqueOrThrow({ where: { slug: String(input.sede ?? "barquisimeto") } });
    const start = new Date(Date.now() + 21 * 24 * 3600_000);
    const cohort = await s.cohorts.createCohort(await adminSession(), {
      productId: product.id,
      sedeId: sede.id,
      name: String(input.name ?? `Cohorte e2e ${Date.now().toString(36)}`),
      startDate: start,
      endDate: new Date(start.getTime() + 28 * 24 * 3600_000),
      capacity: Number(input.capacity ?? 3),
      status: "OPEN",
      sessions: [{ date: start.toISOString().slice(0, 10), title: "Sesión práctica en sede" }],
      notes: "Cohorte creada por el e2e de pago manual.",
    });
    return { productId: product.id, productTitle: product.title, moodleCourseId: product.moodleCourseId, sedeId: sede.id, sedeSlug: sede.slug, sedeName: sede.name, cohortId: cohort.id, cohortName: cohort.name, capacity: cohort.capacity };
  },

  /** Checkout como lo hace la tienda (createCheckout): reserva el cupo y deja el pedido en PENDING_PAYMENT. */
  async checkout(input) {
    const o = await services().orders.createCheckout({
      customer: {
        email: String(input.email),
        firstName: String(input.firstName ?? "María"),
        lastName: String(input.lastName ?? "Pérez"),
        cedula: String(input.cedula ?? "V-12345678"),
        phone: "0414-1234567",
        specialty: "Medicina general",
        city: "Barquisimeto",
      },
      items: [{ productId: String(input.productId), modality: "SEMIPRESENCIAL", cohortId: String(input.cohortId), planKind: input.planKind as "FULL" | "HALF" | "MONTHLY" }],
      paymentMethod: (input.paymentMethod as "PAYPAL" | "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "EFECTIVO" | undefined) ?? "PAYPAL",
    });
    return {
      orderId: o.id,
      token: o.token,
      number: o.number,
      totalCents: o.totalCents,
      dueNowCents: o.dueNowCents,
      installments: o.installments.map((i) => ({ id: i.id, sequence: i.sequence, amountCents: i.amountCents, moodleCourseId: i.moodleCourseId })),
    };
  },

  /**
   * Reloj simulado: hace «pasar» `minutes` minutos para UN pedido corriendo hacia atrás sus marcas de tiempo
   * (placedAt, plazo del pedido y de la reserva, creación de sus pagos y el plazo guardado en su evento
   * CREATED). Es lo único que no pasa por servicios: la app no tiene forma de adelantar el reloj.
   */
  async "age-order"(input) {
    const db = services().deps.db;
    const id = String(input.orderId);
    const ms = Number(input.minutes) * 60_000;
    const back = (x: Date | null) => (x ? new Date(x.getTime() - ms) : x);
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { reservations: true, payments: true, events: { where: { type: "CREATED" } } } });
    await db.order.update({ where: { id }, data: { placedAt: back(o.placedAt)!, expiresAt: back(o.expiresAt) } });
    for (const r of o.reservations) await db.seatReservation.update({ where: { id: r.id }, data: { expiresAt: back(r.expiresAt)!, createdAt: back(r.createdAt)! } });
    for (const p of o.payments) await db.payment.update({ where: { id: p.id }, data: { createdAt: back(p.createdAt)! } });
    for (const e of o.events) {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const exp = Date.parse(String(data.expiresAt ?? ""));
      await db.orderEvent.update({ where: { id: e.id }, data: { createdAt: back(e.createdAt)!, ...(Number.isFinite(exp) ? { data: { ...data, expiresAt: new Date(exp - ms).toISOString() } } : {}) } });
    }
    const after = await db.order.findUniqueOrThrow({ where: { id }, select: { placedAt: true, expiresAt: true } });
    return { orderId: id, placedAt: after.placedAt, expiresAt: after.expiresAt };
  },

  /** Reembolso desde el panel (ADMIN), con las opciones del formulario. */
  async refund(input) {
    const s = services();
    const r = await s.payments.refundPayment(await adminSession(), {
      paymentId: String(input.paymentId),
      amountCents: input.amountCents == null ? undefined : Number(input.amountCents),
      reason: String(input.reason ?? "e2e"),
      unenroll: Boolean(input.unenroll ?? true),
      releaseSeat: Boolean(input.releaseSeat ?? true),
      keepCertificate: false,
      idempotencyKey: String(input.idempotencyKey ?? `e2e-${Date.now()}`),
    });
    return { refundId: r.refund.id, status: r.refund.status, fullyRefunded: r.fullyRefunded };
  },

  /**
   * Reembolso desde el panel cuya llamada a PayPal se queda SIN RESPUESTA (timeout): con `paypalDid` PayPal sí
   * lo hace (el mock lo registra con el PayPal-Request-Id de la fila) y la respuesta se pierde; sin él, falla antes
   * de llegar. Mismo servicio de dominio que el panel, con el puerto de PayPal real envuelto (el mock no simula
   * timeouts). Después «pasan» `ageMinutes` minutos para esa fila (como age-order), para que el job la retome.
   */
  async "refund-lost-response"(input) {
    const base = createDefaultDeps();
    const paypal: typeof base.paypal = {
      ...base.paypal,
      async refundCapture(captureId, amountCents, opts) {
        if (input.paypalDid) await base.paypal.refundCapture(captureId, amountCents, opts);
        throw new Error("fetch failed: ETIMEDOUT (respuesta de PayPal perdida)");
      },
    };
    const s = createServices({ ...base, paypal });
    let error = "";
    try {
      await s.payments.refundPayment(await adminSession(), {
        paymentId: String(input.paymentId),
        amountCents: input.amountCents == null ? undefined : Number(input.amountCents),
        reason: String(input.reason ?? "e2e"),
        unenroll: Boolean(input.unenroll ?? true),
        releaseSeat: Boolean(input.releaseSeat ?? true),
        keepCertificate: false,
        idempotencyKey: String(input.idempotencyKey ?? `e2e-lost-${Date.now()}`),
      });
    } catch (e) {
      error = String((e as Error)?.message ?? e);
    }
    const db = base.db;
    const row = await db.refund.findFirstOrThrow({ where: { paymentId: String(input.paymentId) }, orderBy: { createdAt: "desc" } });
    const ms = Number(input.ageMinutes ?? 10) * 60_000;
    await db.refund.update({ where: { id: row.id }, data: { createdAt: new Date(row.createdAt.getTime() - ms) } });
    return { refundId: row.id, status: row.status, error };
  },

  /** Cambia una configuración como lo hace el panel (auditado) y devuelve el valor anterior. */
  async setting(input) {
    const s = services();
    const key = String(input.key);
    const before = (await s.deps.db.setting.findUnique({ where: { key } }))?.value ?? null;
    await s.settings.updateSetting(await adminSession(), key, input.value, "e2e");
    return { key, before };
  },
};

async function main() {
  const [cmd, raw] = process.argv.slice(2);
  const fn = commands[cmd];
  if (!fn) throw new Error(`comando desconocido: ${cmd} (${Object.keys(commands).join(", ")})`);
  const out = await fn(raw ? (JSON.parse(raw) as Input) : {});
  process.stdout.write(`@@JSON ${JSON.stringify(out)}\n`);
  await services().deps.db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
