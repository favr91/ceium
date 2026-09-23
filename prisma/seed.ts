// Seed: importa el catálogo REAL de ceium.net desde ../ref (products.json, coll__*.json)
// + fichas extraídas (prisma/seed-data/product-details.json) + sedes, planes, cohortes de ejemplo,
// admin y settings. Idempotente: BORRA y recrea todo (solo para dev/test).
//   npm run db:seed
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import "dotenv/config";
import { createPrismaClient } from "../src/server/db";
import type { Modality, PlanKind, ProductCategory, Prisma } from "../src/generated/prisma/client";
import { computePlanAmounts, priceScopeKey } from "../src/server/pricing";
import { SETTING_KEYS, type ManualMethodConfig } from "../src/server/settings";

const prisma = createPrismaClient();
const REF = process.env.CEIUM_REF_DIR ?? path.resolve(__dirname, "../../ref");
const DETAILS = JSON.parse(fs.readFileSync(path.join(__dirname, "seed-data/product-details.json"), "utf8")).products as Record<string, Details>;

// ───────────── Tipos del JSON de Shopify ─────────────
interface ShopifyVariant { option1: string | null; option2: string | null; option3: string | null; price: string; compare_at_price: string | null; available: boolean }
interface ShopifyProduct {
  id: number; title: string; handle: string; body_html: string; published_at: string | null;
  variants: ShopifyVariant[]; images: { src: string; width: number; height: number; position: number; alt?: string | null }[];
  options: { name: string; position: number; values: string[] }[];
}
interface Details {
  intro?: string[]; belongsTo?: string; enrollmentNote?: string; eventDateText?: string; enrollmentDeadlineText?: string;
  requirements?: string; certificateTitle?: string; certificateText?: string; endorsementTitle?: string; endorsementText?: string;
  audience?: string; duration?: string; benefits?: string[]; topics?: { title: string; items: string[] }[]; faculty?: string[];
  diplomaCourses?: { n: number; title: string; highlights: string[] }[]; syllabusUrl?: string; scheduleUrls?: string[]; source?: string;
}

const readJson = <T,>(f: string): T => JSON.parse(fs.readFileSync(path.join(REF, f), "utf8"));
const cents = (s: string) => Math.round(parseFloat(s) * 100);

// Títulos reales de las colecciones (<title> de ceium.net/collections/<slug>).
const COLLECTIONS: { slug: string; title: string }[] = [
  { slug: "diplomados", title: "Diplomados" },
  { slug: "cursos-universitarios", title: "Cursos Universitarios Fundamentales" },
  { slug: "cursos-avanzados", title: "Cursos Avanzados" },
  { slug: "talleres-especializados", title: "Talleres Especializados" },
  { slug: "cursos-y-talleres-de-marzo-a-junio-2026", title: "Cursos y talleres que inician de Marzo a Junio de 2026" },
  { slug: "cursos-del-diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico", title: "Cursos del Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico" },
  { slug: "cursos-del-diplomado-universitario-avanzado-de-medicina-materno-fetal", title: "Cursos del Diplomado Universitario Avanzado de Medicina Materno Fetal" },
];

const SEDES = [
  { slug: "barquisimeto", name: "Barquisimeto", city: "Barquisimeto, Lara", address: "Av. Andrés Bello entre carreras 33 y 34, Edificio Policlínica San Javier y Centro Profesional Arca. Piso 1 Barquisimeto, Edo Lara, Venezuela." },
  { slug: "caracas", name: "Caracas", city: "Caracas", address: "Centro Plaza entre la avenida Francisco de Miranda y 1era Transversal de Los Palos Grandes municipio Chacao, Torre A, piso 16, oficina D, Caracas." },
  { slug: "maracaibo", name: "Maracaibo", city: "Maracaibo, Zulia", address: "Av. Universidad entre Av. 10 y 12, Urb. La Estrella Unimedica." },
];

// Hash determinista → capacidades/fechas estables entre ejecuciones.
function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const d = (iso: string) => new Date(iso + "T00:00:00-04:00"); // hora de Venezuela
const addDays = (dt: Date, n: number) => new Date(dt.getTime() + n * 86400000);
const isoDate = (dt: Date) => dt.toISOString().slice(0, 10);

function planKindFromLabel(label: string): { kind: PlanKind; discountPct: number } {
  const pct = Number(label.match(/(\d+)\s*%/)?.[1] ?? 0);
  if (/mes a mes/i.test(label)) return { kind: "MONTHLY", discountPct: 0 };
  if (/mitad|midad/i.test(label)) return { kind: "HALF", discountPct: pct };
  return { kind: "FULL", discountPct: pct };
}

async function wipe() {
  // Orden inverso de dependencias.
  await prisma.$transaction(async (tx) => {
    await tx.orderEvent.deleteMany();
    await tx.emailOutbox.deleteMany();
    await tx.certificate.deleteMany();
    await tx.enrollment.deleteMany();
    await tx.refund.deleteMany();
    await tx.payment.deleteMany();
    await tx.installment.deleteMany();
    await tx.balanceAdjustment.deleteMany();
    await tx.seatReservation.deleteMany();
    await tx.orderItem.deleteMany();
    await tx.order.deleteMany();
    await tx.customer.deleteMany();
    await tx.webhookEvent.deleteMany();
    await tx.cohort.deleteMany();
    await tx.paymentPlan.deleteMany();
    await tx.priceEntry.deleteMany();
    await tx.productChoice.deleteMany();
    await tx.collectionProduct.deleteMany();
    await tx.collection.deleteMany();
    await tx.diplomaCourse.deleteMany();
    await tx.productImage.deleteMany();
    await tx.product.deleteMany();
    await tx.sede.deleteMany();
    await tx.adminSession.deleteMany();
    await tx.adminUser.deleteMany();
    await tx.setting.deleteMany();
  });
}

async function main() {
  const { products } = readJson<{ products: ShopifyProduct[] }>("products.json");
  const colls = Object.fromEntries(COLLECTIONS.map((c) => [c.slug, readJson<{ products: { handle: string }[] }>(`coll__${c.slug}.json`).products.map((p) => p.handle)]));

  await wipe();

  // Sedes
  const sedeBySlug: Record<string, string> = {};
  for (const [i, s] of SEDES.entries()) {
    const row = await prisma.sede.create({ data: { ...s, position: i } });
    sedeBySlug[s.slug] = row.id;
  }
  const sedeIdByName = (name: string) => sedeBySlug[name.toLowerCase()];

  // Productos
  const categoryOf = (h: string): ProductCategory =>
    colls["diplomados"].includes(h) ? "DIPLOMA" : colls["talleres-especializados"].includes(h) ? "WORKSHOP"
      : colls["cursos-avanzados"].includes(h) ? "ADVANCED_COURSE" : "UNIVERSITY_COURSE";

  const productId: Record<string, string> = {};
  let moodleId = 101;
  // Cursos de Moodle de las sub-opciones (p.ej. niveles del taller transfontanelar): después de los cursos.
  let choiceMoodleId = moodleId + products.filter((p) => categoryOf(p.handle) !== "DIPLOMA").length;
  const warnings: string[] = [];
  let priceCount = 0, planCount = 0;

  for (const [pos, p] of products.entries()) {
    const category = categoryOf(p.handle);
    const type = category === "DIPLOMA" ? "DIPLOMA" : "COURSE";
    const det = DETAILS[p.handle] ?? {};
    const optIdx = (name: string) => p.options.findIndex((o) => o.name === name);
    const iMod = optIdx("Modalidad"), iSede = optIdx("Sede"), iPay = optIdx("Forma de pago"), iChoice = optIdx("Cursos disponibles");
    const val = (v: ShopifyVariant, i: number) => (i < 0 ? null : (v[`option${i + 1}` as "option1"] as string | null));
    const modalities = new Set(p.variants.map((v) => val(v, iMod)));
    const deadline = det.enrollmentDeadlineText?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    const product = await prisma.product.create({
      data: {
        type, category, slug: p.handle, title: p.title, descriptionHtml: p.body_html ?? "",
        excerpt: det.intro?.join(" ") || null,
        offersOnline: modalities.has("Online"), offersSemipresencial: modalities.has("Semipresencial"),
        requirements: det.requirements, certificateTitle: det.certificateTitle, certificateText: det.certificateText,
        endorsementTitle: det.endorsementTitle, endorsementText: det.endorsementText, audience: det.audience, duration: det.duration,
        eventDateText: det.eventDateText, enrollmentNote: det.enrollmentNote,
        enrollmentDeadline: deadline ? d(`${deadline[3]}-${deadline[2]}-${deadline[1]}`) : null,
        syllabusUrl: det.syllabusUrl, topics: (det.topics as Prisma.InputJsonValue) ?? undefined,
        faculty: det.faculty ?? undefined, benefits: det.benefits ?? undefined, detailsSource: det.source ? `ceium.net (${det.source})` : null,
        moodleCourseId: type === "COURSE" ? moodleId++ : null,
        published: true, publishedAt: p.published_at ? new Date(p.published_at) : null, position: pos, legacyShopifyId: String(p.id),
        images: { create: p.images.map((im) => ({ url: im.src, alt: im.alt ?? p.title, width: im.width, height: im.height, position: im.position })) },
      },
    });
    productId[p.handle] = product.id;

    // Sub-opciones ("Cursos disponibles")
    const choiceId: Record<string, string> = {};
    if (iChoice >= 0) {
      // Cada opción otorga su propio curso de Moodle ("Nivel 1", "Nivel 2"); "Todo el taller" otorga todos.
      const labels = p.options[iChoice].values;
      const own = new Map<string, number>();
      for (const label of labels) if (!/^todo/i.test(label)) own.set(label, choiceMoodleId++);
      for (const [ci, label] of labels.entries()) {
        const ids = own.has(label) ? [own.get(label)!] : [...own.values()];
        const c = await prisma.productChoice.create({ data: { productId: product.id, groupName: "Cursos disponibles", label, position: ci, moodleCourseIds: ids } });
        choiceId[label] = c.id;
      }
    }

    // Planes de pago (etiquetas reales)
    const planLabels = iPay >= 0 ? p.options[iPay].values : [];
    const plans = planLabels.length ? planLabels.map((label) => ({ label, ...planKindFromLabel(label) })) : [{ label: "Pago único", kind: "FULL" as PlanKind, discountPct: 0 }];
    // MONTHLY (solo diplomados, SPEC): una cuota por curso del diplomado (9), cada una al precio publicado
    // de la variante "Paga mes a mes" (180/230/150). quote() usa siempre el nº real de cursos; este valor
    // queda como referencia visible en el panel.
    const MONTHLY_INSTALLMENTS = (colls[`cursos-del-${p.handle}`] ?? []).length;
    for (const [pi, pl] of plans.entries()) {
      await prisma.paymentPlan.create({
        data: { productId: product.id, kind: pl.kind, label: pl.label, discountPct: pl.discountPct, position: pi,
          installments: pl.kind === "FULL" ? 1 : pl.kind === "HALF" ? 2 : MONTHLY_INSTALLMENTS },
      });
      planCount++;
    }

    // Matriz de precios: agrupa variantes por (modalidad, sede, choice) y deriva el precio de lista.
    const groups = new Map<string, { modality: Modality; sedeId: string | null; choiceId: string | null; vs: ShopifyVariant[] }>();
    for (const v of p.variants) {
      const mod = val(v, iMod) === "Online" ? "ONLINE" : "SEMIPRESENCIAL";
      const sedeName = val(v, iSede);
      if (mod === "SEMIPRESENCIAL" && (!sedeName || sedeName === "Online")) { warnings.push(`${p.handle}: variante Semipresencial/${sedeName} ignorada`); continue; }
      const sedeId = mod === "ONLINE" ? null : sedeIdByName(sedeName!);
      const ch = iChoice >= 0 ? choiceId[val(v, iChoice)!] : null;
      const key = `${mod}|${sedeId}|${ch}`;
      if (!groups.has(key)) groups.set(key, { modality: mod, sedeId, choiceId: ch, vs: [] });
      groups.get(key)!.vs.push(v);
    }
    for (const g of groups.values()) {
      let list: number | null = null, installment: number | null = null;
      if (iPay < 0) list = cents(g.vs[0].price);
      for (const v of iPay >= 0 ? g.vs : []) {
        const { kind } = planKindFromLabel(val(v, iPay)!);
        if (kind === "MONTHLY") installment = cents(v.price);
        else if (kind === "FULL") list ??= v.compare_at_price ? cents(v.compare_at_price) : cents(v.price);
        else if (kind === "HALF" && list == null) list = v.compare_at_price ? cents(v.compare_at_price) * 2 : cents(v.price) * 2;
      }
      if (list == null) { warnings.push(`${p.handle}: sin precio de lista`); continue; }
      // ONLINE aparece repetido por sede en algunos talleres (Sede=Barquisimeto): una sola fila ONLINE.
      const scopeKey = priceScopeKey(g);
      const exists = await prisma.priceEntry.findUnique({ where: { productId_scopeKey: { productId: product.id, scopeKey } } });
      if (exists) continue;
      await prisma.priceEntry.create({ data: { productId: product.id, scopeKey, modality: g.modality, sedeId: g.sedeId, choiceId: g.choiceId, priceCents: list, installmentCents: installment } });
      priceCount++;
      // Verificación: los montos calculados deben reproducir el precio real de cada variante.
      for (const v of iPay >= 0 ? g.vs : []) {
        const pl = plans.find((x) => x.label === val(v, iPay))!;
        const amounts = computePlanAmounts({ priceCents: list, installmentCents: installment }, { ...pl, installments: pl.kind === "HALF" ? 2 : pl.kind === "MONTHLY" ? MONTHLY_INSTALLMENTS : 1 });
        if (pl.kind === "MONTHLY" && MONTHLY_INSTALLMENTS < 2) warnings.push(`${p.handle}: plan mes a mes sin cursos de diplomado`);
        if (amounts.dueNowCents !== cents(v.price)) warnings.push(`${p.handle} ${g.modality}/${g.sedeId ? "sede" : "-"} ${pl.label}: calculado ${amounts.dueNowCents} ≠ real ${cents(v.price)}`);
      }
    }
  }

  // Colecciones
  for (const [ci, c] of COLLECTIONS.entries()) {
    const diplomaSlug = c.slug.startsWith("cursos-del-diplomado-") ? c.slug.replace("cursos-del-", "") : null;
    await prisma.collection.create({
      data: {
        slug: c.slug, title: c.title, position: ci, diplomaId: diplomaSlug ? productId[diplomaSlug] : null,
        products: { create: colls[c.slug].filter((h) => productId[h]).map((h, i) => ({ productId: productId[h], position: i })) },
      },
    });
  }

  // Diplomado → cursos (orden de la colección "cursos-del-diplomado-*"; viñetas de la página real)
  for (const diplomaSlug of colls["diplomados"]) {
    const courses = colls[`cursos-del-${diplomaSlug}`] ?? [];
    const hl = DETAILS[diplomaSlug]?.diplomaCourses ?? [];
    for (const [i, h] of courses.entries()) {
      await prisma.diplomaCourse.create({ data: { diplomaId: productId[diplomaSlug], courseId: productId[h], position: i, highlights: hl[i]?.highlights ?? undefined } });
    }
  }

  // Cohortes de EJEMPLO (isSample) — solo semipresencial, por producto × sede con precio.
  const semi = await prisma.priceEntry.findMany({ where: { modality: "SEMIPRESENCIAL", sedeId: { not: null } }, include: { product: true, sede: true }, distinct: ["productId", "sedeId"] });
  let cohortCount = 0;
  for (const pe of semi) {
    const prod = pe.product, sede = pe.sede!;
    const cap = (k: string) => 20 + (hash(k) % 11); // 20..30
    const specs: { name: string; start: Date; end: Date; status: "OPEN" | "IN_PROGRESS"; scheduleUrl?: string; sessions: { date: string; title: string; courseSlug?: string }[] }[] = [];
    if (prod.type === "DIPLOMA") {
      const courses = await prisma.diplomaCourse.findMany({ where: { diplomaId: prod.id }, include: { course: true }, orderBy: { position: "asc" } });
      const urls = DETAILS[prod.slug]?.scheduleUrls ?? [];
      for (const [k, [name, startIso, status]] of ([["Cohorte I - 2026", "2026-03-07", "IN_PROGRESS"], ["Cohorte II - 2026", "2026-10-03", "OPEN"]] as const).entries()) {
        const start = d(startIso);
        const sessions = courses.map((c, i) => ({ date: isoDate(addDays(start, i * 28)), title: c.course.title, courseSlug: c.course.slug }));
        specs.push({ name, start, end: addDays(start, courses.length * 28 - 1), status, scheduleUrl: urls[k], sessions });
      }
    } else if (prod.category === "WORKSHOP") {
      const off = hash(prod.slug) % 4;
      const start = addDays(d("2026-11-06"), off * 7);
      specs.push({ name: "Edición Noviembre 2026", start, end: addDays(start, 1), status: "OPEN", sessions: [0, 1].map((i) => ({ date: isoDate(addDays(start, i)), title: `Día ${i + 1} de práctica` })) });
    } else {
      // Cursos: 2 cohortes mensuales (4 sábados) entre oct y dic 2026.
      const off = hash(prod.slug + sede.slug) % 3;
      for (const [name, base] of [["Cohorte Octubre 2026", "2026-10-03"], ["Cohorte Noviembre 2026", "2026-11-07"]] as const) {
        const start = addDays(d(base), off * 7);
        specs.push({ name, start, end: addDays(start, 27), status: "OPEN", sessions: [0, 1, 2, 3].map((i) => ({ date: isoDate(addDays(start, i * 7)), title: `Sesión práctica ${i + 1}` })) });
      }
    }
    for (const s of specs) {
      await prisma.cohort.create({
        data: { productId: prod.id, sedeId: sede.id, name: s.name, startDate: s.start, endDate: s.end, enrollmentDeadline: addDays(s.start, -1),
          capacity: cap(prod.slug + sede.slug + s.name), status: s.status, sessions: s.sessions, scheduleUrl: s.scheduleUrl, isSample: true,
          notes: "DATOS DE EJEMPLO generados por el seed — reemplazar por el cronograma real." },
      });
      cohortCount++;
    }
  }

  // Admin
  const adminPass = process.env.ADMIN_PASSWORD || "ceium-admin-2026";
  const staffPass = process.env.STAFF_PASSWORD || "ceium-staff-2026";
  await prisma.adminUser.create({ data: { email: "admin@ceium.net", name: "Administrador CEIUM", role: "ADMIN", passwordHash: await bcrypt.hash(adminPass, 10) } });
  await prisma.adminUser.create({ data: { email: "staff@ceium.net", name: "Personal CEIUM", role: "STAFF", passwordHash: await bcrypt.hash(staffPass, 10) } });

  // Settings
  const manual: ManualMethodConfig[] = [
    { method: "PAGO_MOVIL", enabled: true, label: "Pago móvil", currency: "VES",
      details: { banco: "TODO: banco (código)", telefono: "TODO: 04xx-xxxxxxx", cedulaRif: "TODO: V-/J-xxxxxxxx", titular: "TODO: titular" },
      instructions: "Realiza el pago móvil por el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
    { method: "TRANSFERENCIA", enabled: true, label: "Transferencia bancaria", currency: "VES",
      details: { banco: "TODO: banco", cuenta: "TODO: 0000-0000-00-0000000000", tipo: "TODO: corriente", cedulaRif: "TODO: J-xxxxxxxx", titular: "TODO: titular" },
      instructions: "Transfiere el monto en bolívares a la tasa indicada y registra el número de referencia y el comprobante." },
    { method: "ZELLE", enabled: false, label: "Zelle", currency: "USD", details: { correo: "TODO: correo Zelle", titular: "TODO: titular" }, instructions: "Envía el monto en USD y registra la confirmación." },
    { method: "EFECTIVO", enabled: false, label: "Efectivo en sede", currency: "USD", details: { lugar: "TODO: sede y horario" }, instructions: "Paga en efectivo en la sede; el personal registrará tu pago." },
  ];
  const settings: [string, unknown, string][] = [
    [SETTING_KEYS.reservationTtlPaypal, { minutes: 30 }, "Minutos que se reserva el cupo durante un pago con PayPal"],
    [SETTING_KEYS.reservationTtlManual, { hours: 72 }, "Horas que se reserva el cupo en pagos manuales hasta la verificación"],
    [SETTING_KEYS.manualMethods, manual, "Métodos de pago manual y datos mostrados al comprador (TODO: datos bancarios reales)"],
    [SETTING_KEYS.paypal, { enabled: true }, "Pago con PayPal habilitado"],
    [SETTING_KEYS.exchangeRate, { vesPerUsd: 100, source: "TODO: actualizar con la tasa oficial BCV", updatedAt: new Date().toISOString() }, "Tasa de cambio Bs/USD para pagos en bolívares"],
    [SETTING_KEYS.orderNextNumber, { next: 1001 }, "Siguiente número visible de orden"],
    [SETTING_KEYS.enrollmentRetry, { maxAttempts: 8, baseDelaySeconds: 60 }, "Reintentos con backoff exponencial de la matrícula en Moodle"],
    [SETTING_KEYS.installmentReminders, { daysBefore: 3, overdueGraceDays: 0, overdueEveryDays: 7, maxOverdueReminders: 3 }, "Recordatorios por correo de la siguiente cuota (días antes del vencimiento, gracia y frecuencia de recordatorios vencidos)"],
    [SETTING_KEYS.certificateJob, { intervalMinutes: 60 }, "Frecuencia del job que revisa finalización en Moodle y emite certificados"],
    [SETTING_KEYS.certificatePolicy, { requireFullPayment: true }, "El certificado del diplomado se emite solo con el saldo del pedido en 0 (además de completar todos los cursos en Moodle)"],
    [SETTING_KEYS.storeContact, { phones: ["+58 412-0840407", "+58 412-5250748"], emails: ["registroceium@gmail.com", "roacar@gmail.com"], whatsapp: "+584120840718", instagram: "https://instagram.com/ceiumoficial" }, "Datos de contacto (de ceium.net/pages/contacto)"],
    [SETTING_KEYS.sampleData, { cohortsAreSample: true, note: "Las cohortes (fechas, cupos, sesiones) son DATOS DE EJEMPLO del seed (Cohort.isSample = true). Reemplazar por los cronogramas reales." }, "Marca de datos de ejemplo"],
  ];
  for (const [key, value, description] of settings) await prisma.setting.create({ data: { key, value: value as Prisma.InputJsonValue, description } });

  const counts = {
    sedes: await prisma.sede.count(), products: await prisma.product.count(), courses: await prisma.product.count({ where: { type: "COURSE" } }),
    diplomas: await prisma.product.count({ where: { type: "DIPLOMA" } }), images: await prisma.productImage.count(), choices: await prisma.productChoice.count(),
    prices: priceCount, plans: planCount, collections: await prisma.collection.count(), collectionProducts: await prisma.collectionProduct.count(),
    diplomaCourses: await prisma.diplomaCourse.count(), cohorts: cohortCount, admins: await prisma.adminUser.count(), settings: await prisma.setting.count(),
  };
  console.log("Seed OK", counts);
  if (warnings.length) console.log("Avisos:\n  " + warnings.join("\n  "));
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
