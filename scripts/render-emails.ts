// Renderiza TODAS las plantillas de correo del médico a HTML para revisarlas en un navegador:
//   npx tsx scripts/render-emails.ts [carpeta]          (por defecto var/email-preview)
// Los datos salen de la BD (DATABASE_URL): programas reales del catálogo con su imagen, sedes con dirección,
// cohortes con sesiones y, si existe, el último pedido real (buildOrderView, lo mismo que usan los servicios).
// Escribe <plantilla>.html por variante e index.html con enlaces. No envía nada ni escribe en la BD.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { services } from "../src/server/services";
import { buildOrderView } from "../src/server/email";
import * as T from "../src/server/email/templates";

async function main() {
  const out = path.resolve(process.argv[2] ?? "var/email-preview");
  fs.mkdirSync(out, { recursive: true });
  const d = services().deps;
  const db = d.db;
  const app = d.config.appUrl;

  const diploma = await db.product.findFirstOrThrow({
    where: { type: "DIPLOMA", published: true },
    orderBy: { title: "asc" },
    include: { images: { orderBy: { position: "asc" }, take: 1 }, diplomaCourses: { orderBy: { position: "asc" }, include: { course: { select: { title: true } } } } },
  });
  const course = await db.product.findFirstOrThrow({ where: { type: "COURSE", published: true, cohorts: { some: {} } }, orderBy: { title: "asc" }, include: { images: { orderBy: { position: "asc" }, take: 1 } } });
  const cohort = await db.cohort.findFirstOrThrow({ where: { productId: course.id }, include: { sede: true }, orderBy: { startDate: "asc" } });
  const abs = (u?: string | null) => (!u ? null : /^https?:/.test(u) ? u : u.startsWith("//") ? `https:${u}` : `${app}${u}`);
  const short = (x: Date) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Caracas" }).format(x).replace(/\./g, "");

  // Pedido real más reciente (si hay), si no uno de ejemplo con el catálogo real.
  const real = await db.order.findFirst({ where: { status: { in: ["ENROLLED", "PAID"] } }, orderBy: { placedAt: "desc" }, select: { id: true } });
  const sample: T.OrderView = {
    number: 1042,
    statusUrl: `${app}/pedido/ejemplo`,
    customerFirstName: "María",
    customerEmail: "maria.perez@example.com",
    customerFullName: "María José Pérez Rodríguez",
    customerPhone: "0414-1234567",
    placedAt: new Date(),
    storeUrl: app,
    items: [
      {
        title: course.title,
        modalityLabel: `Semipresencial — ${cohort.sede.name}`,
        planLabel: "Paga todo el curso",
        cohortName: cohort.name,
        cohortDates: `${short(cohort.startDate)} – ${short(cohort.endDate)}`,
        totalCents: 18000,
        dueNowCents: 18000,
        imageUrl: abs(course.images[0]?.url),
      },
    ],
    subtotalCents: 18000,
    discountCents: 0,
    totalCents: 18000,
    dueNowCents: 18000,
    amountPaidCents: 18000,
    balanceCents: 0,
    paymentMethodLabel: "PayPal",
  };
  const paidView = real ? (await buildOrderView(d, real.id)).view : sample;
  const pendingView: T.OrderView = { ...sample, amountPaidCents: 0, balanceCents: sample.totalCents, paymentMethodLabel: "Pago móvil", expiresAt: new Date(Date.now() + 72 * 3600_000) };
  const halfView: T.OrderView = {
    ...sample,
    items: [{ title: diploma.title, modalityLabel: "Online", planLabel: "Paga la mitad (5% de descuento)", totalCents: 128155, dueNowCents: 64078, listCents: 134900, imageUrl: abs(diploma.images[0]?.url) }],
    subtotalCents: 134900,
    discountCents: 6745,
    totalCents: 128155,
    dueNowCents: 64078,
    amountPaidCents: 64078,
    balanceCents: 64077,
    paymentMethodLabel: "Pago móvil",
  };
  const monthlyCourses = diploma.diplomaCourses.map((dc) => dc.course.title);
  const monthlyView: T.OrderView = {
    ...sample,
    items: [{ title: diploma.title, modalityLabel: "Online", planLabel: "Paga mes a mes", totalCents: 180 * 100 * monthlyCourses.length, dueNowCents: 18000, imageUrl: abs(diploma.images[0]?.url) }],
    subtotalCents: null,
    discountCents: 0,
    totalCents: 180 * 100 * monthlyCourses.length,
    dueNowCents: 18000,
    amountPaidCents: 36000,
    balanceCents: 180 * 100 * (monthlyCourses.length - 2),
    installments: monthlyCourses.map((t, i) => ({ sequence: i + 1, amountCents: 18000, status: i < 2 ? "PAID" : "PENDING", courseTitle: t })),
  };
  const bank = { label: "Pago Móvil", details: { banco: "Banco Nacional de Crédito (0191)", telefono: "0412-0840407", cedulaRif: "J-50123456-0", titular: "CEIUM, C.A." }, instructions: "Haz el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante.", amountLabel: "Bs. 33.564,60 ($180.00 a Bs. 186,47 por USD)" };
  const pay: T.PaymentView = { methodLabel: "Pago móvil", amountLabel: "Bs. 33.564,60 (≈ $180.00)", reference: "004512873301", date: new Date() };
  const sessions = Array.isArray(cohort.sessions) ? (cohort.sessions as { date: string; title?: string; startTime?: string; endTime?: string }[]) : [];

  const all: [string, string, T.RenderedEmail][] = [
    ["order_confirmation-pagado", "Compra confirmada (PayPal)", T.orderConfirmation(paidView, { paid: true })],
    ["order_confirmation-manual", "Pedido recibido con datos de pago", T.orderConfirmation(pendingView, { paid: false, manual: bank })],
    ["payment_under_verification", "Pago en verificación", T.paymentUnderVerification({ ...pendingView, paymentMethodLabel: "Pago móvil" }, pay)],
    ["payment_approved", "Pago aprobado (plan mitad)", T.paymentApproved(halfView, pay)],
    ["payment_rejected", "Pago rechazado", T.paymentRejected(pendingView, pay, "La referencia no aparece en el estado de cuenta del banco.", false)],
    ["platform_access-nueva", "Acceso al aula (cuenta nueva)", T.platformAccess({ firstName: "María", username: "maria.perez@example.com", loginUrl: d.config.moodleLoginUrl, tempPassword: "Ceium#48213", courses: [course.title] })],
    ["platform_access-existente", "Acceso al aula (cuenta existente)", T.platformAccess({ firstName: "María", username: "maria.perez@example.com", loginUrl: d.config.moodleLoginUrl, courses: monthlyCourses.slice(0, 2) })],
    ["cohort_details", "Datos de la cohorte", T.cohortDetails({ firstName: "María", productTitle: course.title, cohortName: cohort.name, sedeName: cohort.sede.name, sedeAddress: cohort.sede.address, startDate: cohort.startDate, endDate: cohort.endDate, sessions, notes: cohort.notes, orderNumber: 1042 })],
    ["certificate_issued", "Certificado emitido", T.certificateIssued({ firstName: "María", fullName: "María José Pérez Rodríguez", diplomaTitle: diploma.title, code: "CEIUM-7K2QX-M9D4P", verifyUrl: `${app}/certificados/CEIUM-7K2QX-M9D4P`, issuedAt: new Date() })],
    ["refund_issued", "Reembolso", T.refundIssued(paidView, { amountCents: paidView.amountPaidCents, methodLabel: "PayPal", reason: "Solicitud del médico antes del inicio", full: true })],
    ["installment_reminder", "Recordatorio de cuota (mes a mes)", T.installmentReminder({ firstName: "María", orderNumber: 1042, sequence: 3, totalInstallments: monthlyCourses.length, programTitle: diploma.title, courseTitle: monthlyCourses[2] ?? null, amountCents: 18000, dueDate: new Date(Date.now() + 3 * 86400_000), overdue: false, balanceCents: monthlyView.balanceCents, paypalUrl: `${app}/pedido/ejemplo/cuota/x/paypal`, manualUrl: `${app}/pedido/ejemplo?cuota=x#pagar`, manualLabel: "Pago móvil o Transferencia bancaria", statusUrl: `${app}/pedido/ejemplo` })],
    ["installment_reminder-vencida", "Cuota vencida", T.installmentReminder({ firstName: "María", orderNumber: 1042, sequence: 3, totalInstallments: monthlyCourses.length, programTitle: diploma.title, courseTitle: monthlyCourses[2] ?? null, amountCents: 18000, dueDate: new Date(Date.now() - 2 * 86400_000), overdue: true, balanceCents: monthlyView.balanceCents, paypalUrl: null, manualUrl: `${app}/pedido/ejemplo?cuota=x#pagar`, manualLabel: "Pago móvil", statusUrl: `${app}/pedido/ejemplo` })],
    ["payment_approved-mes-a-mes", "Pago aprobado (mes a mes, con cuotas)", T.paymentApproved(monthlyView, { methodLabel: "PayPal", amountLabel: "$180.00" })],
  ];
  const links: string[] = [];
  for (const [file, label, e] of all) {
    fs.writeFileSync(path.join(out, `${file}.html`), e.html);
    links.push(`<li><a href="${file}.html">${T.esc(label)}</a> — <code>${T.esc(e.subject)}</code></li>`);
  }
  fs.writeFileSync(path.join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Correos CEIUM</title><body style="font-family:system-ui;max-width:760px;margin:40px auto;line-height:1.6"><h1>Correos al médico</h1><ul>${links.join("")}</ul></body>`);
  console.log(`${all.length} correos → ${out}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
