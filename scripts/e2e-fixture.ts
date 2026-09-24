// Datos de prueba para los e2e, creados con los MISMOS servicios de dominio que usan el panel y la tienda
// (nada de SQL directo ni atajos en la app). Se ejecuta con el entorno de la app bajo prueba
// (DATABASE_URL de la BD e2e o del carril):
//   npx tsx scripts/e2e-fixture.ts diploma-cohort '{"capacity":3}'
//   npx tsx scripts/e2e-fixture.ts checkout '{"productId":"…","cohortId":"…","planKind":"FULL","email":"…"}'
//   npx tsx scripts/e2e-fixture.ts setting '{"key":"enrollment.retry","value":{"maxAttempts":8,"baseDelaySeconds":5}}'
// Imprime una sola línea `@@JSON <resultado>` (lo demás es log).
import "dotenv/config";
import { services } from "../src/server/services";
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
      paymentMethod: "PAYPAL",
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
