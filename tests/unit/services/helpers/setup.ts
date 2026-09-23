// Contexto de test: BD aislada + catálogo mínimo + fakes + reloj controlable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Deps } from "@/server/deps";
import { createOutboxMailer, type Mailer } from "@/server/email/mailer";
import { SETTING_KEYS } from "@/server/settings";
import { priceScopeKey } from "@/server/pricing";
import { createTestDb } from "./testdb";
import { FakeMoodle, FakePaypal } from "./fakes";

export const T0 = new Date("2026-09-01T12:00:00Z");

export class Clock {
  constructor(public t: Date = T0) {}
  now = () => new Date(this.t.getTime());
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export interface Fixture {
  sedes: { bqto: string; ccs: string; mcbo: string };
  course: string; // COURSE, moodle 201, online + semipresencial
  courseCohort: string; // Barquisimeto, capacidad 3
  diploma: string; // DIPLOMA con 9 cursos (moodle 301..309)
  diplomaCourses: string[];
  diplomaMoodleIds: number[];
  diplomaCohort: string; // Barquisimeto, capacidad 20
  adminId: string;
}

export async function seedFixture(db: PrismaClient): Promise<Fixture> {
  const bqto = await db.sede.create({ data: { slug: "barquisimeto", name: "Barquisimeto", address: "Av. Andrés Bello, Policlínica San Javier, Piso 1" } });
  const ccs = await db.sede.create({ data: { slug: "caracas", name: "Caracas", address: "Centro Plaza, Torre A, piso 16" } });
  const mcbo = await db.sede.create({ data: { slug: "maracaibo", name: "Maracaibo", address: "Av. Universidad, Unimedica" } });

  const course = await db.product.create({ data: { type: "COURSE", category: "UNIVERSITY_COURSE", slug: "ecografia-abdominal", title: "Curso de Ecografía Abdominal", moodleCourseId: 201 } });
  await db.priceEntry.createMany({
    data: [
      { scopeKey: priceScopeKey({ modality: "ONLINE", sedeId: null }), productId: course.id, modality: "ONLINE", sedeId: null, priceCents: 10000 },
      { scopeKey: priceScopeKey({ modality: "SEMIPRESENCIAL", sedeId: bqto.id }), productId: course.id, modality: "SEMIPRESENCIAL", sedeId: bqto.id, priceCents: 18000 },
      { scopeKey: priceScopeKey({ modality: "SEMIPRESENCIAL", sedeId: ccs.id }), productId: course.id, modality: "SEMIPRESENCIAL", sedeId: ccs.id, priceCents: 20000 },
    ],
  });
  await db.paymentPlan.createMany({
    data: [
      { productId: course.id, kind: "FULL", label: "Paga todo el curso", discountPct: 0, installments: 1, position: 0 },
      { productId: course.id, kind: "HALF", label: "Paga la mitad", discountPct: 0, installments: 2, position: 1 },
    ],
  });
  const courseCohort = await db.cohort.create({
    data: { productId: course.id, sedeId: bqto.id, name: "Cohorte Octubre 2026", startDate: new Date("2026-10-03T12:00:00Z"), endDate: new Date("2026-10-31T12:00:00Z"), capacity: 3, sessions: [{ date: "2026-10-03", title: "Práctica 1", startTime: "08:00", endTime: "13:00" }] },
  });

  const diploma = await db.product.create({ data: { type: "DIPLOMA", category: "DIPLOMA", slug: "diplomado-ecografia-integral", title: "Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico", endorsementTitle: "Avalado por la UCLA" } });
  const diplomaCourses: string[] = [];
  const diplomaMoodleIds: number[] = [];
  for (let i = 1; i <= 9; i++) {
    const c = await db.product.create({ data: { type: "COURSE", category: "UNIVERSITY_COURSE", slug: `dip-curso-${i}`, title: `Curso ${i} del Diplomado`, moodleCourseId: 300 + i } });
    await db.diplomaCourse.create({ data: { diplomaId: diploma.id, courseId: c.id, position: i } });
    diplomaCourses.push(c.id);
    diplomaMoodleIds.push(300 + i);
  }
  await db.priceEntry.createMany({
    data: [
      { scopeKey: priceScopeKey({ modality: "ONLINE", sedeId: null }), productId: diploma.id, modality: "ONLINE", sedeId: null, priceCents: 100000, installmentCents: 12500 },
      { scopeKey: priceScopeKey({ modality: "SEMIPRESENCIAL", sedeId: bqto.id }), productId: diploma.id, modality: "SEMIPRESENCIAL", sedeId: bqto.id, priceCents: 142000, installmentCents: 18000 },
    ],
  });
  await db.paymentPlan.createMany({
    data: [
      { productId: diploma.id, kind: "FULL", label: "Paga todo el diplomado (10% de descuento)", discountPct: 10, installments: 1, position: 0 },
      { productId: diploma.id, kind: "HALF", label: "Paga la midad (5% de descuento)", discountPct: 5, installments: 2, position: 1 },
      { productId: diploma.id, kind: "MONTHLY", label: "Paga mes a mes", discountPct: 0, installments: 9, position: 2 },
    ],
  });
  const diplomaCohort = await db.cohort.create({
    data: { productId: diploma.id, sedeId: bqto.id, name: "Cohorte II - 2026", startDate: new Date("2026-10-03T12:00:00Z"), endDate: new Date("2027-06-30T12:00:00Z"), capacity: 20 },
  });

  const admin = await db.adminUser.create({ data: { email: "admin@ceium.net", name: "Admin", role: "ADMIN", passwordHash: "x" } });

  const settings: [string, unknown][] = [
    [SETTING_KEYS.reservationTtlPaypal, { minutes: 30 }],
    [SETTING_KEYS.reservationTtlManual, { hours: 72 }],
    [
      SETTING_KEYS.manualMethods,
      [
        { method: "PAGO_MOVIL", enabled: true, label: "Pago móvil", currency: "VES", details: { banco: "Banesco (0134)", telefono: "0414-0000000", cedulaRif: "J-000000000", titular: "CEIUM" }, instructions: "Realiza el pago móvil y registra la referencia." },
        { method: "TRANSFERENCIA", enabled: true, label: "Transferencia bancaria", currency: "VES", details: { banco: "Banesco" }, instructions: "Transfiere y registra la referencia." },
        { method: "ZELLE", enabled: false, label: "Zelle", currency: "USD", details: {}, instructions: "" },
      ],
    ],
    [SETTING_KEYS.paypal, { enabled: true }],
    [SETTING_KEYS.exchangeRate, { vesPerUsd: 100 }],
    [SETTING_KEYS.orderNextNumber, { next: 1001 }],
    [SETTING_KEYS.enrollmentRetry, { maxAttempts: 3, baseDelaySeconds: 60 }],
  ];
  for (const [key, value] of settings) await db.setting.create({ data: { key, value: value as never } });

  return { sedes: { bqto: bqto.id, ccs: ccs.id, mcbo: mcbo.id }, course: course.id, courseCohort: courseCohort.id, diploma: diploma.id, diplomaCourses, diplomaMoodleIds, diplomaCohort: diplomaCohort.id, adminId: admin.id };
}

export interface TestContext {
  d: Deps;
  db: PrismaClient;
  fx: Fixture;
  moodle: FakeMoodle;
  paypal: FakePaypal;
  clock: Clock;
  mailDir: string;
  certDir: string;
  logs: string[];
  extraClient: () => PrismaClient;
  url: string;
  dispose: () => Promise<void>;
  makeDeps: (db: PrismaClient) => Deps;
}

export async function setupContext(name: string, opts: { mailer?: Mailer } = {}): Promise<TestContext> {
  const tdb = await createTestDb(name);
  const fx = await seedFixture(tdb.db);
  const moodle = new FakeMoodle();
  const paypal = new FakePaypal();
  const clock = new Clock();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ceium-${name}-`));
  const mailDir = path.join(tmp, "mail");
  const certDir = path.join(tmp, "certificates");
  const logs: string[] = [];
  const mailer = opts.mailer ?? createOutboxMailer(mailDir);
  const makeDeps = (db: PrismaClient): Deps => ({
    db,
    moodle,
    paypal,
    mailer,
    now: clock.now,
    sleep: async () => {},
    log: { info: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push(a.join(" ")), error: (...a: unknown[]) => logs.push(a.map(String).join(" ")) },
    config: {
      appUrl: "https://ceium.test",
      moodleLoginUrl: "https://aula.ceium.test/login/index.php",
      mailFrom: "CEIUM <no-reply@ceium.net>",
      certificatesDir: certDir,
      privateFilesDir: path.join(tmp, "files"),
      enrollInlineRetries: 1,
      enrollInlineDelayMs: 0,
    },
  });
  const d = makeDeps(tdb.db);
  return {
    d,
    db: tdb.db,
    fx,
    moodle,
    paypal,
    clock,
    mailDir,
    certDir,
    logs,
    extraClient: tdb.extraClient,
    url: tdb.url,
    makeDeps,
    dispose: async () => {
      await tdb.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let seq = 0;
export function buyer(n?: number) {
  const i = n ?? ++seq;
  return { email: `Medico${i}@Example.com`, firstName: `María${i}`, lastName: "Pérez", cedula: `V-${10000000 + i}`, phone: "0414-1234567" };
}
