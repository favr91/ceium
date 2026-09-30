// Enlaces de acceso al panel: invitación (crear la contraseña) y restablecer la contraseña. Como las sesiones, el
// enlace lleva un token aleatorio de 256 bits y en BD solo queda su sha256 (AdminUser.setupTokenHash). Sirve una
// sola vez; la invitación vence a las 72 h y el de restablecer a las 24 h. Emitir uno nuevo anula el anterior.
// El correo lo lleva como secreto (email/index.ts): no se guarda en la bandeja ni en la copia .eml, y si hay que
// reintentar el envío se emite otro enlace.
import crypto from "node:crypto";
import type { AdminRole } from "@/generated/prisma/client";
import { hashToken } from "@/server/auth";
import type { Db, Tx } from "@/server/deps";
import { DomainError } from "@/server/errors";

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

/** invite = aún no tiene contraseña · reset = ya entraba y crea una nueva. */
export type AccessLinkKind = "invite" | "reset";

export const accessLinkUrl = (appUrl: string, token: string) => `${appUrl}/admin/acceso/${token}`;

/** Emite un enlace nuevo para el usuario (anula el anterior). */
export async function issueAccessToken(db: Db | Tx, userId: string, now: Date): Promise<{ token: string; expiresAt: Date; kind: AccessLinkKind }> {
  const u = await db.adminUser.findUnique({ where: { id: userId }, select: { active: true, invitePending: true } });
  if (!u) throw new DomainError("NOT_FOUND", "El usuario no existe.");
  if (!u.active) throw new DomainError("CONFLICT", "La cuenta está desactivada: reactívala antes de enviarle un enlace.");
  const kind: AccessLinkKind = u.invitePending ? "invite" : "reset";
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + (kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS));
  await db.adminUser.update({ where: { id: userId }, data: { setupTokenHash: hashToken(token), setupTokenExpiresAt: expiresAt } });
  return { token, expiresAt, kind };
}

export interface AccessLinkInfo {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  kind: AccessLinkKind;
  expiresAt: Date;
}

/** Datos del enlace si sigue vigente (no usado, no vencido, cuenta activa); si no, null. */
export async function readAccessLink(db: Db | Tx, token: string | null | undefined, now: Date): Promise<AccessLinkInfo | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const u = await db.adminUser.findUnique({
    where: { setupTokenHash: hashToken(token) },
    select: { id: true, email: true, name: true, role: true, active: true, invitePending: true, setupTokenExpiresAt: true },
  });
  if (!u || !u.active || !u.setupTokenExpiresAt || u.setupTokenExpiresAt <= now) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, kind: u.invitePending ? "invite" : "reset", expiresAt: u.setupTokenExpiresAt };
}
