Código de dominio (solo servidor). Nunca importarlo desde componentes cliente.

- `db.ts` — cliente Prisma singleton (`import { prisma } from "@/server/db"`), re-exporta tipos/enums generados. Serializado con un mutex (ver abajo).
- `pricing.ts` — montos por plan de pago (centavos), `formatUSD` y `priceScopeKey` (clave única NO nula de PriceEntry: todo alta/edición de precios debe escribirla).
- `settings.ts` — claves de la tabla Setting y getters.

Panel: TODA función que el panel invoca recibe el `SessionUser` como primer argumento tras `Deps` y llama a
`requireAdmin(db, user, permiso)` DENTRO del servicio (rol con el permiso + usuario existente y activo en BD, con
el rol leído de la BD). Olvidar `assertCan` en una ruta ya no abre nada: `refundPayment`, `adjustBalance(Detailed)`,
`waiveInstallment`, `revokeCertificate` (solo ADMIN); `adminVerifyPayment`, `adminRecordManualPayment`,
`reassignCohort`, `reenrollOrder`, `adminUnenrollOrder`, `cancelOrder`, `addNote`, `resendEmail` (ADMIN y STAFF).

Escrituras de catálogo/configuración (siempre con `AuditLog` en la misma transacción; `services().cohorts|catalog|settings|adminUsers|audit`):
- `audit.ts` — `recordAudit` (antes/después/campos cambiados, sin secretos), `listAuditLog`.
- `cohorts.ts` — `createCohort`, `updateCohort` (cupo con UPDATE condicional: nunca < `seatsHeld + seatsConfirmed`; no cancela con cupos ocupados), `setCohortStatus`, `deleteCohort` (solo sin ventas).
- `catalog.ts` — `createProduct` (nace sin publicar), `updateProduct`, `archiveProduct` (despublicar), `deleteProduct` (solo sin pedidos/matrículas/certificados), `upsertPrice` / `setPriceActive` / `deletePrice` (escribe `scopeKey`; ONLINE sin sede), `upsertPlan` / `deletePlan` (MONTHLY solo diplomados, cuotas = nº de cursos; un plan usado solo se desactiva), `upsertCollection` / `deleteCollection`, `upsertSede`, `setDiplomaCourses`, imágenes `addProductImage` (archivo → `public/uploads/products/<id>/`, tipo detectado por firma, ≤ 8 MB; o URL https), `updateProductImage`, `reorderProductImages`, `deleteProductImage` (borra el archivo), opciones de compra `upsertProductChoice` / `deleteProductChoice` (p.ej. «Cursos disponibles» del taller transfontanelar, con sus `moodleCourseIds`).
- `admin-settings.ts` — `updateSetting` con esquema por clave (datos bancarios de pago móvil/transferencia, tasa BCV, TTL de reservas, PayPal, reintentos, recordatorios, contacto).
- `admin-users.ts` — `createAdminUser`, `updateAdminUser` (siempre queda un ADMIN activo; cierra sesiones al desactivar/cambiar rol), `resetAdminPassword`.

## Servicios de dominio (compra → pago → matrícula → certificado)

Uso desde la app: `import { services } from "@/server/services"; await services().orders.createCheckout(...)`.
Cada función recibe `Deps` (BD, Moodle, PayPal, mailer, reloj) como primer argumento; `services()` los enlaza
con los clientes reales (`adapters.ts`). Los tests inyectan fakes (`tests/unit/services/helpers`).

- `quote.ts` — `quote(db, {productId, modality, sedeId, choiceId, planKind})` → total, primer pago, cuotas. Mes a mes (solo diplomados): N = nº de cursos del diplomado, cada cuota = `installmentCents`, y cada cuota lleva su curso.
- `installments.ts` — `reallocateInstallments` (única fuente de verdad de `paidCents`/estado: se recalcula tras cada pago y reembolso), `markOverdueInstallments`, `runInstallmentReminders` (recordatorio de la siguiente cuota con enlace directo PayPal/manual; una vez por etapa), `sendInstallmentReminder`, `installmentPaymentLinks`. Rutas: `/pedido/[token]/cuota/[installmentId]/paypal` (inicia PayPal por esa cuota) y `/pedido/[token]/paypal/retorno`.
- `seats.ts` — cupos atómicos (UPDATE condicional): `reserveSeat`, `confirmReservation`, `releaseReservation`, `expireStaleReservations`, `getCohortAvailability`, `reassignItemCohort`.
- `orders.ts` — `createCheckout`, máquina de estados (`ORDER_TRANSITIONS`, `transitionOrder` + OrderEvent), `expireStaleOrders`, `cancelOrder(d, user, orderId, nota)`, `addNote(d, user, orderId, nota)`.
- `corrections.ts` — correcciones del panel: `adjustBalance` / `adjustBalanceDetailed` (condona sobre las cuotas impagas o agrega un cargo como cuota nueva; recalcula estado y matricula), `waiveInstallment` (condona una cuota: WAIVED habilita su curso en el plan mes a mes), `reassignCohort` (cupo CONFIRMED + matrícula si el pedido ya está pagado).
- `payments.ts` — manual (`recordManualPayment` del checkout: tasa y moneda SIEMPRE las configuradas, la tasa que envíe el cliente queda solo como `declaredExchangeRate` en el historial; `adminRecordManualPayment(d, user, …)` sí puede fijar la tasa; `storeProofFile`; `adminVerifyPayment(d, user, …)`; referencia única por índice `Payment.referenceKey` = `<método>:<referencia sin espacios/guiones>`, liberada al rechazar), PayPal (`startPaypalPayment` —rechaza un intento nuevo mientras otro está en CAPTURE_PENDING—, `capturePaypalReturn`, `handlePaypalWebhook`, `onPaypalCaptureCompleted` idempotente), reembolsos (`refundPayment(d, user, …)`: fila Refund PENDING con las opciones del admin creada con el pedido bloqueado, PayPal-Request-Id = `refund-<id>` (reintentar no duplica), `idempotencyKey` del formulario y rechazo del mismo monto repetido en 10 min sin `confirmRepeat`; `onPaypalRefundCompleted` adopta la fila pendiente —por `invoice_id` o monto— y aplica las opciones del admin aunque llegue antes que la respuesta), conciliación (`syncPaypalOrder`, `reconcilePaypalPayments`: aprobados sin retorno y capturas retenidas; webhook `CHECKOUT.ORDER.APPROVED`).
- `enrollment.ts` — `enrollOrder` idempotente con lease + backoff (solo errores reintentables; `MoodleError.retryable === false` → FAILED + ATTENTION al instante), `retryDueEnrollments`, `reenrollOrder(d, user, orderId)`, `adminUnenrollOrder(d, user, orderId)`, `unenrollOrder` (interno). Cursos por ítem: diplomado → sus cursos (mes a mes: solo los de cuotas pagadas; cada cuota nueva matricula su curso y envía el acceso a ese curso); opción con `moodleCourseIds` → esos; si no, el del producto.
- Checkout sin autenticación: un correo existente NO cambia el nombre del cliente (Moodle/certificado). El nombre escrito queda en `Order.buyerFirstName/LastName`; el cliente lo adopta solo en su primera compra pagada sin cuenta Moodle; si difiere después → ATTENTION.
- Reembolsos: reimputan cuotas; un reembolso total revoca los certificados del pedido (`keepCertificate` para conservarlo); uno parcial con certificado y saldo → ATTENTION. PayPal: capturas de intentos reemplazados → ATTENTION; excedente o pago en pedido cerrado → reembolso automático; captura en moneda ≠ USD → no se imputa (FAILED/CURRENCY_MISMATCH + ATTENTION).
- `moodle/client.ts` — `findOrCreateUser`: busca por email; username = `usernameFromEmail` (solo `[a-z0-9_.@-]`, p.ej. `medico+x@…` → `medico_x@…`), con sufijo `-2…` si el username es de otra persona.
- `certificates.ts` — `checkDiplomaCompletion` (solo con TODOS los cursos completos en matrículas vigentes y saldo 0 obligatorio, no configurable), `deliverCertificate` (PDF + correo, recuperable), `runCertificateSweep` (también completa entregas a medias), `revokeCertificate(d, user, id, motivo)` con OrderEvent, `verifyCertificate`, PDF con pdf-lib.
- `email/` — plantillas en español, `sendEmail` (EmailOutbox + .eml, dedupe; adjuntos guardados para reintentos/reenvíos), `retryFailedEmails`, `resendEmail(d, user, id)`. La contraseña temporal de Moodle NUNCA se guarda: la bandeja tiene `[[CEIUM_TEMP_PASSWORD]]` + `secretRef`; un reintento o reenvío pide una nueva a Moodle (`core_user_update_users`, con cambio obligatorio). El .eml se guarda sin secretos.
- `jobs.ts` + `scripts/cron.ts` (`npm run jobs [-- --loop 60]`). Orden: paypal → expire → enrollments → installments → certificates → emails.

SQLite: usar UN solo PrismaClient por proceso (better-sqlite3 es síncrono: dos conexiones en el mismo
proceso se bloquean entre sí). Esa conexión única se comparte entre peticiones, así que `db.ts` la envuelve
en un mutex asíncrono: una `$transaction` interactiva lo retiene entera y cada operación suelta lo toma
mientras dura (dentro de la transacción no se re-toma: AsyncLocalStorage). Sin esto, una escritura suelta
concurrente caía DENTRO de la transacción ajena y se perdía si esta fallaba (p.ej. SOLD_OUT). El lote
`$transaction([...])` no está soportado: usar `withTx`. Varias instancias = varios procesos (`npm run dev` +
`npm run jobs`, o la app + un script): cada conexión usa WAL, `busy_timeout` corto (espera síncrona,
`SQLITE_BUSY_TIMEOUT_MS`, 1 s) y abre las transacciones con `BEGIN IMMEDIATE` (si el lock sigue ocupado,
cae a DEFERRED para no bloquear el mutex interno del adaptador); `withTx` reintenta con backoff asíncrono
P1008 / SQLITE_BUSY / P2034 / P2028, y con `{ retryUnique: true }` también P2002 (alta de cliente y número de
pedido en `createCheckout`). Probado: 8 procesos × 10 checkouts sin errores y sin sobreventa
(`tests/unit/services/concurrency.test.ts`).

Importes del pedido (Postgres, READ COMMITTED): toda transacción que lee y luego escribe importes llama
primero a `lockOrder(tx, orderId)` (UPDATE de la fila = lock hasta el commit) y usa `{ increment }` /
`{ decrement }` para `amountPaidCents` y `refundedCents`: dos confirmaciones simultáneas del mismo pedido
(webhook de cuota + aprobación manual) no se pisan.

`services()` construye los clientes de Moodle y PayPal de forma perezosa (primer uso): sin `MOODLE_TOKEN` la
app arranca y las páginas que solo leen funcionan; la matrícula falla de forma controlada y queda para
reintento. `tests/unit/services/wiring.test.ts` prueba el cableado real (createDefaultDeps → adapters →
clientes reales → mocks HTTP, rutas reales de retorno y webhook).

- `auth.ts` — panel: `login` (bcrypt, mismo error para correo/clave/inactivo), sesiones opacas en
  `AdminSession` (solo sha256 del token; 12 h con renovación deslizante), `getAdminSession`, `logout`,
  `changePassword` (revoca sesiones), permisos por rol `can` / `assertCan` / `requireAdmin` (STAFF: pedidos, verificar
  pagos, correos, cohortes; solo ADMIN: reembolsos, ajustes de saldo, revocar certificados, catálogo,
  configuración, usuarios), `ADMIN_SESSION_COOKIE` + `adminCookieOptions`.
