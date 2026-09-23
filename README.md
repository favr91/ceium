# CEIUM — app

Clon propio de ceium.net + compra automatizada. Contrato: `../SPEC.md`. Referencias: `../ref/`.

## Arranque
```bash
cp .env.example .env        # ya existe en dev
npm install                 # postinstall = prisma generate
npm run db:push             # crea/actualiza dev.db (SQLite) + genera cliente
npm run db:seed             # BORRA y recrea catálogo real, sedes, cohortes de ejemplo, admin, settings
npm run mocks               # mock Moodle :4010 + mock PayPal :4020 (placeholders hasta que se implementen)
npm run dev                 # http://localhost:3000   · panel: /admin (admin@ceium.net / ceium-admin-2026)
```
Otros: `build`, `start`, `test` (vitest, `tests/unit`), `test:e2e` (playwright, `tests/e2e`, levanta mocks + app en :3100),
`typecheck`, `lint`, `db:reset`, `db:studio`, `catalog:extract` (re-extrae fichas de ceium.net → `prisma/seed-data/product-details.json`).
`jobs` (`scripts/cron.ts`): pagos PayPal sin retorno, vencimientos, reintentos de matrícula, **cuotas** (vencidas + recordatorio
de la siguiente cuota con enlace de pago), certificados y reintento de correos.

### Base de datos limpia (verificación / agentes)
`db:reset` usa `prisma db push --force-reset`, que Prisma 7 bloquea cuando lo ejecuta un agente de IA sin consentimiento
explícito del usuario. Para verificar desde cero **no** se resetea `dev.db`: se apunta a una BD nueva y vacía.
```bash
DATABASE_URL="file:/tmp/ceium-check.db" npx prisma db push && DATABASE_URL="file:/tmp/ceium-check.db" npm run db:seed
```
Los tests (`npm test`) ya crean una BD SQLite aislada por archivo de test; no tocan `dev.db`.

## Estructura
```
src/app/(store)/     tienda pública (home, /collections/[slug], /products/[slug], /cart, /checkout, /pages/*)
src/app/admin/       panel
src/app/api/         route handlers (webhooks, jobs, APIs)
src/server/          dominio (solo servidor): db.ts, pricing.ts, settings.ts, …
src/components/      UI compartida
src/generated/prisma cliente Prisma generado (no versionado)
prisma/              schema.prisma, seed.ts, seed-data/
mocks/{moodle,paypal}/server.mjs, mocks/run-mocks.mjs
var/                 (no versionado) correos .eml, comprobantes, certificados, caché de HTML
```

## Convenciones
- Prisma 7 + driver adapter `better-sqlite3` (`src/server/db.ts`). Importar siempre `import { prisma } from "@/server/db"`.
  Enums/tipos: `import { OrderStatus, type Order } from "@/server/db"`.
- Dinero en **centavos enteros** (`*Cents`), USD base. `PriceEntry.priceCents` = precio de lista total; planes en `PaymentPlan`
  (`computePlanAmounts` reproduce exactamente los precios de todas las variantes reales; el seed lo verifica).
- **Mes a mes** (solo diplomados): una cuota por curso del diplomado (9 × 180/230/150), `Installment.courseId` = curso que
  habilita; cada cuota confirmada matricula SOLO ese curso. Cuotas se imputan con `reallocateInstallments` (pagos y reembolsos).
- ONLINE ⇒ `sedeId = null`. Cohortes solo semipresencial. Cupo con contadores `seatsHeld/seatsConfirmed` y UPDATE condicional.
- Cohortes sembradas = **datos de ejemplo** (`Cohort.isSample`, Setting `seed.sampleData`). Datos bancarios = `TODO` (Setting `payments.manualMethods`).
- Todo texto de UI en español (Venezuela). Nada de catálogo hardcodeado: todo sale de la BD.
