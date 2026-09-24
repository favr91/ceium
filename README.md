# CEIUM — app

Clon propio de ceium.net + compra automatizada. Contrato: `../SPEC.md`. Referencias: `../ref/`.

## Arranque
```bash
cp .env.example .env        # ya existe en dev
npm install                 # postinstall = prisma generate
npm run db:push             # crea/actualiza dev.db (SQLite) + genera cliente
npm run db:seed             # BORRA y recrea catálogo real, sedes, cohortes de ejemplo, admin, settings
npm run mocks               # mock Moodle :4010 + mock PayPal :4020 (protocolo real: REST de Moodle, Orders v2/Payments/Webhooks)
npm run dev                 # http://localhost:3000   · panel: /admin (admin@ceium.net / ceium-admin-2026)
```
Otros: `build`, `start`, `test` (vitest, `tests/unit`), `test:e2e` (playwright, `tests/e2e`: entorno aislado — BD `var/e2e/e2e.db` recreada y sembrada, app en :3100 con
`APP_URL` = :3100, mocks Moodle :4110 / PayPal :4120 con webhooks → :3100; no reutiliza servidores salvo `E2E_REUSE=1`),
`typecheck`, `lint`, `db:reset`, `db:studio`, `catalog:extract` (re-extrae fichas de ceium.net → `prisma/seed-data/product-details.json`).
`jobs` (`scripts/cron.ts`): pagos PayPal sin retorno, vencimientos, reintentos de matrícula, **cuotas** (vencidas + recordatorio
de la siguiente cuota con enlace de pago), certificados y reintento de correos.

### Base de datos limpia (verificación / agentes)
**No usar `npx prisma db push --force-reset`**: Prisma 7 lo bloquea cuando lo ejecuta un agente de IA sin
consentimiento explícito del usuario. En su lugar:
```bash
npm run db:check            # BD NUEVA en var/check/check.db (esquema + seed); dev.db no se toca
npm run db:reset            # borra el archivo SQLite de DATABASE_URL (dev.db) y hace db push + seed
# o, a mano, una BD en cualquier ruta:
DATABASE_URL="file:/tmp/ceium-check.db" npx prisma db push && DATABASE_URL="file:/tmp/ceium-check.db" npm run db:seed
```
Para usar la BD de verificación: `DATABASE_URL=file:./var/check/check.db npm run dev` (o `jobs`, `tsx …`).
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
- **Panel = servicios auditados.** Catálogo (`catalog.ts`: fichas, precios, planes, colecciones, sedes, cursos de
  diplomado), cohortes (`cohorts.ts`: el cupo nunca queda por debajo de `seatsHeld + seatsConfirmed`), configuración
  (`admin-settings.ts`: datos bancarios, tasa BCV, TTL de reservas… validados por clave) y usuarios (`admin-users.ts`)
  escriben el cambio y su `AuditLog` (quién, cuándo, antes/después, campos) en la misma transacción. Los pedidos usan
  `OrderEvent`. No escribir esas tablas con `prisma.*` desde rutas/acciones.
- `Product.enrollmentDeadline` (último día de inscripción, inclusivo) se aplica en `quote()`/`createCheckout`;
  la tienda usa `isProductEnrollmentOpen()` para mostrar «Inscripciones cerradas».
- Cohortes sembradas = **datos de ejemplo** (`Cohort.isSample`, Setting `seed.sampleData`). Datos bancarios = `TODO` (Setting `payments.manualMethods`).
- Todo texto de UI en español (Venezuela). Nada de catálogo hardcodeado: todo sale de la BD.
