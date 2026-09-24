// Levanta un carril aislado: BD propia, build dir propio, mocks propios y `next dev` en su puerto.
//   node scripts/lane.mjs <carril> <puerto> [--reset]
// Carriles del gauntlet: tienda 3101, compra 3102, panel 3103, e2e 3104, preview 3900.
// Mocks: Moodle = puerto+1000, PayPal = puerto+2000 (p. ej. compra → 4102 / 5102).
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const [lane, portArg] = process.argv.slice(2);
if (!lane || !portArg) { console.error("uso: node scripts/lane.mjs <carril> <puerto> [--reset]"); process.exit(1); }
const port = Number(portArg);
const db = path.resolve(`var/lanes/${lane}.db`);
const env = {
  ...process.env,
  DATABASE_URL: `file:${db}`,
  NEXT_DIST_DIR: `.next-${lane}`,
  APP_URL: `http://localhost:${port}`,
  MOCK_MOODLE_PORT: String(port + 1000),
  MOCK_PAYPAL_PORT: String(port + 2000),
  MOODLE_URL: `http://localhost:${port + 1000}`,
  PAYPAL_BASE_URL: `http://localhost:${port + 2000}`,
  MOCK_PAYPAL_WEBHOOK_TARGET: `http://localhost:${port}/api/webhooks/paypal`,
  MAIL_DIR: `var/lanes/${lane}/mail`,
};
if (process.argv.includes("--reset") || !fs.existsSync(db)) {
  execSync(`node scripts/db-reset.mjs var/lanes/${lane}.db`, { stdio: "inherit", env: { ...env, DB_RESET_SKIP_GENERATE: "1" } });
}
const kids = [
  spawn("node", ["mocks/run-mocks.mjs"], { stdio: "inherit", env }),
  spawn("npx", ["next", "dev", "-p", String(port)], { stdio: "inherit", env }),
];
const stop = () => { kids.forEach((k) => k.kill("SIGTERM")); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
