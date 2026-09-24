// Proceso independiente (otra instancia de la app: `npm run dev` + `npm run jobs`, o la app + un script)
// que ejecuta createCheckout completos y concurrentes contra la misma BD SQLite.
//   tsx checkout-race-worker.ts <dbUrl> <productId> <cohortId> <count> <tag>
// Imprime una línea JSON: { ok, soldOut, errors }.
import os from "node:os";
import path from "node:path";
import { createPrismaClient } from "@/server/db";
import type { Deps } from "@/server/deps";
import { isDomainError } from "@/server/errors";
import { createOutboxMailer } from "@/server/email/mailer";
import { createCheckout } from "@/server/orders";
import { FakeMoodle, FakePaypal } from "./fakes";
import { T0 } from "./setup";

async function main() {
  const [url, productId, cohortId, count, tag] = process.argv.slice(2);
  const db = createPrismaClient(url);
  const tmp = path.join(os.tmpdir(), `ceium-race-${process.pid}`);
  const d: Deps = {
    db,
    moodle: new FakeMoodle(),
    paypal: new FakePaypal(),
    mailer: createOutboxMailer(path.join(tmp, "mail")),
    now: () => new Date(T0),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    config: { appUrl: "https://ceium.test", moodleLoginUrl: "x", mailFrom: "x", certificatesDir: tmp, privateFilesDir: tmp, enrollInlineRetries: 0, enrollInlineDelayMs: 0 },
  };
  let ok = 0;
  let soldOut = 0;
  const errors: string[] = [];
  await Promise.all(
    Array.from({ length: Number(count) }, async (_, i) => {
      try {
        await createCheckout(d, {
          // mismo correo en todos los procesos para la mitad de los compradores: carrera en el alta del cliente
          customer: { email: i % 2 ? `shared${i}@example.com` : `${tag}-${i}@example.com`, firstName: "Ana", lastName: "Ruiz" },
          items: [{ productId, modality: "SEMIPRESENCIAL", cohortId, planKind: "FULL" }],
          paymentMethod: "PAYPAL",
        });
        ok++;
      } catch (e) {
        if (isDomainError(e, "SOLD_OUT")) soldOut++;
        else errors.push(`${(e as { code?: string }).code ?? ""} ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      }
    }),
  );
  await db.$disconnect();
  process.stdout.write(JSON.stringify({ ok, soldOut, errors }) + "\n");
}
main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: 0, soldOut: 0, errors: [String(e)] }) + "\n");
  process.exit(1);
});
