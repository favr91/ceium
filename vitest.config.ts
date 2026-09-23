import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts", "mocks/**/*.test.{ts,mjs}"],
    environment: "node",
    // Los tests de integración que tocan BD deben usar su propio DATABASE_URL (p.ej. file:./test.db).
    fileParallelism: false,
  },
});
