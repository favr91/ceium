// Auditoría del panel (tabla AuditLog) para todo lo que no es un pedido: catálogo, precios, planes,
// colecciones, sedes, cohortes, configuración y usuarios. Los pedidos siguen usando OrderEvent.
// Cada escritura del panel pasa por un servicio (catalog.ts, cohorts.ts, admin-settings.ts, admin-users.ts)
// que escribe el cambio y su registro de auditoría en la MISMA transacción: o quedan los dos, o ninguno.
import type { Prisma } from "@/generated/prisma/client";
import type { Deps, Tx } from "@/server/deps";
import type { SessionUser } from "@/server/auth";

export type AuditEntity = "Product" | "PriceEntry" | "PaymentPlan" | "Collection" | "Sede" | "Cohort" | "Setting" | "AdminUser" | "DiplomaCourse";

/** Campos que nunca se guardan en la auditoría. */
const SECRET_FIELDS = new Set(["passwordHash", "password", "tokenHash"]);
/** Campos de servicio que no son un cambio del admin. */
const NOISE_FIELDS = new Set(["updatedAt", "createdAt"]);

export interface AuditChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** Convierte a JSON plano (fechas → ISO) y quita secretos. */
export function auditSnapshot(v: unknown): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(auditSnapshot);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(k)) continue;
      out[k] = auditSnapshot(x);
    }
    return out;
  }
  return v;
}

/** Campos que cambiaron entre dos instantáneas planas (nivel superior). */
export function diffSnapshots(before: unknown, after: unknown): AuditChange[] {
  const b = (before && typeof before === "object" && !Array.isArray(before) ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" && !Array.isArray(after) ? after : {}) as Record<string, unknown>;
  if ((before != null && typeof before !== "object") || Array.isArray(before) || Array.isArray(after) || (after != null && typeof after !== "object")) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ field: "value", from: before ?? null, to: after ?? null }];
  }
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !NOISE_FIELDS.has(k) && !SECRET_FIELDS.has(k));
  const out: AuditChange[] = [];
  for (const k of keys) {
    if (JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null)) out.push({ field: k, from: b[k] ?? null, to: a[k] ?? null });
  }
  return out;
}

export interface AuditInput {
  actor: Pick<SessionUser, "id" | "email"> | null;
  action: string;
  entityType: AuditEntity;
  entityId: string;
  before?: unknown;
  after?: unknown;
  note?: string | null;
  /** Registrar aunque no haya cambios (p.ej. restablecer contraseña). */
  force?: boolean;
}

/** Inserta el registro dentro de la transacción del cambio. Sin cambios reales (y sin `force`) no escribe. */
export async function recordAudit(tx: Tx, input: AuditInput) {
  const before = auditSnapshot(input.before);
  const after = auditSnapshot(input.after);
  const changes = diffSnapshots(before, after);
  if (!changes.length && !input.force && input.before !== undefined && input.after !== undefined) return null;
  return tx.auditLog.create({
    data: {
      actorType: input.actor ? "ADMIN" : "SYSTEM",
      actorId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (after ?? undefined) as Prisma.InputJsonValue | undefined,
      changes: changes as unknown as Prisma.InputJsonValue,
      note: input.note?.trim() || null,
    },
  });
}

export interface AuditQuery {
  entityType?: AuditEntity;
  entityId?: string;
  actorId?: string;
  action?: string;
  /** Paginación: registros anteriores a esta fecha. */
  before?: Date;
  limit?: number;
}

/** Historial para el panel (más reciente primero). */
export async function listAuditLog(d: Pick<Deps, "db">, q: AuditQuery = {}) {
  return d.db.auditLog.findMany({
    where: {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.before ? { createdAt: { lt: q.before } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(q.limit ?? 50, 1), 200),
    include: { actor: { select: { id: true, email: true, name: true } } },
  });
}
