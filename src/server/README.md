Código de dominio (solo servidor). Nunca importarlo desde componentes cliente.

- `db.ts` — cliente Prisma singleton (`import { prisma } from "@/server/db"`), re-exporta tipos/enums generados.
- `pricing.ts` — montos por plan de pago (centavos) y `formatUSD`.
- `settings.ts` — claves de la tabla Setting y getters.

Módulos esperados (otras piezas): `catalog/`, `cohorts/` (reservas atómicas), `orders/`, `payments/paypal.ts`,
`payments/manual.ts`, `moodle/client.ts`, `enrollment/`, `certificates/`, `email/`, `auth/`, `jobs/`.
