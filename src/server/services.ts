// Punto de entrada de los servicios de dominio para la app (rutas, server actions, scripts).
//   import { services } from "@/server/services";
//   await services().orders.createCheckout({...});
// Los tests NO usan este módulo: construyen Deps con fakes (ver tests/unit/services/helpers).
import { getMoodleClient } from "@/server/moodle";
import { getPayPal } from "@/server/paypal";
import { moodlePort, paypalPort } from "@/server/adapters";
import { prisma } from "@/server/db";
import { configFromEnv, type Deps } from "@/server/deps";
import { mailerFromEnv } from "@/server/email/mailer";
import * as quoteSvc from "@/server/quote";
import * as seats from "@/server/seats";
import * as orders from "@/server/orders";
import * as payments from "@/server/payments";
import * as enrollment from "@/server/enrollment";
import * as certificates from "@/server/certificates";
import * as email from "@/server/email";
import * as jobs from "@/server/jobs";
import * as installments from "@/server/installments";
import * as corrections from "@/server/corrections";
import * as cohorts from "@/server/cohorts";
import * as catalog from "@/server/catalog";
import * as adminSettings from "@/server/admin-settings";
import * as adminUsers from "@/server/admin-users";
import * as audit from "@/server/audit";

export function createDefaultDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    db: prisma,
    // Perezosos: el cliente se construye (y valida MOODLE_TOKEN / credenciales PayPal) en la primera llamada,
    // no al crear los servicios. Sin Moodle configurado, las páginas que solo leen pedidos siguen funcionando;
    // la matrícula falla de forma controlada (queda para reintento) en vez de tumbar toda la app con un 500.
    moodle: moodlePort(getMoodleClient),
    paypal: paypalPort(getPayPal),
    mailer: mailerFromEnv(),
    config: configFromEnv(),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: console,
    ...overrides,
  };
}

type Bound<M> = {
  [K in keyof M]: M[K] extends (d: Deps, ...args: infer A) => infer R ? (...args: A) => R : never;
};

function bind<M extends Record<string, unknown>>(d: Deps, mod: M, names: (keyof M)[]): Bound<Pick<M, (typeof names)[number]>> {
  const out: Record<string, unknown> = {};
  for (const n of names) out[n as string] = (...args: unknown[]) => (mod[n] as (...a: unknown[]) => unknown)(d, ...args);
  return out as Bound<Pick<M, (typeof names)[number]>>;
}

export function createServices(d: Deps) {
  return {
    deps: d,
    pricing: { quote: (input: quoteSvc.QuoteInput) => quoteSvc.quote(d.db, input, d.now()) },
    seats: {
      ...bind(d, seats, ["expireStaleReservations", "getCohortAvailability"]),
    },
    orders: {
      ...bind(d, orders, ["createCheckout", "getOrder", "getOrderByToken", "expireStaleOrders", "cancelOrder", "addNote", "notifyOrderReceived"]),
      ...bind(d, corrections, ["adjustBalance", "adjustBalanceDetailed", "waiveInstallment", "reassignCohort"]),
    },
    corrections: bind(d, corrections, ["adjustBalance", "adjustBalanceDetailed", "waiveInstallment", "reassignCohort"]),
    payments: bind(d, payments, [
      "recordManualPayment",
      "storeProofFile",
      "adminVerifyPayment",
      "startPaypalPayment",
      "capturePaypalReturn",
      "onPaypalCaptureCompleted",
      "onPaypalCaptureDenied",
      "handlePaypalWebhook",
      "refundPayment",
      "onPaypalRefundCompleted",
      "syncPaypalOrder",
      "reconcilePaypalPayments",
    ]),
    enrollment: bind(d, enrollment, ["enrollOrder", "reenrollOrder", "unenrollOrder", "retryDueEnrollments", "resendCohortDetails"]),
    installments: bind(d, installments, ["runInstallmentReminders", "markOverdueInstallments", "sendInstallmentReminder"]),
    certificates: bind(d, certificates, ["checkDiplomaCompletion", "deliverCertificate", "verifyCertificate", "revokeCertificate", "runCertificateSweep"]),
    email: bind(d, email, ["sendEmail", "retryFailedEmails", "resendEmail"]),
    jobs: bind(d, jobs, ["runJobs"]),
    // Panel: toda escritura de catálogo/cohortes/configuración/usuarios pasa por aquí (valida + AuditLog).
    cohorts: bind(d, cohorts, ["createCohort", "updateCohort", "setCohortStatus", "deleteCohort"]),
    catalog: bind(d, catalog, ["updateProduct", "upsertPrice", "setPriceActive", "upsertPlan", "upsertCollection", "upsertSede", "setDiplomaCourses"]),
    settings: bind(d, adminSettings, ["updateSetting"]),
    adminUsers: bind(d, adminUsers, ["createAdminUser", "updateAdminUser", "resetAdminPassword"]),
    audit: { list: (q: audit.AuditQuery = {}) => audit.listAuditLog(d, q) },
  };
}

export type Services = ReturnType<typeof createServices>;

const g = globalThis as unknown as { __ceiumServices?: Services };
export function services(): Services {
  return (g.__ceiumServices ??= createServices(createDefaultDeps()));
}
