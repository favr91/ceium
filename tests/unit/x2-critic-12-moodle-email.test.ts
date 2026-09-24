// x2 (crítico 12): la cuenta de Moodle creada a mano con el correo escrito con CUALQUIER combinación de mayúsculas
// («dra.lOpez@gMail.com») se encuentra y se vincula: core_user_get_users busca por email sin distinguir mayúsculas
// (LIKE). Si el token no tiene esa función habilitada, se recurre a las variantes habituales; y si aun así Moodle
// rechaza crear la cuenta, el error es de validación (definitivo) y dice qué pasó.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMoodleMock } from "../../mocks/moodle/server.mjs";
import { MoodleClient, MoodleError } from "@/server/moodle";

const TOKEN = "t-x2c12";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moodle-x2c12-"));
const mock = createMoodleMock({ token: TOKEN, stateFile: path.join(dir, "state.json") });
let url = "";
let client: MoodleClient;
const ctl = (p: string, body?: unknown) =>
  fetch(`${url}/__mock/${p}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

beforeAll(async () => {
  url = await mock.listen(0);
  client = new MoodleClient({ baseUrl: url, token: TOKEN, timeoutMs: 1000 });
});
afterAll(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await ctl("reset", {});
});

async function manualAccount(email: string, username = "v12345678") {
  const [u] = await client.call<{ id: number }[]>("core_user_create_users", { users: [{ username, email, firstname: "Ana", lastname: "López", password: "Ceium-2025!", auth: "manual" }] });
  return u.id;
}
const accessDenied = (count = 5) =>
  ctl("fail-next", { wsfunction: "core_user_get_users", count, exception: "webservice_access_exception", errorcode: "accessexception", message: "Excepción al control de acceso" });

describe("mock: core_user_get_users como Moodle", () => {
  it("email con LIKE sin mayúsculas (% y _ comodines), username exacto, clave desconocida → warning", async () => {
    const id = await manualAccount("Dra.lOpez@gMail.com");
    const r = await client.call<{ users: { id: number }[]; warnings: unknown[] }>("core_user_get_users", { criteria: [{ key: "email", value: "dra.lopez@gmail.com" }] });
    expect(r.users.map((u) => u.id)).toEqual([id]);
    const like = await client.call<{ users: { id: number }[] }>("core_user_get_users", { criteria: [{ key: "email", value: "dra_lopez@%" }] });
    expect(like.users.map((u) => u.id)).toEqual([id]);
    const byUser = await client.call<{ users: unknown[] }>("core_user_get_users", { criteria: [{ key: "username", value: "V12345678" }] });
    expect(byUser.users).toEqual([]);
    const bad = await client.call<{ users: unknown[]; warnings: { warningcode: string }[] }>("core_user_get_users", { criteria: [{ key: "city", value: "x" }] });
    expect([bad.users, bad.warnings.map((w) => w.warningcode)]).toEqual([[], ["invalidfieldparameter"]]);
  });
});

describe("findOrCreateUser con una cuenta manual con otras mayúsculas", () => {
  for (const stored of ["Dra.lOpez@gMail.com", "DRA.lopez@Gmail.COM", "dRa.LoPeZ@GMAIL.com"]) {
    it(`encuentra «${stored}» buscando dra.lopez@gmail.com (no crea otra, no falla)`, async () => {
      const id = await manualAccount(stored);
      const r = await client.findOrCreateUser({ email: "dra.lopez@gmail.com", firstname: "Ana", lastname: "López" });
      expect([r.user.id, r.created, r.tempPassword]).toEqual([id, false, undefined]);
      const st = await ctl("state");
      expect(st.users.filter((u: { email: string }) => u.email.toLowerCase() === "dra.lopez@gmail.com")).toHaveLength(1);
    });
  }

  it("el comodín _ de LIKE no confunde a otra persona: draXlopez@… no es dra_lopez@…", async () => {
    await manualAccount("draXlopez@gmail.com", "otra");
    const r = await client.findOrCreateUser({ email: "dra_lopez@gmail.com", firstname: "Ana", lastname: "López" });
    expect(r.created).toBe(true);
    expect(r.user.email).toBe("dra_lopez@gmail.com");
  });

  it("sin permiso para core_user_get_users: recurre a las variantes habituales (Inicial mayúscula)", async () => {
    const id = await manualAccount("Dra.lopez@gmail.com");
    await accessDenied();
    const r = await client.findOrCreateUser({ email: "dra.lopez@gmail.com", firstname: "Ana", lastname: "López" });
    expect([r.user.id, r.created]).toEqual([id, false]);
  });

  it("sin permiso y con mayúsculas raras: error de VALIDACIÓN (definitivo) que explica que Moodle no aceptó crearla", async () => {
    await manualAccount("dra.lOpez@gmail.com");
    await accessDenied();
    const e = await client.findOrCreateUser({ email: "dra.lopez@gmail.com", firstname: "Ana", lastname: "López" }).catch((x) => x);
    expect(e).toBeInstanceOf(MoodleError);
    expect([e.kind, e.retryable, e.wsfunction]).toEqual(["validation", false, "core_user_create_users"]);
    expect(e.message).toMatch(/no aceptó crear la cuenta de dra\.lopez@gmail\.com/);
  });

  it("un token inválido o un fallo transitorio de core_user_get_users NO se trata como «sin permiso»", async () => {
    await ctl("fail-next", { wsfunction: "core_user_get_users", count: 1, type: "http", status: 503 });
    await expect(client.findOrCreateUser({ email: "x@example.com", firstname: "X", lastname: "Y" })).rejects.toMatchObject({ kind: "http", retryable: true });
    const bad = new MoodleClient({ baseUrl: url, token: "malo" });
    await expect(bad.findOrCreateUser({ email: "x@example.com", firstname: "X", lastname: "Y" })).rejects.toMatchObject({ errorcode: "invalidtoken" });
  });
});

describe("findUser (vincular a mano)", () => {
  it("por id, #id, email con cualquier mayúscula o username; null si no existe", async () => {
    const id = await manualAccount("Dra.lOpez@gMail.com", "v99887766");
    for (const ref of [String(id), `#${id}`, "dra.lopez@gmail.com", "DRA.LOPEZ@GMAIL.COM", "v99887766", " V99887766 "]) {
      expect((await client.findUser(ref))?.id, ref).toBe(id);
    }
    expect(await client.findUser("nadie@example.com")).toBeNull();
    expect(await client.findUser("99999")).toBeNull();
  });
});
