Código de dominio (solo servidor). Nunca importarlo desde componentes cliente.

- `db.ts` — cliente Prisma singleton (`import { prisma } from "@/server/db"`), re-exporta tipos/enums generados.
- `pricing.ts` — montos por plan de pago (centavos) y `formatUSD`.
- `settings.ts` — claves de la tabla Setting y getters.

Módulos esperados (otras piezas): `catalog/`, `cohorts/` (reservas atómicas), `orders/`, `payments/paypal.ts`,
`payments/manual.ts`, `moodle/client.ts`, `enrollment/`, `certificates/`, `email/`, `auth/`, `jobs/`.

## Servicios de dominio (compra → pago → matrícula → certificado)

Uso desde la app: `import { services } from "@/server/services"; await services().orders.createCheckout(...)`.
Cada función recibe `Deps` (BD, Moodle, PayPal, mailer, reloj) como primer argumento; `services()` los enlaza
con los clientes reales (`adapters.ts`). Los tests inyectan fakes (`tests/unit/services/helpers`).

- `quote.ts` — `quote(db, {productId, modality, sedeId, choiceId, planKind})` → total, primer pago, cuotas.
- `seats.ts` — cupos atómicos (UPDATE condicional): `reserveSeat`, `confirmReservation`, `releaseReservation`, `expireStaleReservations`, `getCohortAvailability`, `reassignItemCohort`.
- `orders.ts` — `createCheckout`, máquina de estados (`ORDER_TRANSITIONS`, `transitionOrder` + OrderEvent), `expireStaleOrders`, `cancelOrder`, `adjustBalance`, `reassignCohort`.
- `payments.ts` — manual (`recordManualPayment`, `storeProofFile`, `adminVerifyPayment`), PayPal (`startPaypalPayment`, `capturePaypalReturn`, `handlePaypalWebhook`, `onPaypalCaptureCompleted` idempotente), reembolsos (`refundPayment`, `onPaypalRefundCompleted`).
- `enrollment.ts` — `enrollOrder` idempotente con lease + backoff, `retryDueEnrollments`, `reenrollOrder`, `unenrollOrder`.
- `certificates.ts` — `checkDiplomaCompletion` (solo con TODOS los cursos completos), `runCertificateSweep`, `verifyCertificate`, PDF con pdf-lib.
- `email/` — plantillas en español, `sendEmail` (EmailOutbox + .eml, dedupe), `retryFailedEmails`.
- `jobs.ts` + `scripts/cron.ts` (`npm run jobs [-- --loop 60]`).

SQLite: usar UN solo PrismaClient por proceso (better-sqlite3 es síncrono: dos conexiones en el mismo
proceso se bloquean entre sí). Varias instancias = varios procesos (probado) o Postgres.
