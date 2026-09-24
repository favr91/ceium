import fs from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

// e2e contra la app (next start) + mocks de Moodle y PayPal, TODO aislado del entorno de desarrollo:
//   - puertos propios (app :3100, Moodle :4110, PayPal :4120) → no se engancha a `npm run dev` / `npm run mocks`;
//   - BD propia var/e2e/e2e.db (recreada y sembrada en cada corrida) → nunca escribe en dev.db;
//   - APP_URL = la app bajo prueba → return_url/cancel_url de PayPal y enlaces de correos vuelven a :3100;
//   - el mock de PayPal envía los webhooks firmados a :3100/api/webhooks/paypal (y CHECKOUT.ORDER.APPROVED);
//   - correos, comprobantes, certificados y estado del mock Moodle bajo var/e2e/.
// Las variables definidas aquí tienen prioridad sobre .env (Next y los mocks no pisan variables existentes).
// E2E_BASE_URL=… usa una app ya levantada (sin webServer). E2E_REUSE=1 reutiliza servidores ya corriendo
// en ESTOS puertos (solo para iterar localmente; por defecto falla si el puerto está ocupado).
//
// Carril del gauntlet (scripts/lane.mjs) ya levantado: E2E_LANE=<carril> E2E_PORT=<puerto> usa esa app, su BD
// var/lanes/<carril>.db y sus mocks (Moodle = puerto+1000, PayPal = puerto+2000), sin webServer:
//   E2E_LANE=e2e E2E_PORT=3104 npx playwright test tests/e2e/purchase-paypal.spec.ts
const LANE = process.env.E2E_LANE;
const PORT = Number(process.env.E2E_PORT ?? 3100);
const MOODLE_PORT = Number(process.env.E2E_MOODLE_PORT ?? (LANE ? PORT + 1000 : 4110));
const PAYPAL_PORT = Number(process.env.E2E_PAYPAL_PORT ?? (LANE ? PORT + 2000 : 4120));
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const moodleURL = `http://localhost:${MOODLE_PORT}`;
const paypalURL = `http://localhost:${PAYPAL_PORT}`;
const E2E_DIR = LANE ? path.join(__dirname, "var", "lanes", LANE) : path.join(__dirname, "var", "e2e");
const E2E_DB = LANE ? path.join(__dirname, "var", "lanes", `${LANE}.db`) : path.join(E2E_DIR, "e2e.db");
const reuse = process.env.E2E_REUSE === "1";
/** Secreto de /api/cron: en un carril es el de .env (lane.mjs no lo cambia). */
function laneCronSecret(): string {
  try {
    return parseDotenv(fs.readFileSync(path.join(__dirname, ".env"))).CRON_SECRET ?? "";
  } catch {
    return "";
  }
}

/** Entorno común de la app y los mocks bajo prueba. */
export const e2eEnv: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: `file:${E2E_DB}`,
  APP_URL: baseURL,
  MOODLE_URL: moodleURL,
  MOODLE_TOKEN: "mock-moodle-token",
  MOODLE_LOGIN_URL: `${moodleURL}/login/index.php`,
  MOODLE_STUDENT_ROLE_ID: "5",
  PAYPAL_BASE_URL: paypalURL,
  PAYPAL_CLIENT_ID: "mock-client-id",
  PAYPAL_CLIENT_SECRET: "mock-client-secret",
  PAYPAL_WEBHOOK_ID: "mock-webhook-id",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "mock-client-id",
  MAIL_TRANSPORT: "outbox",
  MAIL_DIR: path.join(E2E_DIR, "mail"),
  PRIVATE_FILES_DIR: path.join(E2E_DIR, "files"),
  CERTIFICATES_DIR: path.join(E2E_DIR, "certificates"),
  CRON_SECRET: LANE ? laneCronSecret() : "e2e-cron-secret",
  MOCK_MOODLE_PORT: String(MOODLE_PORT),
  MOCK_MOODLE_TOKEN: "mock-moodle-token",
  MOCK_MOODLE_STATE: path.join(E2E_DIR, "mock-moodle-state.json"),
  MOCK_PAYPAL_PORT: String(PAYPAL_PORT),
  MOCK_PAYPAL_PUBLIC_URL: paypalURL,
  MOCK_PAYPAL_WEBHOOK_TARGET: `${baseURL}/api/webhooks/paypal`,
  MOCK_PAYPAL_APPROVAL_WEBHOOKS: "true",
  MOCK_PAYPAL_AUTO_WEBHOOKS: "true",
  DB_RESET_SKIP_GENERATE: "1",
};

export default defineConfig({
  testDir: "tests/e2e",
  // En un carril, resultados propios: otra corrida de Playwright (otro carril) borra test-results/ al empezar.
  outputDir: LANE ? path.join(E2E_DIR, "test-results") : "test-results",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL, locale: "es-VE", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.E2E_BASE_URL || LANE
    ? undefined
    : [
        { command: "node mocks/moodle/server.mjs", url: `${moodleURL}/health`, env: e2eEnv, reuseExistingServer: reuse, timeout: 30_000 },
        { command: "node mocks/paypal/server.mjs", url: `${paypalURL}/health`, env: e2eEnv, reuseExistingServer: reuse, timeout: 30_000 },
        {
          // BD e2e nueva + seed, build y start, todo con el entorno e2e (nunca dev.db).
          command: `node scripts/db-reset.mjs && npm run build && npx next start -p ${PORT}`,
          url: baseURL,
          env: e2eEnv,
          reuseExistingServer: reuse,
          timeout: 300_000,
        },
      ],
});
