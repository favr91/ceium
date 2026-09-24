// Reinicia la BD SQLite de desarrollo sin `prisma db push --force-reset` (Prisma 7 lo bloquea cuando lo
// ejecuta un agente sin consentimiento explícito): borra el archivo SQLite de DATABASE_URL y vuelve a
// crear el esquema y el seed.
//   npm run db:reset            # usa DATABASE_URL (.env)
//   DATABASE_URL=file:./x.db npm run db:reset
// Solo para SQLite local; se niega con cualquier otra URL (p.ej. PostgreSQL de producción).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL ?? "file:./dev.db";
if (!url.startsWith("file:")) {
  console.error(`[db:reset] DATABASE_URL no es un archivo SQLite (${url.split(":")[0]}:…). No se reinicia.`);
  process.exit(1);
}
const file = path.resolve(process.cwd(), url.slice("file:".length).split("?")[0]);
for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    console.log(`[db:reset] borrado ${path.relative(process.cwd(), f)}`);
  }
}
fs.mkdirSync(path.dirname(file), { recursive: true });
const run = (cmd) => execSync(cmd, { stdio: "inherit", env: process.env });
run("npx prisma db push");
if (process.env.DB_RESET_SKIP_GENERATE !== "1") run("npx prisma generate");
run("npx tsx prisma/seed.ts");
console.log("[db:reset] listo");
