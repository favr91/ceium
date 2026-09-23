import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

// e2e contra la app + mocks. Por defecto levanta ambos (reutiliza si ya están corriendo).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL, locale: "es-VE", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        { command: "npm run mocks", url: "http://localhost:4010/health", reuseExistingServer: true, timeout: 30_000 },
        { command: `npm run build && npx next start -p ${PORT}`, url: baseURL, reuseExistingServer: true, timeout: 300_000 },
      ],
});
