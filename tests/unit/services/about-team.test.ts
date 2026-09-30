// Personal de «Quiénes somos» editable desde el panel (server/about-team.ts): quién edita, validación, versión
// (no pisar lo que guardó otra persona), qué muestra la tienda (ocultas y sin foto fuera) y las fotos subidas.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { getTeamSection, saveTeamSection, uploadTeamPhoto } from "@/server/about-team";
import { hashPassword, type SessionUser } from "@/server/auth";
import { SETTING_KEYS } from "@/server/settings";
import { DEFAULT_TEAM, publicTeam, readTeam, type TeamSection } from "@/components/store/pages/team";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let commercial: SessionUser;

async function member(email: string, role: AdminRole): Promise<SessionUser> {
  return ctx.db.adminUser.create({ data: { email, name: email.split("@")[0]!, role, passwordHash: await hashPassword("clave-larga-del-equipo-1") }, select: { id: true, email: true, name: true, role: true } });
}
const photo = () => sharp({ create: { width: 800, height: 800, channels: 3, background: "#3a7ca5" } }).jpeg().toBuffer().then((b) => new Uint8Array(b));
const uploadsDir = () => ctx.d.config.publicUploadsDir;
const fileOf = (url: string) => path.join(uploadsDir(), url.slice("/uploads/".length));
const pages = async () => (await ctx.db.setting.findUnique({ where: { key: SETTING_KEYS.storePages } }))?.value as Record<string, Record<string, unknown>> | undefined;

beforeEach(async () => {
  ctx = await setupContext("about-team");
  commercial = await member("ventas@ceium.net", "COMMERCIAL");
});
afterEach(async () => {
  await ctx.dispose();
});

describe("personal de Quiénes somos", () => {
  it("sin nada guardado muestra el equipo de ceium.net; todo el equipo lo ve, solo quien gestiona el catálogo lo edita", async () => {
    const { team, version } = await getTeamSection(ctx.d, ctx.fx.staff);
    expect(version).toBeNull();
    expect(team).toEqual(DEFAULT_TEAM);

    const edited: TeamSection = { ...team, members: team.members.slice(0, 2) };
    await expect(saveTeamSection(ctx.d, ctx.fx.staff, { team: edited, version })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(uploadTeamPhoto(ctx.d, ctx.fx.staff, { bytes: await photo() })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const saved = await saveTeamSection(ctx.d, commercial, { team: edited, version });
    expect(saved.team.members.map((m) => m.name)).toEqual(["Dr. Carlos Roa", "Dra. Mireya Montes de Oca"]);
    expect(saved.version).not.toBeNull();

    const log = await ctx.db.auditLog.findFirst({ where: { action: "store.team.update" } });
    expect(log).toMatchObject({ actorEmail: "ventas@ceium.net", entityType: "Setting" });
  });

  it("orden, ocultar y editar; la tienda no muestra a las ocultas; el resto de store.pages se conserva", async () => {
    await ctx.db.setting.create({ data: { key: SETTING_KEYS.storePages, value: { "preguntas-frecuentes": { title: "Dudas" }, "quienes-somos": { heading: "Desde 2002" } } } });
    const { team, version } = await getTeamSection(ctx.d, ctx.fx.admin);
    const [a, b, c, ...rest] = team.members;
    const edited = { title: "Nuestro equipo", text: "  Docentes y personal.  ", members: [c, { ...a, role: "Director fundador" }, { ...b, hidden: true }, ...rest] };
    await saveTeamSection(ctx.d, ctx.fx.admin, { team: edited, version });

    const v = await pages();
    expect(v?.["preguntas-frecuentes"]).toEqual({ title: "Dudas" });
    expect(v?.["quienes-somos"]?.heading).toBe("Desde 2002");
    const store = publicTeam(v?.["quienes-somos"]?.team);
    expect(store.title).toBe("Nuestro equipo");
    expect(store.text).toBe("Docentes y personal.");
    expect(store.members.map((m) => m.id)).toEqual([c.id, a.id, ...rest.map((m) => m.id)]);
    expect(store.members[1].role).toBe("Director fundador");
    // En el panel la oculta sigue en su lugar; solo se guarda `hidden` cuando es true.
    const again = await getTeamSection(ctx.d, ctx.fx.admin);
    expect(again.team.members[2]).toEqual({ ...b, hidden: true });
    expect(again.team.members[0]).not.toHaveProperty("hidden");
  });

  it("valida: nombre, título, foto de las visibles, direcciones de foto e identificadores", async () => {
    const { team, version } = await getTeamSection(ctx.d, ctx.fx.admin);
    const m = team.members[0];
    const bad = (patch: Partial<TeamSection>) => saveTeamSection(ctx.d, ctx.fx.admin, { team: { ...team, ...patch }, version });
    await expect(bad({ title: "  " })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("título") });
    await expect(bad({ members: [{ ...m, name: " " }] })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("nombre") });
    await expect(bad({ members: [{ ...m, photo: "" }] })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("Falta la foto de Dr. Carlos Roa") });
    await expect(bad({ members: [{ ...m, photo: "javascript:alert(1)" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(bad({ members: [{ ...m, photo: "http://insegura.test/foto.jpg" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(bad({ members: [{ ...m, photo: "/uploads/products/abc/foto-w640.webp" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(bad({ members: [m, { ...team.members[1], id: m.id }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(bad({ members: [{ ...m, extra: 1 } as never] })).rejects.toMatchObject({ code: "VALIDATION" });
    // Oculta y sin foto sí se puede guardar (se completa después).
    await expect(bad({ members: [{ ...m, photo: "", hidden: true }] })).resolves.toBeTruthy();
  });

  it("no pisa lo que guardó otra persona mientras tanto (versión)", async () => {
    const first = await getTeamSection(ctx.d, ctx.fx.admin);
    const second = await getTeamSection(ctx.d, commercial);
    const saved = await saveTeamSection(ctx.d, ctx.fx.admin, { team: { ...first.team, title: "A" }, version: first.version });
    await expect(saveTeamSection(ctx.d, commercial, { team: { ...second.team, title: "B" }, version: second.version })).rejects.toMatchObject({ code: "CONFLICT" });
    // Con la versión nueva, sí.
    await expect(saveTeamSection(ctx.d, commercial, { team: { ...saved.team, title: "B" }, version: saved.version })).resolves.toMatchObject({ team: { title: "B" } });
  });

  it("fotos: se suben optimizadas; al reemplazarlas o quitar a la persona se borran; las descartadas se limpian pasado un día", async () => {
    const bad = uploadTeamPhoto(ctx.d, ctx.fx.admin, { bytes: new TextEncoder().encode("<svg onload=alert(1)>") });
    await expect(bad).rejects.toMatchObject({ code: "VALIDATION" });

    const up1 = await uploadTeamPhoto(ctx.d, ctx.fx.admin, { bytes: await photo(), name: "Dra. Ana Pérez" });
    expect(up1.url).toMatch(/^\/uploads\/team\/dra-ana-perez-[0-9a-f]{8}-w960\.webp$/);
    expect(fs.existsSync(fileOf(up1.url))).toBe(true);
    expect(fs.existsSync(fileOf(up1.url).replace(/-w960\.webp$/, "-w320.webp"))).toBe(true);

    const { team, version } = await getTeamSection(ctx.d, ctx.fx.admin);
    const ana = { id: "p-ana", name: "Dra. Ana Pérez", role: "Docente", photo: up1.url };
    let saved = await saveTeamSection(ctx.d, ctx.fx.admin, { team: { ...team, members: [...team.members, ana] }, version });
    expect(publicTeam((await pages())?.["quienes-somos"]?.team).members.at(-1)).toEqual(ana);

    // Nueva foto: la anterior deja de usarse y se borra al guardar.
    const up2 = await uploadTeamPhoto(ctx.d, ctx.fx.admin, { bytes: await photo(), name: "Dra. Ana Pérez" });
    saved = await saveTeamSection(ctx.d, ctx.fx.admin, { team: { ...saved.team, members: saved.team.members.map((m) => (m.id === "p-ana" ? { ...m, photo: up2.url } : m)) }, version: saved.version });
    expect(fs.existsSync(fileOf(up1.url))).toBe(false);
    expect(fs.existsSync(fileOf(up2.url))).toBe(true);

    // Subida y descartada: se conserva el primer día (puede estar en el borrador de alguien) y luego se limpia.
    const abandoned = await uploadTeamPhoto(ctx.d, ctx.fx.admin, { bytes: await photo(), name: "Borrador" });
    saved = await saveTeamSection(ctx.d, ctx.fx.admin, { team: saved.team, version: saved.version });
    expect(fs.existsSync(fileOf(abandoned.url))).toBe(true);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const f of fs.readdirSync(path.join(uploadsDir(), "team"))) if (f.startsWith("borrador-")) fs.utimesSync(path.join(uploadsDir(), "team", f), old, old);
    saved = await saveTeamSection(ctx.d, ctx.fx.admin, { team: saved.team, version: saved.version });
    expect(fs.readdirSync(path.join(uploadsDir(), "team")).filter((f) => f.startsWith("borrador-"))).toEqual([]);
    expect(fs.existsSync(fileOf(up2.url))).toBe(true);

    // Quitar a la persona borra su foto.
    await saveTeamSection(ctx.d, ctx.fx.admin, { team: { ...saved.team, members: saved.team.members.filter((m) => m.id !== "p-ana") }, version: saved.version });
    expect(fs.existsSync(fileOf(up2.url))).toBe(false);
  });

  it("lee lo guardado antes del editor (sin id ni hidden) y la tienda descarta a quien no tiene foto", () => {
    const legacy = { members: [{ name: "Dra. Prueba", role: "Docente", photo: "https://cdn.shopify.com/x.jpg" }, { name: "" }, { name: "Sin foto", role: "", photo: "" }, "basura"] };
    const t = readTeam(legacy);
    expect(t.title).toBe(DEFAULT_TEAM.title);
    expect(t.members.map((m) => [m.id, m.name])).toEqual([["m1", "Dra. Prueba"], ["m3", "Sin foto"]]);
    expect(publicTeam(legacy).members.map((m) => m.name)).toEqual(["Dra. Prueba"]);
    expect(readTeam(undefined)).toEqual(DEFAULT_TEAM);
  });
});
