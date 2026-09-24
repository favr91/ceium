import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build dirs de los carriles (scripts/lane.mjs: NEXT_DIST_DIR=.next-<carril>) y artefactos locales.
    ".next-*/**",
    "var/**",
    "test-results/**",
    "playwright-report/**",
    "src/generated/**",
  ]),
]);

export default eslintConfig;
