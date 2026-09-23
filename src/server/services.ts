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

export function createDefaultDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    db: prisma,
    moodle: moodlePort(getMoodleClient()),
    paypal: paypalPort(getPayPal()),
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
    orders: bind(d, orders, ["createCheckout", "getOrder", "getOrderByToken", "expireStaleOrders", "cancelOrder", "adjustBalance", "reassignCohort", "addNote", "notifyOrderReceived"]),
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
    certificates: bind(d, certificates, ["checkDiplomaCompletion", "deliverCertificate", "verifyCertificate", "revokeCertificate", "runCertificateSweep"]),
    email: bind(d, email, ["sendEmail", "retryFailedEmails", "resendEmail"]),
    jobs: bind(d, jobs, ["runJobs"]),
  };
}

export type Services = ReturnType<typeof createServices>;

const g = globalThis as unknown as { __ceiumServices?: Services };
export function services(): Services {
  return (g.__ceiumServices ??= createServices(createDefaultDeps()));
}
