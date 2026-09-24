// Pedidos de ejemplo para el panel de Pedidos (pieza a3), creados con los MISMOS servicios de dominio que
// usan la tienda y el panel: checkout, PayPal (mock: aprobar + capturar), pagos móviles/transferencias con su
// comprobante, verificación (aprobar/rechazar) y reembolsos. Solo al final se «envejecen» las fechas de cada
// pedido para que el listado muestre días distintos (dato de prueba, no lógica de la app).
//   DATABASE_URL=file:var/lanes/panel.db PAYPAL_BASE_URL=http://localhost:5103 … npx tsx tests/e2e/support/a3-fixture.ts orders
// Imprime una sola línea `@@JSON {rol: {id, number}}`.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { services } from "../../../src/server/services";
import type { SessionUser } from "../../../src/server/auth";

const s = services();
const db = s.deps.db;
const RATE = 36.5;
const FIX = path.join(__dirname, "..", "fixtures", "a3");

async function admin(): Promise<SessionUser> {
  return (await db.adminUser.findFirstOrThrow({ where: { role: "ADMIN", active: true }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, name: true, role: true } })) as SessionUser;
}

const tag = Date.now().toString(36);
const mail = (u: string) => `${u}.${tag}@example.com`;

async function product(slug: string) {
  return db.product.findUniqueOrThrow({ where: { slug }, select: { id: true, title: true } });
}
/** Cohorte abierta con cupo del programa en la sede (si se llenó con corridas anteriores, se abre otra). */
async function cohortOf(productId: string, sede: string) {
  const all = await db.cohort.findMany({ where: { productId, sede: { slug: sede }, status: "OPEN" }, orderBy: { startDate: "asc" } });
  const c = all.find((x) => x.capacity - x.seatsHeld - x.seatsConfirmed > 0 && (!x.enrollmentDeadline || x.enrollmentDeadline > new Date()));
  if (c) return c;
  const sedeRow = await db.sede.findUniqueOrThrow({ where: { slug: sede } });
  const start = new Date(Date.now() + 35 * 86_400_000);
  const month = new Intl.DateTimeFormat("es-VE", { month: "long", year: "numeric", timeZone: "UTC" }).format(start);
  return s.cohorts.createCohort(await admin(), {
    productId,
    sedeId: sedeRow.id,
    name: `Cohorte ${month[0].toUpperCase()}${month.slice(1)}`,
    startDate: start,
    endDate: new Date(start.getTime() + 28 * 86_400_000),
    capacity: 25,
    status: "OPEN",
    sessions: [{ date: start.toISOString().slice(0, 10), title: "Sesión práctica en sede" }],
  });
}

interface Buyer { first: string; last: string; user: string; cedula: string; phone: string; specialty: string; city: string }
type Item = { productId: string; modality: "ONLINE" | "SEMIPRESENCIAL"; cohortId?: string; planKind: "FULL" | "HALF" | "MONTHLY" };

async function checkout(b: Buyer, item: Item, method: "PAYPAL" | "PAGO_MOVIL" | "TRANSFERENCIA", note?: string) {
  return s.orders.createCheckout({
    customer: { email: mail(b.user), firstName: b.first, lastName: b.last, cedula: b.cedula, phone: b.phone, specialty: b.specialty, city: b.city },
    items: [item],
    paymentMethod: method,
    customerNote: note ?? null,
  });
}

async function payWithPaypal(orderId: string) {
  const start = await s.payments.startPaypalPayment(orderId);
  const base = process.env.PAYPAL_BASE_URL!;
  const r = await fetch(`${base}/__mock/approve/${start.paypalOrderId}?json=1`, { method: "POST" });
  if (!r.ok) throw new Error(`mock approve ${r.status}`);
  await s.payments.capturePaypalReturn(start.paypalOrderId);
  // La matrícula corre en el mismo proceso; esperamos a que el pedido se asiente.
  for (let i = 0; i < 40; i++) {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (o.status === "ENROLLED" || o.status === "PAID" || o.status === "PARTIALLY_PAID") break;
    await new Promise((res) => setTimeout(res, 250));
  }
  return db.payment.findUniqueOrThrow({ where: { id: start.paymentId } });
}

async function payManual(orderId: string, method: "PAGO_MOVIL" | "TRANSFERENCIA", reference: string, bank: string, proof: string, cedula: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const file = await s.payments.storeProofFile(orderId, proof, fs.readFileSync(path.join(FIX, proof)));
  // La referencia del comprobante; en corridas siguientes (ya registrada) se usa otra del mismo banco.
  if (await db.payment.findFirst({ where: { reference } })) reference = `${reference.slice(0, 4)}${String(Date.now()).slice(-8)}`;
  return s.payments.recordManualPayment({
    orderId,
    method,
    reference,
    bank,
    amountCents: Math.round(o.dueNowCents * RATE),
    currency: "VES",
    paidAt: new Date(),
    proofFile: file,
    payerCedula: cedula,
    payerPhone: "0414-5550000",
  });
}

/** Corre hacia atrás todas las marcas de tiempo del pedido (fecha de compra distinta en el listado). */
async function age(orderId: string, hours: number) {
  const ms = hours * 3_600_000;
  const shift = (d: Date | null) => (d ? new Date(d.getTime() - ms) : d);
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  await db.order.update({ where: { id: orderId }, data: { placedAt: shift(o.placedAt)!, paidAt: shift(o.paidAt), enrolledAt: shift(o.enrolledAt), cancelledAt: shift(o.cancelledAt), expiresAt: shift(o.expiresAt) } });
  for (const e of await db.orderEvent.findMany({ where: { orderId } })) await db.orderEvent.update({ where: { id: e.id }, data: { createdAt: shift(e.createdAt)! } });
  for (const m of await db.emailOutbox.findMany({ where: { orderId } })) await db.emailOutbox.update({ where: { id: m.id }, data: { createdAt: shift(m.createdAt)!, sentAt: shift(m.sentAt) } });
  for (const p of await db.payment.findMany({ where: { orderId } })) {
    await db.payment.update({ where: { id: p.id }, data: { createdAt: shift(p.createdAt)!, paidAt: shift(p.paidAt), verifiedAt: shift(p.verifiedAt) } });
    for (const r of await db.refund.findMany({ where: { paymentId: p.id } })) await db.refund.update({ where: { id: r.id }, data: { createdAt: shift(r.createdAt)!, completedAt: shift(r.completedAt) } });
  }
}

const B = {
  andreina: { first: "Andreína", last: "Colmenares Rivas", user: "andreina.colmenares", cedula: "V-17845120", phone: "0414-5087731", specialty: "Ginecología y obstetricia", city: "Barquisimeto" },
  luis: { first: "Luis Alberto", last: "Mendoza Pérez", user: "luis.mendoza", cedula: "V-15332874", phone: "0424-5561290", specialty: "Medicina interna", city: "Barquisimeto" },
  mariela: { first: "Mariela", last: "Quintero Añez", user: "mariela.quintero", cedula: "V-19657002", phone: "0412-6620147", specialty: "Medicina general", city: "Caracas" },
  jesus: { first: "Jesús", last: "Rangel Torrealba", user: "jesus.rangel", cedula: "V-20114563", phone: "0416-3018842", specialty: "Radiología", city: "Maracaibo" },
  yusmary: { first: "Yusmary", last: "Pacheco Lugo", user: "yusmary.pacheco", cedula: "V-18230991", phone: "0414-7702315", specialty: "Medicina familiar", city: "Barquisimeto" },
  carlos: { first: "Carlos Eduardo", last: "Briceño Méndez", user: "carlos.briceno", cedula: "V-14003578", phone: "0412-5549031", specialty: "Pediatría", city: "Caracas" },
  gabriela: { first: "Gabriela", last: "Salazar Duque", user: "gabriela.salazar", cedula: "V-21448906", phone: "0424-1187765", specialty: "Medicina general", city: "Valencia" },
  rafael: { first: "Rafael", last: "Montilla Guédez", user: "rafael.montilla", cedula: "V-16775410", phone: "0414-9983321", specialty: "Cirugía general", city: "Barquisimeto" },
  oriana: { first: "Oriana", last: "Villalobos Fuenmayor", user: "oriana.villalobos", cedula: "V-22567019", phone: "0426-4471820", specialty: "Ginecología y obstetricia", city: "Maracaibo" },
} satisfies Record<string, Buyer>;

async function orders() {
  const me = await admin();
  const prev = {
    methods: (await db.setting.findUnique({ where: { key: "payments.manualMethods" } }))?.value ?? null,
    rate: (await db.setting.findUnique({ where: { key: "exchangeRate.vesPerUsd" } }))?.value ?? null,
  };
  await s.settings.updateSetting(me, "exchangeRate.vesPerUsd", { vesPerUsd: RATE, source: "BCV", updatedAt: new Date().toISOString() }, "Datos de ejemplo del panel de pedidos");
  await s.settings.updateSetting(
    me,
    "payments.manualMethods",
    [
      { method: "PAGO_MOVIL", enabled: true, label: "Pago Móvil", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra la referencia y el comprobante." },
      { method: "TRANSFERENCIA", enabled: true, label: "Transferencia bancaria", currency: "VES", details: { banco: "Banco Nacional de Crédito (0191)", cuenta: "0191-0087-41-2100004471", rif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Transfiere el monto en bolívares a la tasa indicada y registra la referencia y el comprobante." },
    ],
    "Datos de ejemplo del panel de pedidos",
  );
  const out: Record<string, { id: string; number: number }> = {};
  const keep = (k: string, o: { id: string; number: number }) => (out[k] = { id: o.id, number: o.number });
  try {
    const diploma = await product("diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico");
    const materno = await product("curso-universitario-enfermedades-materno-fetales");
    const pediatrica = await product("curso-universitario-ecografia-pediatrica");
    const eco3d = await product("curso-universitario-ecografia-3d-4d-y-5d-en-obstetricia-y-ginecologia");
    const neuro = await product("curso-universitario-neuroimagen-fetal-y-perinatal");

    // 1. PayPal, curso online, pagado e inscrito (hace 6 días).
    const o1 = await checkout(B.andreina, { productId: eco3d.id, modality: "ONLINE", planKind: "FULL" }, "PAYPAL");
    await payWithPaypal(o1.id);
    keep("paypalPaid", o1);

    // 2. PayPal, diplomado semipresencial, mitad: inscrito con saldo pendiente (hace 5 días).
    const o2 = await checkout(B.luis, { productId: diploma.id, modality: "SEMIPRESENCIAL", cohortId: (await cohortOf(diploma.id, "barquisimeto")).id, planKind: "HALF" }, "PAYPAL", "¿Puedo pagar la segunda mitad en diciembre?");
    await payWithPaypal(o2.id);
    keep("paypalHalf", o2);

    // 3. Transferencia rechazada (hace 4 días).
    const o3 = await checkout(B.yusmary, { productId: materno.id, modality: "SEMIPRESENCIAL", cohortId: (await cohortOf(materno.id, "barquisimeto")).id, planKind: "FULL" }, "TRANSFERENCIA");
    const p3 = await payManual(o3.id, "TRANSFERENCIA", "2026092100318", "Banesco (0134)", "transferencia-1.png", B.yusmary.cedula);
    await s.payments.adminVerifyPayment(me, { paymentId: p3.id, decision: "reject", note: "La referencia no aparece en el estado de cuenta del BNC. Envíanos el comprobante emitido por tu banco." });
    keep("rejected", o3);

    // 4. PayPal reembolsado por completo (hace 3 días).
    const o4 = await checkout(B.carlos, { productId: pediatrica.id, modality: "SEMIPRESENCIAL", cohortId: (await cohortOf(pediatrica.id, "caracas")).id, planKind: "FULL" }, "PAYPAL");
    const p4 = await payWithPaypal(o4.id);
    await s.payments.refundPayment(me, { paymentId: p4.id, reason: "No podrá asistir a las sesiones presenciales en Caracas.", unenroll: true, releaseSeat: true, idempotencyKey: `a3-${tag}-full` });
    keep("refunded", o4);

    // 5. PayPal, diplomado online mes a mes: primera cuota pagada (hace 2 días).
    const o5 = await checkout(B.oriana, { productId: diploma.id, modality: "ONLINE", planKind: "MONTHLY" }, "PAYPAL");
    await payWithPaypal(o5.id);
    keep("monthly", o5);

    // 6. PayPal con reembolso parcial (ayer).
    const o6 = await checkout(B.jesus, { productId: neuro.id, modality: "ONLINE", planKind: "FULL" }, "PAYPAL");
    const p6 = await payWithPaypal(o6.id);
    await s.payments.refundPayment(me, { paymentId: p6.id, amountCents: Math.round(p6.amountUsdCents / 4), reason: "Descuento por pronto pago aplicado después de la compra.", unenroll: false, releaseSeat: false, idempotencyKey: `a3-${tag}-part` });
    keep("partialRefund", o6);

    // 7. PayPal sin completar (hoy).
    const o7 = await checkout(B.rafael, { productId: materno.id, modality: "ONLINE", planKind: "FULL" }, "PAYPAL");
    await s.payments.startPaypalPayment(o7.id);
    keep("pending", o7);

    // 8. PayPal, diplomado online, pagado completo (hoy): el que se reembolsa en el e2e.
    const o8 = await checkout(B.gabriela, { productId: diploma.id, modality: "ONLINE", planKind: "FULL" }, "PAYPAL");
    await payWithPaypal(o8.id);
    keep("paypalFull", o8);

    // 9-10. Pago móvil con comprobante, por verificar (hoy).
    const o9 = await checkout(B.mariela, { productId: materno.id, modality: "SEMIPRESENCIAL", cohortId: (await cohortOf(materno.id, "caracas")).id, planKind: "FULL" }, "PAGO_MOVIL", "Pagué desde la cuenta de mi esposo, Pedro Añez.");
    await payManual(o9.id, "PAGO_MOVIL", "004518772391", "Banco de Venezuela (0102)", "pago-movil-1.png", "V-11987654");
    keep("awaiting", o9);
    const o10 = await checkout(B.andreina, { productId: pediatrica.id, modality: "SEMIPRESENCIAL", cohortId: (await cohortOf(pediatrica.id, "barquisimeto")).id, planKind: "FULL" }, "PAGO_MOVIL");
    await payManual(o10.id, "PAGO_MOVIL", "778120045612", "Mercantil (0105)", "pago-movil-2.png", B.andreina.cedula);
    keep("awaiting2", o10);

    const hours: Record<string, number> = { paypalPaid: 146, paypalHalf: 121, rejected: 98, refunded: 74, monthly: 50, partialRefund: 27, pending: 3, paypalFull: 2, awaiting: 1.2, awaiting2: 0.4 };
    for (const [k, h] of Object.entries(hours)) if (process.env.A3_NO_AGE !== "1") await age(out[k].id, h);
  } finally {
    // Deja la configuración como estaba (si el valor previo era de ejemplo y el panel no lo acepta, se repone tal cual).
    for (const [key, value] of [["payments.manualMethods", prev.methods], ["exchangeRate.vesPerUsd", prev.rate]] as const) {
      if (value == null) continue;
      await s.settings.updateSetting(me, key, value, "Restaurar tras datos de ejemplo").catch(() => db.setting.update({ where: { key }, data: { value: value as object } }));
    }
  }
  return out;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "orders") throw new Error("uso: a3-fixture.ts orders");
  const out = await orders();
  process.stdout.write(`@@JSON ${JSON.stringify(out)}\n`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
