import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Relativo al directorio app/ (cwd de todos los scripts npm).
    url: process.env["DATABASE_URL"] ?? "file:./dev.db",
  },
});
