// Utilidades del e2e de compra: datos de prueba vía servicios de dominio (scripts/e2e-fixture.ts), lectura de
// la BD de la app bajo prueba (solo lectura, para verificar), y control/inspección de los mocks de Moodle y PayPal.
import { execFileSync } from "node:child_process";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, type APIRequestContext } from "@playwright/test";
import { e2eEnv } from "../../../playwright.config";

const APP_DIR = path.resolve(__dirname, "../../..");
export const MOODLE = e2eEnv.MOODLE_URL;
export const PAYPAL = e2eEnv.PAYPAL_BASE_URL;
const DB_FILE = e2eEnv.DATABASE_URL.replace(/^file:/, "");

// ───────────── datos de prueba (mismos servicios que la tienda / el panel) ─────────────

export function fixture<T = Record<string, unknown>>(cmd: string, input: Record<string, unknown>): T {
  const out = execFileSync("npx", ["tsx", "scripts/e2e-fixture.ts", cmd, JSON.stringify(input)], {
    cwd: APP_DIR,
    env: { ...process.env, DATABASE_URL: e2eEnv.DATABASE_URL, APP_URL: e2eEnv.APP_URL, MAIL_DIR: e2eEnv.MAIL_DIR, NODE_ENV: "production" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  const line = out.split("\n").find((l) => l.startsWith("@@JSON "));
  if (!line) throw new Error(`e2e-fixture ${cmd} sin resultado:\n${out}`);
  return JSON.parse(line.slice(7)) as T;
}

export interface DiplomaCohort {
  productId: string;
  productTitle: string;
  sedeName: string;
  cohortId: string;
  cohortName: string;
  capacity: number;
  courses: { id: string; title: string; moodleCourseId: number }[];
}
export interface Checkout {
  orderId: string;
  token: string;
  number: number;
  totalCents: number;
  dueNowCents: number;
  installments: { id: string; sequence: number; amountCents: number; moodleCourseId: number | null }[];
}

export const uniqueEmail = (tag: string) => `medico.${tag}.${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.com`;

// ───────────── BD (solo lectura) ─────────────

export function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
export const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => q<T>(sql, ...params)[0];

export const order = (id: string) =>
  one<{ id: string; status: string; amountPaidCents: number; balanceCents: number; customerId: string; totalCents: number }>(`SELECT * FROM "Order" WHERE id = ?`, id);
export const cohort = (id: string) => one<{ capacity: number; seatsHeld: number; seatsConfirmed: number }>(`SELECT capacity, seatsHeld, seatsConfirmed FROM Cohort WHERE id = ?`, id);
export const customerOf = (orderId: string) =>
  one<{ id: string; email: string; moodleUserId: number | null; moodleUsername: string | null }>(`SELECT c.* FROM Customer c JOIN "Order" o ON o.customerId = c.id WHERE o.id = ?`, orderId);
export const emails = (orderId: string) =>
  q<{ template: string; status: string; subject: string; text: string; html: string; secretRef: string | null; dedupeKey: string | null; to: string }>(
    `SELECT template, status, subject, text, html, secretRef, dedupeKey, "to" FROM EmailOutbox WHERE orderId = ? ORDER BY createdAt, id`,
    orderId,
  );
export const events = (orderId: string, type?: string) =>
  q<{ type: string; actorType: string; note: string | null; data: string | null }>(
    `SELECT type, actorType, note, data FROM OrderEvent WHERE orderId = ? ${type ? "AND type = ?" : ""} ORDER BY createdAt, id`,
    ...(type ? [orderId, type] : [orderId]),
  );
export const payments = (orderId: string) =>
  q<{ id: string; status: string; paypalOrderId: string | null; paypalCaptureId: string | null; amountCents: number; installmentId: string | null }>(
    `SELECT id, status, paypalOrderId, paypalCaptureId, amountCents, installmentId FROM Payment WHERE orderId = ? ORDER BY createdAt`,
    orderId,
  );
export const reservationOf = (orderId: string) => one<{ status: string }>(`SELECT status FROM SeatReservation WHERE orderId = ?`, orderId);
export const enrollments = (orderId: string) =>
  q<{ moodleCourseId: number; status: string }>(`SELECT e.moodleCourseId, e.status FROM Enrollment e JOIN "Order" o ON o.customerId = e.customerId WHERE o.id = ? ORDER BY e.moodleCourseId`, orderId);

/** Espera (sin pasos humanos) a que el pedido llegue a un estado. */
export async function waitForOrderStatus(orderId: string, status: string | string[], timeout = 30_000) {
  const want = Array.isArray(status) ? status : [status];
  await expect.poll(() => order(orderId).status, { timeout, message: `pedido ${orderId} → ${want.join("|")}` }).toMatch(new RegExp(`^(${want.join("|")})$`));
}

// ───────────── mock de Moodle ─────────────

export interface MoodleState {
  users: { id: number; username: string; email: string; password: string | null; preferences: Record<string, unknown>; auth: string }[];
  enrolments: { userid: number; courseid: number; roleid: number; status: number }[];
}
export async function moodleState(request: APIRequestContext): Promise<MoodleState> {
  return (await request.get(`${MOODLE}/__mock/state`)).json();
}
export async function moodleCalls(request: APIRequestContext): Promise<{ at: number; wsfunction: string; params: Record<string, unknown> }[]> {
  return (await request.get(`${MOODLE}/__mock/calls`)).json();
}
/** Llamadas de Moodle que tocan a este usuario/correo (el mock es compartido por todos los tests del carril). */
export function callsFor(calls: Awaited<ReturnType<typeof moodleCalls>>, userId: number | null, email: string) {
  const json = (x: unknown) => JSON.stringify(x);
  return calls.filter((c) => (userId != null && new RegExp(`"userid":"?${userId}"?[,}]|"id":"?${userId}"?[,}]`).test(json(c.params))) || json(c.params).toLowerCase().includes(email.toLowerCase()));
}
/** Cursos (courseid) enviados a enrol_manual_enrol_users para el usuario, en orden y con repeticiones. */
export function enrolCallsFor(calls: Awaited<ReturnType<typeof moodleCalls>>, userId: number): number[] {
  const out: number[] = [];
  for (const c of calls) {
    if (c.wsfunction !== "enrol_manual_enrol_users") continue;
    // Parámetros anidados de Moodle: enrolments[0][userid]=… → objeto con claves "0", "1", …
    const list = Object.values((c.params.enrolments ?? {}) as Record<string, { userid: number | string; courseid: number | string }>);
    for (const e of list) if (Number(e.userid) === userId) out.push(Number(e.courseid));
  }
  return out;
}

// ───────────── mock de PayPal ─────────────

export async function paypalConfig(request: APIRequestContext, cfg: Record<string, unknown>) {
  const r = await request.post(`${PAYPAL}/__mock/config`, { data: { webhookTarget: `${e2eEnv.APP_URL}/api/webhooks/paypal`, ...cfg } });
  expect(r.ok()).toBe(true);
}
export interface PaypalWebhookRecord {
  eventId: string;
  eventType: string;
  /** id del recurso (captura u orden) y de la orden PayPal relacionada. */
  resourceId: string | null;
  orderId: string | null;
  status: number | null;
  error: string | null;
  headers: Record<string, string>;
}
export async function paypalState(request: APIRequestContext): Promise<{
  orders: { id: string; status: string; purchase_units: { payments?: { captures?: { id: string; status: string }[] } }[] }[];
  webhooks: PaypalWebhookRecord[];
}> {
  return (await request.get(`${PAYPAL}/__mock/state`)).json();
}
export async function captureIdOf(request: APIRequestContext, paypalOrderId: string): Promise<string> {
  const st = await paypalState(request);
  const o = st.orders.find((x) => x.id === paypalOrderId);
  const cap = o?.purchase_units[0]?.payments?.captures?.[0]?.id;
  if (!cap) throw new Error(`la orden PayPal ${paypalOrderId} no tiene captura`);
  return cap;
}
/** Webhooks que el mock entregó para una orden PayPal (por su id o el de su captura). */
export async function webhooksFor(request: APIRequestContext, ids: string[]) {
  const st = await paypalState(request);
  return st.webhooks.filter((w) => ids.some((id) => id && (w.resourceId === id || w.orderId === id)));
}
/**
 * PayPal reenvía el evento (webhook repetido): el mock emite un evento firmado NUEVO (otro event id) del mismo
 * capture y lo entrega a la app.
 */
export async function resendCaptureWebhook(request: APIRequestContext, captureId: string) {
  const r = await (await request.post(`${PAYPAL}/__mock/send-webhook/${captureId}`)).json();
  return r as { status: number; event: { id: string; event_type: string }; headers: Record<string, string> };
}
/** Reentrega EXACTA (mismo event id, mismas cabeceras y firma) — como un reintento de PayPal tras un timeout. */
export async function replayWebhook(request: APIRequestContext, sent: { event: unknown; headers: Record<string, string> }) {
  const r = await request.post(`${e2eEnv.APP_URL}/api/webhooks/paypal`, { headers: sent.headers, data: JSON.stringify(sent.event) });
  return { status: r.status(), body: await r.json() };
}

export async function runCron(request: APIRequestContext, jobs: string) {
  const r = await request.post(`${e2eEnv.APP_URL}/api/cron?jobs=${jobs}`, { headers: { authorization: `Bearer ${e2eEnv.CRON_SECRET}` } });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}
