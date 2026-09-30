// Roles del panel: nombres, descripción y jerarquía. Sin dependencias de servidor (lo usan también las páginas del
// panel en el navegador). Los permisos de cada rol están en auth.ts → PERMISSIONS.
//
//   ADMIN       Super administrador: todo.
//   COMMERCIAL  Administrador comercial: la academia (programas, precios, colecciones, sedes, cohortes, matrículas,
//               certificados) y la operación de pedidos y pagos. En el equipo solo gestiona asistentes.
//   STAFF       Asistente: el día a día (pedidos, verificar pagos manuales, correos, cohortes y matrículas).
import type { AdminRole } from "@/generated/prisma/client";

/** De mayor a menor. */
export const ADMIN_ROLES = ["ADMIN", "COMMERCIAL", "STAFF"] as const satisfies readonly AdminRole[];

export const ROLE_LABEL: Record<AdminRole, string> = {
  ADMIN: "Super administrador",
  COMMERCIAL: "Administrador comercial",
  STAFF: "Asistente",
};

export const ROLE_SUMMARY: Record<AdminRole, string> = {
  ADMIN: "Acceso total: configuración y métodos de pago, reembolsos y ajustes de saldo, y todo el equipo.",
  COMMERCIAL: "Gestiona la academia (programas, precios, cohortes, sedes, matrículas y certificados), verifica pagos y puede invitar asistentes.",
  STAFF: "Opera el día a día: pedidos, verificar pagos manuales, correos, cohortes y matrículas. El catálogo lo ve en solo lectura.",
};

const RANK: Record<AdminRole, number> = { ADMIN: 3, COMMERCIAL: 2, STAFF: 1 };

/**
 * ¿Puede `actor` gestionar (invitar, editar, desactivar, restablecer el acceso de) a alguien con el rol `target`?
 * El super administrador, a cualquiera; los demás, solo a roles por debajo del suyo (no a los de su mismo nivel).
 */
export function canManageRole(actor: AdminRole, target: AdminRole): boolean {
  return actor === "ADMIN" || RANK[target] < RANK[actor];
}

/** Roles que `actor` puede asignar al invitar o editar. */
export function assignableRoles(actor: AdminRole): AdminRole[] {
  return ADMIN_ROLES.filter((r) => canManageRole(actor, r));
}

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === "string" && (ADMIN_ROLES as readonly string[]).includes(v);
}
