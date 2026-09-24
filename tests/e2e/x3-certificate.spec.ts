// Pieza x3 — certificado del diplomado SOLO al completar TODOS sus cursos y con el saldo en 0, de punta a punta
// por HTTP contra la app y los mocks del carril (Moodle REST con finalización por curso, PayPal Orders v2):
//   1. Un médico compra el diplomado online (pago total) en la tienda real: carrito → checkout → PayPal →
//      webhook → Moodle (matriculado en los 9 cursos).
//   2. Moodle reporta 8 de 9 cursos completados → el job de certificados (POST /api/cron?jobs=certificates) no
//      emite nada ni envía correo, por más veces que corra.
//   3. Se completa el 9.º → corridas SIMULTÁNEAS del job (3 procesos scripts/cron.ts + /api/cron) emiten exactamente UN certificado: PDF real (pdf-lib)
//      con el nombre, el diplomado, los 9 cursos y el código verificable; correo «certificado emitido» con el PDF
//      adjunto y el enlace de verificación; /certificados/<código> lo muestra válido. Repetir el job no duplica
//      nada (ni certificado, ni PDF, ni correo).
//   4. Otro médico compra con «paga la mitad» → saldo pendiente. Completa los 9 cursos y el job NO emite (ni
//      correo) en ninguna corrida; paga el saldo con PayPal desde su enlace de cuota → el job lo emite una vez.
// Carril: E2E_LANE=e2e-cert E2E_PORT=3105 npx playwright test tests/e2e/x3-certificate.spec.ts --project=desktop
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MOODLE, PAYPAL, customerOf, emails, enrollments, one, order, paypalConfig, q, runCron, uniqueEmail, waitForOrderStatus } from "./support/purchase";
import { addToCart, checkoutFormFields, submitCheckout } from "./support/storefront";
import { e2eEnv } from "../../playwright.config";

test.describe.configure({ mode: "serial" });
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "desktop", "flujo de servidor: una vez basta (no depende del viewport)");
});
test.setTimeout(300_000);

const APP_DIR = path.resolve(__dirname, "../..");
const DIPLOMA = "diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico";

interface Buyer {
  email: string;
  first: string;
  last: string;
  orderId: string;
  token: string;
  moodleUserId: number;
  courses: { title: string; moodleCourseId: number }[];
}
let full: Buyer;
let half: Buyer;

const diploma = () => one<{ id: string; title: string }>(`SELECT id, title FROM Product WHERE slug = ?`, DIPLOMA);
const certificatesOf = (customerId: string) =>
  q<{ id: string; code: string; status: string; pdfPath: string | null; emailedAt: number | null; orderItemId: string | null }>(
    `SELECT id, code, status, pdfPath, emailedAt, orderItemId FROM Certificate WHERE customerId = ? AND diplomaId = ?`,
    customerId,
    diploma().id,
  );
const certEmails = (email: string) =>
  q<{ id: string; status: string; subject: string; text: string; html: string; attachments: string | null; dedupeKey: string }>(
    `SELECT id, status, subject, text, html, attachments, dedupeKey FROM EmailOutbox WHERE template = 'certificate_issued' AND "to" = ?`,
    email,
  );
const certEvents = (orderId: string) => q<{ type: string }>(`SELECT type FROM OrderEvent WHERE orderId = ? AND type LIKE 'CERTIFICATE%'`, orderId);

async function complete(request: APIRequestContext, b: Buyer, courseIds: number[]) {
  for (const courseid of courseIds) {
    const r = await request.post(`${MOODLE}/__mock/complete`, { data: { userid: b.moodleUserId, courseid, completed: true } });
    expect(r.ok()).toBe(true);
  }
}

/** Estado real en Moodle: core_completion_get_course_completion_status por la API REST del mock. */
async function moodleCompleted(request: APIRequestContext, b: Buyer): Promise<number> {
  let n = 0;
  for (const c of b.courses) {
    const r = await request.post(`${MOODLE}/webservice/rest/server.php`, {
      form: { wstoken: e2eEnv.MOODLE_TOKEN, wsfunction: "core_completion_get_course_completion_status", moodlewsrestformat: "json", courseid: String(c.moodleCourseId), userid: String(b.moodleUserId) },
    });
    const j = await r.json();
    if (j?.completionstatus?.completed === true) n++;
  }
  return n;
}

async function certificateJob(request: APIRequestContext) {
  const r = await runCron(request, "certificates");
  return r.results.certificates as { checked: number; issued: number; codes: string[]; redelivered: number };
}

/**
 * El mismo job en OTRO proceso (`npm run jobs` / scripts/cron.ts, como en producción junto al /api/cron del
 * hosting), con la BD, Moodle, correo y certificados del carril.
 */
function cronProcess(jobs: string): Promise<string> {
  const keys = ["DATABASE_URL", "APP_URL", "MAIL_DIR", "PRIVATE_FILES_DIR", "CERTIFICATES_DIR", "MOODLE_URL", "MOODLE_TOKEN", "MOODLE_LOGIN_URL", "PAYPAL_BASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "MAIL_TRANSPORT"] as const;
  const env = { ...process.env, ...Object.fromEntries(keys.map((k) => [k, e2eEnv[k]])), NODE_ENV: "production" } as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) =>
    execFile(path.join(APP_DIR, "node_modules/.bin/tsx"), ["scripts/cron.ts", jobs], { cwd: APP_DIR, env, timeout: 90_000, encoding: "utf8" }, (err, stdout: string, stderr: string) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
    ),
  );
}

/** Texto de un PDF de pdf-lib: se inflan los content streams y se decodifican las cadenas (hex / literales). */
function pdfText(bytes: Buffer): string {
  const out: string[] = [];
  const raw = bytes.toString("latin1");
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      body = m[1];
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (t[1]) out.push(Buffer.from(t[1].replace(/\s+/g, ""), "hex").toString("latin1"));
      else out.push(t[2].replace(/\\(.)/g, "$1"));
    }
  }
  return out.join("\n");
}

/** Compra el diplomado ONLINE en la tienda (carrito → checkout → PayPal → retorno) y espera la matrícula. */
async function buyOnline(request: APIRequestContext, ctx: APIRequestContext, tag: string, plan: "FULL" | "HALF", name: [string, string]): Promise<Buyer> {
  expect((await addToCart(ctx, { product: DIPLOMA, modality: "ONLINE", plan })).error).toBeNull();
  const email = uniqueEmail(tag);
  const out = await submitCheckout(ctx, await checkoutFormFields(ctx), { email, firstName: name[0], lastName: name[1], method: "PAYPAL", city: "Caracas" });
  expect(out.ok, JSON.stringify(out)).toBe(true);
  if (!out.ok) throw new Error("checkout");
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${out.paypalOrderId}?json=1`)).json();
  const ret = await request.get(a.redirect, { maxRedirects: 0 });
  expect(new URL(ret.headers()["location"], e2eEnv.APP_URL).searchParams.get("paypal")).toBe("completado");
  const o = one<{ id: string; token: string }>(`SELECT o.id, o.token FROM "Order" o JOIN Customer c ON c.id = o.customerId WHERE c.email = ?`, email);
  await waitForOrderStatus(o.id, "ENROLLED", 60_000);
  const courses = q<{ title: string; moodleCourseId: number }>(
    `SELECT p.title, p.moodleCourseId FROM OrderItemCourse oc JOIN OrderItem oi ON oi.id = oc.orderItemId JOIN Product p ON p.id = oc.courseId WHERE oi.orderId = ? ORDER BY oc.position`,
    o.id,
  );
  expect(courses).toHaveLength(9);
  await expect.poll(() => enrollments(o.id).filter((e) => e.status === "ENROLLED").length, { timeout: 30_000 }).toBe(9);
  return { email, first: name[0], last: name[1], orderId: o.id, token: o.token, moodleUserId: customerOf(o.id).moodleUserId!, courses };
}

test.beforeEach(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: false, webhookDelayMs: 50 });
});
test.afterAll(async ({ request }) => {
  await paypalConfig(request, { autoWebhooks: true, approvalWebhooks: e2eEnv.MOCK_PAYPAL_APPROVAL_WEBHOOKS === "true", webhookDelayMs: 50 });
});

test("diplomado pagado con 8 de 9 cursos completados en Moodle: el job no emite certificado ni envía correo", async ({ request, playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  try {
    full = await buyOnline(request, ctx, "x3cert", "FULL", ["Gabriela Josefina", "Montilla Rondón"]);
  } finally {
    await ctx.dispose();
  }
  expect(order(full.orderId)).toMatchObject({ status: "ENROLLED", balanceCents: 0 });
  const cust = customerOf(full.orderId);

  // Recién matriculado: nada completado → nada.
  await certificateJob(request);
  expect(certificatesOf(cust.id)).toHaveLength(0);

  await complete(request, full, full.courses.slice(0, 8).map((c) => c.moodleCourseId));
  expect(await moodleCompleted(request, full), "Moodle reporta 8 de 9").toBe(8);
  for (let i = 0; i < 3; i++) {
    const r = await certificateJob(request);
    expect(JSON.stringify(r)).not.toContain(full.email);
  }
  expect(certificatesOf(cust.id), "8/9: sin certificado").toHaveLength(0);
  expect(certEmails(full.email), "8/9: sin correo").toHaveLength(0);
  expect(certEvents(full.orderId)).toHaveLength(0);
  // El job sí consultó Moodle: los 8 quedan registrados como completados y el 9.º no.
  const done = q<{ moodleCourseId: number; completedAt: number | null }>(`SELECT moodleCourseId, completedAt FROM Enrollment WHERE customerId = ?`, cust.id);
  expect(done.filter((e) => e.completedAt).map((e) => e.moodleCourseId).sort()).toEqual(full.courses.slice(0, 8).map((c) => c.moodleCourseId).sort());

  // La página pública no conoce ningún certificado de este médico.
  const page = await request.get(`/certificados/CEIUM-AAAAA-AAAAA`);
  expect(await page.text()).toContain("Certificado no encontrado");
});

test("al completar el 9.º curso: corridas simultáneas del job (3 procesos + HTTP) emiten UN certificado (PDF + código verificable + correo); repetir no duplica", async ({ request, page }) => {
  const cust = customerOf(full.orderId);
  await complete(request, full, [full.courses[8].moodleCourseId]);
  expect(await moodleCompleted(request, full)).toBe(9);

  // El job corre a la vez en 3 procesos independientes (scripts/cron.ts) y por HTTP (/api/cron) mientras tanto.
  const procs = Promise.all(Array.from({ length: 3 }, () => cronProcess("certificates")));
  let procsDone = false;
  void procs.finally(() => (procsDone = true)).catch(() => {});
  const runs: Awaited<ReturnType<typeof certificateJob>>[] = [];
  while (!procsDone) runs.push(...(await Promise.all([certificateJob(request), certificateJob(request)])));
  const procOut = await procs;
  const issuedCodes = [
    ...runs.flatMap((r) => r.codes),
    ...procOut.flatMap((o) => [...o.matchAll(/"codes":\[([^\]]*)\]/g)].flatMap((m) => (m[1] ? (JSON.parse(`[${m[1]}]`) as string[]) : []))),
  ];
  const certs = certificatesOf(cust.id);
  expect(certs, "exactamente un certificado").toHaveLength(1);
  const cert = certs[0];
  expect(cert.status).toBe("ISSUED");
  expect(cert.code).toMatch(/^CEIUM-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  expect(issuedCodes, "una sola corrida (de todos los procesos) lo emitió").toEqual([cert.code]);
  expect(certEvents(full.orderId).map((e) => e.type)).toEqual(["CERTIFICATE_ISSUED"]);

  // PDF real en disco: una página A4 horizontal con el titular, el diplomado, los 9 cursos y el código.
  expect(cert.pdfPath).toBeTruthy();
  const pdfFile = path.resolve(APP_DIR, cert.pdfPath!);
  const bytes = fs.readFileSync(pdfFile);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(1);
  expect(doc.getTitle()).toBe(`Certificado ${cert.code}`);
  const text = pdfText(bytes);
  expect(text).toContain(`${full.first} ${full.last}`);
  expect(text).toContain(`Código de verificación: ${cert.code}`);
  expect(text).toContain(`${e2eEnv.APP_URL}/certificados/${cert.code}`);
  expect(text).toContain("9 cursos:");
  for (const c of full.courses.slice(0, 2)) expect(text).toContain(c.title.slice(0, 20));
  const pdfMtime = fs.statSync(pdfFile).mtimeMs;

  // Correo: uno, enviado, al médico, con el PDF adjunto y el enlace de verificación.
  await expect.poll(() => certEmails(full.email).map((m) => m.status)).toEqual(["SENT"]);
  const [mail] = certEmails(full.email);
  expect(mail.text).toContain(cert.code);
  expect(mail.text).toContain(`${e2eEnv.APP_URL}/certificados/${cert.code}`);
  const att = JSON.parse(mail.attachments ?? "[]") as { filename: string; path?: string; contentType?: string }[];
  expect(att).toEqual([expect.objectContaining({ filename: `Certificado-${cert.code}.pdf`, contentType: "application/pdf" })]);
  expect(one<{ emailedAt: number | null }>(`SELECT emailedAt FROM Certificate WHERE id = ?`, cert.id).emailedAt).toBeTruthy();

  // Verificación pública con el código (como lo haría quien recibe el PDF): válido, titular, diplomado y cursos.
  await page.goto(`/certificados/${cert.code}`);
  await expect(page.getByRole("status")).toHaveText("Certificado válido");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(diploma().title);
  await expect(page.getByText(`${full.first} ${full.last}`)).toBeVisible();
  await expect(page.locator("ol li")).toHaveCount(9);
  for (const c of full.courses) await expect(page.locator("ol")).toContainText(c.title);
  // El código escrito a mano en minúsculas también se verifica.
  await page.goto(`/certificados/${cert.code.toLowerCase()}`);
  await expect(page.getByRole("status")).toHaveText("Certificado válido");

  // Repetir el job (seguido y en paralelo) no crea otro certificado, ni regenera el PDF, ni reenvía el correo.
  for (let i = 0; i < 2; i++) await certificateJob(request);
  await Promise.all(Array.from({ length: 4 }, () => certificateJob(request)));
  expect(certificatesOf(cust.id)).toHaveLength(1);
  expect(certificatesOf(cust.id)[0].code).toBe(cert.code);
  expect(certEmails(full.email)).toHaveLength(1);
  expect(certEvents(full.orderId)).toHaveLength(1);
  expect(fs.statSync(pdfFile).mtimeMs).toBe(pdfMtime);
  expect(emails(full.orderId).filter((m) => m.template === "certificate_issued")).toHaveLength(1);
});

test("diplomado con saldo pendiente: completa los 9 cursos y NUNCA recibe el certificado; al pagar el saldo, se emite una vez", async ({ request, playwright, page }) => {
  const ctx = await playwright.request.newContext({ baseURL: e2eEnv.APP_URL });
  try {
    half = await buyOnline(request, ctx, "x3half", "HALF", ["Rafael Antonio", "Castillo Perdomo"]);
  } finally {
    await ctx.dispose();
  }
  const o = order(half.orderId);
  expect(o.status).toBe("ENROLLED");
  expect(o.balanceCents, "queda la otra mitad por pagar").toBeGreaterThan(0);
  const cust = customerOf(half.orderId);

  await complete(request, half, half.courses.map((c) => c.moodleCourseId));
  expect(await moodleCompleted(request, half)).toBe(9);
  for (let i = 0; i < 3; i++) await certificateJob(request);
  await Promise.all(Array.from({ length: 3 }, () => certificateJob(request)));
  expect(certificatesOf(cust.id), "con saldo: sin certificado").toHaveLength(0);
  expect(certEmails(half.email), "con saldo: sin correo").toHaveLength(0);
  expect(certEvents(half.orderId)).toHaveLength(0);

  // Paga el saldo desde su enlace de cuota (el mismo del recordatorio): PayPal → retorno → saldo 0.
  const inst = q<{ id: string; status: string }>(`SELECT id, status FROM Installment WHERE orderId = ? ORDER BY sequence`, half.orderId);
  const next = inst.find((i) => i.status !== "PAID");
  expect(next, "la segunda cuota está pendiente").toBeTruthy();
  await payInstallment(page, request, half.token, next!.id);
  await expect.poll(() => order(half.orderId).balanceCents, { timeout: 30_000 }).toBe(0);
  expect(certificatesOf(cust.id), "pagar no emite por sí solo antes del job").toHaveLength(0);

  await Promise.all(Array.from({ length: 3 }, () => certificateJob(request)));
  const certs = certificatesOf(cust.id);
  expect(certs).toHaveLength(1);
  expect(certs[0].status).toBe("ISSUED");
  await expect.poll(() => certEmails(half.email).map((m) => m.status)).toEqual(["SENT"]);
  const res = await request.get(`/certificados/${certs[0].code}`);
  const html = await res.text();
  expect(html).toContain("Certificado válido");
  expect(html).toContain(`${half.first} ${half.last}`);
});

async function payInstallment(page: Page, request: APIRequestContext, token: string, installmentId: string) {
  await page.goto(`/pedido/${token}/cuota/${installmentId}/paypal`);
  await page.getByRole("button", { name: /con PayPal/ }).click();
  await page.waitForURL((u) => u.href.startsWith(`${PAYPAL}/checkoutnow`), { timeout: 60_000 });
  const pp = new URL(page.url()).searchParams.get("token")!;
  const a = await (await request.post(`${PAYPAL}/__mock/approve/${pp}?json=1`)).json();
  const ret = await request.get(a.redirect, { maxRedirects: 0 });
  expect(new URL(ret.headers()["location"], e2eEnv.APP_URL).searchParams.get("paypal")).toBe("completado");
}
