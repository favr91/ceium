// Médicos de ejemplo para el panel de Matrículas / Certificados / ficha del cliente (pieza a4), creados con los
// MISMOS servicios de dominio que la tienda y el panel: checkout, PayPal (mock: aprobar + capturar) → matrícula
// en el mock de Moodle; luego se marcan cursos completados en el mock (/__mock/complete) y se consulta el
// progreso con el servicio del panel (que emite el certificado cuando corresponde).
//   DATABASE_URL=file:var/lanes/panel.db PAYPAL_BASE_URL=http://localhost:5103 MOODLE_URL=http://localhost:4103 … npx tsx tests/e2e/support/a4-fixture.ts
// Imprime una sola línea `@@JSON {rol: {customerId, orderId, …}}`.
import "dotenv/config";
import { services } from "../../../src/server/services";
import { refreshEnrollmentProgress } from "../../../src/server/admin-learning";
import type { SessionUser } from "../../../src/server/auth";

const s = services();
const db = s.deps.db;
const tag = Date.now().toString(36);
const mail = (u: string) => `${u}.${tag}@example.com`;
const MOODLE = process.env.MOODLE_URL!;

async function admin(): Promise<SessionUser> {
  return (await db.adminUser.findFirstOrThrow({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, name: true, role: true } })) as SessionUser;
}
async function product(slug: string) {
  return db.product.findUniqueOrThrow({ where: { slug }, select: { id: true, title: true } });
}

interface Buyer { first: string; last: string; user: string; cedula: string; phone: string; specialty: string; city: string }
const B = {
  progress: { first: "Daniela", last: "Arrieta Colmenárez", user: "daniela.arrieta", cedula: "V-18990412", phone: "0414-5213398", specialty: "Ginecología y obstetricia", city: "Barquisimeto" },
  certified: { first: "Héctor", last: "Linares Pernía", user: "hector.linares", cedula: "V-13420876", phone: "0424-6650912", specialty: "Radiología", city: "Caracas" },
  blocked: { first: "Marisela", last: "Duarte Yépez", user: "marisela.duarte", cedula: "V-16204335", phone: "0412-7739140", specialty: "Medicina general", city: "Maracaibo" },
  monthly: { first: "Ricardo", last: "Sequera Bello", user: "ricardo.sequera", cedula: "V-19883021", phone: "0416-2208871", specialty: "Medicina interna", city: "Valencia" },
  failed: { first: "Valentina", last: "Oropeza Gil", user: "valentina.oropeza", cedula: "V-24557019", phone: "0426-9910342", specialty: "Medicina familiar", city: "Barquisimeto" },
} satisfies Record<string, Buyer>;

async function buy(b: Buyer, productId: string, planKind: "FULL" | "HALF" | "MONTHLY") {
  const o = await s.orders.createCheckout({
    customer: { email: mail(b.user), firstName: b.first, lastName: b.last, cedula: b.cedula, phone: b.phone, specialty: b.specialty, city: b.city },
    items: [{ productId, modality: "ONLINE", planKind }],
    paymentMethod: "PAYPAL",
    customerNote: null,
  });
  return o;
}

async function payWithPaypal(orderId: string) {
  const start = await s.payments.startPaypalPayment(orderId);
  const r = await fetch(`${process.env.PAYPAL_BASE_URL}/__mock/approve/${start.paypalOrderId}?json=1`, { method: "POST" });
  if (!r.ok) throw new Error(`mock approve ${r.status}`);
  await s.payments.capturePaypalReturn(start.paypalOrderId);
  for (let i = 0; i < 40; i++) {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (o.status === "ENROLLED") break;
    await new Promise((res) => setTimeout(res, 250));
  }
}

async function moodle(pathname: string, body: unknown) {
  const r = await fetch(`${MOODLE}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${pathname} ${r.status}`);
}

/** Marca en Moodle los primeros `n` cursos (en el orden del diplomado) como completados y consulta el progreso. */
async function completeCourses(orderId: string, n: number) {
  const o = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { customer: true, items: { include: { courses: { orderBy: { position: "asc" }, include: { course: true } } } } },
  });
  const courses = o.items.flatMap((it) => it.courses.map((c) => c.course.moodleCourseId!));
  for (const mid of courses.slice(0, n)) await moodle("/__mock/complete", { userid: o.customer.moodleUserId, courseid: mid, completed: true });
  const enr = await db.enrollment.findMany({ where: { customerId: o.customerId }, select: { id: true } });
  await refreshEnrollmentProgress(s.deps, await admin(), enr.map((e) => e.id));
  return o.customerId;
}

async function main() {
  const diploma = await product("diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico");
  const course = await product("curso-universitario-ecografia-obstetrica");
  const out: Record<string, { customerId: string; orderId: string; number: number }> = {};

  // 1) Diplomado pagado completo, 5 de 9 cursos completados.
  const p = await buy(B.progress, diploma.id, "FULL");
  await payWithPaypal(p.id);
  out.progress = { customerId: await completeCourses(p.id, 5), orderId: p.id, number: p.number };

  // 2) Diplomado pagado, 9 de 9 → certificado emitido por la consulta de progreso.
  const c = await buy(B.certified, diploma.id, "FULL");
  await payWithPaypal(c.id);
  out.certified = { customerId: await completeCourses(c.id, 9), orderId: c.id, number: c.number };

  // 3) Mitad y mitad (solo la primera mitad pagada), 9 de 9 → bloqueado por saldo.
  const h = await buy(B.blocked, diploma.id, "HALF");
  await payWithPaypal(h.id);
  out.blocked = { customerId: await completeCourses(h.id, 9), orderId: h.id, number: h.number };

  // 4) Mes a mes: primera cuota pagada → solo el primer curso habilitado (completado); el resto sin habilitar.
  const m = await buy(B.monthly, diploma.id, "MONTHLY");
  await payWithPaypal(m.id);
  out.monthly = { customerId: await completeCourses(m.id, 1), orderId: m.id, number: m.number };

  // 5) Curso suelto cuya matrícula Moodle rechaza (error no reintentable) → «Error de matrícula».
  const f = await buy(B.failed, course.id, "FULL");
  await moodle("/__mock/fail-next", { wsfunction: "enrol_manual_enrol_users", type: "exception", exception: "moodle_exception", errorcode: "enrolnotpermitted", message: "El método de matriculación manual está deshabilitado en este curso.", count: 1 });
  await payWithPaypal(f.id);
  const fo = await db.order.findUniqueOrThrow({ where: { id: f.id }, select: { customerId: true } });
  out.failed = { customerId: fo.customerId, orderId: f.id, number: f.number };

  console.log(`@@JSON ${JSON.stringify(out)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
