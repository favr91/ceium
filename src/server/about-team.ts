// Personal de CEIUM en /pages/quienes-somos, editable desde el panel: quién aparece, en qué orden, con qué nombre,
// cargo y foto, y el título y el texto de la sección. Se guarda en la Setting `store.pages` («quienes-somos».team),
// la que ya sobreescribe el contenido editorial de las páginas; el resto de esa Setting no se toca.
// Lo edita quien gestiona el catálogo (superadministrador y administrador comercial); el asistente solo lo ve.
// Toda la sección se guarda de una vez: si otra persona guardó mientras tanto, el cambio se rechaza (CONFLICT)
// en vez de pisar el suyo.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { requireAdmin, type SessionUser } from "@/server/auth";
import { recordAudit } from "@/server/audit";
import { withTx, type Deps } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { SETTING_KEYS } from "@/server/settings";
import { removeUploadedImage, storeOptimizedImage, UPLOADS_URL } from "@/server/uploads";
import { readTeam, TEAM_PAGE, type TeamSection } from "@/components/store/pages/team";

const KEY = SETTING_KEYS.storePages;
/** Carpeta de las fotos subidas: <uploads>/team/. */
const TEAM_DIR = "team";
/**
 * Una foto subida que nunca se guardó (se descartó el cambio) se borra al guardar pasado este plazo; antes puede
 * estar en el borrador de alguien que aún no guarda.
 */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const TEAM_PHOTO_RE = new RegExp(`^${UPLOADS_URL}${TEAM_DIR}/[a-z0-9-]+-w\\d+\\.webp$`);

const memberSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,40}$/, "Identificador inválido"),
    name: z.string().trim().min(1, "Cada persona necesita un nombre").max(120, "El nombre admite hasta 120 caracteres"),
    role: z.string().trim().max(160, "El cargo admite hasta 160 caracteres"),
    photo: z
      .string()
      .trim()
      .max(1000)
      .refine((u) => !u || /^https:\/\/\S+$/.test(u) || TEAM_PHOTO_RE.test(u), "La foto debe ser una imagen subida aquí o una dirección https://"),
    hidden: z.boolean().optional(),
  })
  .strict();

export const teamSectionSchema = z
  .object({
    title: z.string().trim().min(1, "El título de la sección es obligatorio").max(120, "El título admite hasta 120 caracteres"),
    text: z.string().trim().max(600, "El texto admite hasta 600 caracteres"),
    members: z.array(memberSchema).max(60, "Hasta 60 personas"),
  })
  .strict()
  .superRefine((t, ctx) => {
    const ids = new Set<string>();
    for (const [i, m] of t.members.entries()) {
      if (ids.has(m.id)) ctx.addIssue({ code: "custom", path: ["members", i, "id"], message: "Identificador repetido" });
      ids.add(m.id);
      if (!m.hidden && !m.photo) ctx.addIssue({ code: "custom", path: ["members", i, "photo"], message: `Falta la foto de ${m.name}: súbela u oculta a esa persona` });
    }
  });

function parseTeam(input: unknown): TeamSection {
  const r = teamSectionSchema.safeParse(input);
  if (!r.success) throw new DomainError("VALIDATION", r.error.issues.map((i) => i.message).join(". ") + ".", { issues: r.error.issues });
  // Solo se guarda `hidden` cuando la persona está oculta (lo guardado antes del editor no lo tiene).
  return { ...r.data, members: r.data.members.map(({ hidden, ...m }) => (hidden ? { ...m, hidden: true } : m)) };
}

/** Versión de lo guardado, para detectar que otra persona guardó mientras se editaba (null: nunca se guardó). */
const versionOf = (row: { updatedAt: Date } | null) => row?.updatedAt.toISOString() ?? null;

export interface TeamEditorData {
  team: TeamSection;
  version: string | null;
}

/** La sección como la edita el panel (con las personas ocultas). */
export async function getTeamSection(d: Deps, actor: SessionUser): Promise<TeamEditorData> {
  await requireAdmin(d.db, actor, "orders.view");
  const row = await d.db.setting.findUnique({ where: { key: KEY } });
  const pages = isRecord(row?.value) ? row.value : {};
  const page = isRecord(pages[TEAM_PAGE]) ? pages[TEAM_PAGE] : {};
  return { team: readTeam(page.team), version: versionOf(row) };
}

/**
 * Guarda la sección completa. `version` es la que devolvió getTeamSection (o el último guardado): si lo guardado
 * cambió desde entonces, CONFLICT. Las fotos subidas que dejan de usarse se borran.
 */
export async function saveTeamSection(d: Deps, actor: SessionUser, input: { team: unknown; version: string | null }, note?: string): Promise<TeamEditorData> {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const team = parseTeam(input.team);
  const { before, version } = await withTx(d, async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: KEY } });
    if (versionOf(row) !== input.version) throw new DomainError("CONFLICT", "Otra persona guardó cambios en el personal mientras editabas. Recarga la página para ver la versión actual.");
    const pages = isRecord(row?.value) ? row.value : {};
    const page = isRecord(pages[TEAM_PAGE]) ? pages[TEAM_PAGE] : {};
    const value = { ...pages, [TEAM_PAGE]: { ...page, team } } as unknown as Prisma.InputJsonValue;
    const saved = await tx.setting.upsert({ where: { key: KEY }, create: { key: KEY, value, description: "Contenido editorial de las páginas de la tienda" }, update: { value } });
    const prev = readTeam(page.team);
    await recordAudit(tx, { actor, action: "store.team.update", entityType: "Setting", entityId: `${KEY}:${TEAM_PAGE}.team`, before: prev, after: team, note });
    return { before: prev, version: versionOf(saved) };
  });
  const used = new Set(team.members.map((m) => m.photo));
  for (const m of before.members) if (!used.has(m.photo)) await removeUploadedImage(d, m.photo, TEAM_DIR);
  await removeOrphanPhotos(d, used);
  return { team, version };
}

/** Sube una foto (se optimiza como las de los programas) y devuelve su URL para ponerla en el borrador. */
export async function uploadTeamPhoto(d: Deps, actor: SessionUser, input: { bytes: Uint8Array; name?: string }): Promise<{ url: string }> {
  actor = await requireAdmin(d.db, actor, "catalog.manage");
  const img = await storeOptimizedImage(d, TEAM_DIR, input.name?.trim() || "personal-ceium", input.bytes);
  return { url: img.url };
}

/** Borra las fotos de <uploads>/team/ que nadie usa y tienen más de un día (subidas y descartadas). */
async function removeOrphanPhotos(d: Deps, used: Set<string>) {
  const dir = path.resolve(d.config.publicUploadsDir, TEAM_DIR);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const usedStems = new Set([...used].flatMap((u) => (TEAM_PHOTO_RE.test(u) ? [u.slice(`${UPLOADS_URL}${TEAM_DIR}/`.length).replace(/-w\d+\.webp$/, "")] : [])));
  for (const name of names) {
    if (usedStems.has(name.replace(/-(w\d+\.webp|og\.jpg)$/, ""))) continue;
    const abs = path.join(dir, name);
    const st = await fs.stat(abs).catch(() => null);
    if (st?.isFile() && Date.now() - st.mtimeMs > ORPHAN_GRACE_MS) await fs.rm(abs, { force: true }).catch((e) => d.log.warn(`[about-team] no se pudo borrar ${abs}`, e));
  }
}
