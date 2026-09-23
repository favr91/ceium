Código de dominio (solo servidor). Nunca importarlo desde componentes cliente.

- `db.ts` — cliente Prisma singleton (`import { prisma } from "@/server/db"`), re-exporta tipos/enums generados. Serializado con un mutex (ver abajo).
- `pricing.ts` — montos por plan de pago (centavos), `formatUSD` y `priceScopeKey` (clave única NO nula de PriceEntry: todo alta/edición de precios debe escribirla).
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
- `payments.ts` — manual (`recordManualPayment`, `storeProofFile`, `adminVerifyPayment`), PayPal (`startPaypalPayment`, `capturePaypalReturn`, `handlePaypalWebhook`, `onPaypalCaptureCompleted` idempotente), reembolsos (`refundPayment`, `onPaypalRefundCompleted`; la carrera panel/webhook no da error), conciliación (`syncPaypalOrder`, `reconcilePaypalPayments`: aprobados sin retorno y capturas retenidas; webhook `CHECKOUT.ORDER.APPROVED`).
- `enrollment.ts` — `enrollOrder` idempotente con lease + backoff, `retryDueEnrollments`, `reenrollOrder`, `unenrollOrder`. Cursos por ítem: diplomado → sus cursos; opción con `moodleCourseIds` → esos; si no, el del producto.
- `certificates.ts` — `checkDiplomaCompletion` (solo con TODOS los cursos completos y saldo 0 — `certificates.policy.requireFullPayment`), `deliverCertificate` (PDF + correo, recuperable), `runCertificateSweep` (también completa entregas a medias), `revokeCertificate(id, motivo, adminId)` con OrderEvent, `verifyCertificate`, PDF con pdf-lib.
- `email/` — plantillas en español, `sendEmail` (EmailOutbox + .eml, dedupe; adjuntos guardados para reintentos/reenvíos), `retryFailedEmails`, `resendEmail(id, adminId)`. La contraseña temporal de Moodle NUNCA se guarda: la bandeja tiene `[[CEIUM_TEMP_PASSWORD]]` + `secretRef`; un reintento o reenvío pide una nueva a Moodle (`core_user_update_users`, con cambio obligatorio). El .eml se guarda sin secretos.
- `jobs.ts` + `scripts/cron.ts` (`npm run jobs [-- --loop 60]`). Orden: paypal → expire → enrollments → certificates → emails.

SQLite: usar UN solo PrismaClient por proceso (better-sqlite3 es síncrono: dos conexiones en el mismo
proceso se bloquean entre sí). Esa conexión única se comparte entre peticiones, así que `db.ts` la envuelve
en un mutex asíncrono: una `$transaction` interactiva lo retiene entera y cada operación suelta lo toma
mientras dura (dentro de la transacción no se re-toma: AsyncLocalStorage). Sin esto, una escritura suelta
concurrente caía DENTRO de la transacción ajena y se perdía si esta fallaba (p.ej. SOLD_OUT). El lote
`$transaction([...])` no está soportado: usar `withTx`. Varias instancias = varios procesos (probado; ahí
aplica el bloqueo de SQLite y `withTx` reintenta SQLITE_BUSY).
