// BD SQLite aislada por archivo de test: se genera una plantilla con `prisma db push` (una vez por
// versión del esquema) y se copia para cada test.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrismaClient } from "@/server/db";

const APP = path.resolve(__dirname, "../../../..");
const DIR = path.join(APP, "var", "test");

function templatePath(): string {
  const schema = fs.readFileSync(path.join(APP, "prisma", "schema.prisma"));
  const hash = crypto.createHash("sha1").update(schema).digest("hex").slice(0, 12);
  const file = path.join(DIR, `template-${hash}.db`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    execFileSync(path.join(APP, "node_modules", ".bin", "prisma"), ["db", "push"], {
      cwd: APP,
      env: { ...process.env, DATABASE_URL: `file:${tmp}` },
      stdio: "pipe",
    });
    fs.renameSync(tmp, file);
  }
  return file;
}

export function createTestDb(name: string) {
  const file = path.join(DIR, `${name}-${process.pid}-${crypto.randomBytes(3).toString("hex")}.db`);
  fs.copyFileSync(templatePath(), file);
  const url = `file:${file}`;
  const db = createPrismaClient(url);
  return {
    db,
    url,
    file,
    /** Otro cliente (otra conexión) a la misma BD, para simular varias instancias de la app. */
    extraClient: () => createPrismaClient(url),
    async dispose() {
      await db.$disconnect();
      for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
    },
  };
}
