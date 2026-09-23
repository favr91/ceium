// Cliente Moodle contra el mock (HTTP real, estado en archivo temporal).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMoodleMock } from "../../mocks/moodle/server.mjs";
import { MoodleClient, MoodleError, encodeMoodleParams, generateTempPassword } from "@/server/moodle";

const TOKEN = "t-client";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moodle-client-"));
const mock = createMoodleMock({ token: TOKEN, stateFile: path.join(dir, "state.json") });
let url = "";
let client: MoodleClient;

const ctl = (p: string, body?: unknown) =>
  fetch(`${url}/__mock/${p}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

beforeAll(async () => {
  url = await mock.listen(0);
  client = new MoodleClient({ baseUrl: url + "/", token: TOKEN, timeoutMs: 500 });
});
afterAll(async () => { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { await ctl("reset", {}); });

const ana = { email: "Ana.Perez@Example.com", firstname: "Ana", lastname: "Pérez" };

describe("encodeMoodleParams", () => {
  it("codifica arrays y objetos anidados como Moodle", () => {
    const p = encodeMoodleParams({ enrolments: [{ roleid: 5, userid: 3, courseid: 101, timestart: undefined }], flag: true });
    expect(p.toString()).toBe("enrolments%5B0%5D%5Broleid%5D=5&enrolments%5B0%5D%5Buserid%5D=3&enrolments%5B0%5D%5Bcourseid%5D=101&flag=1");
  });
  it("contraseña temporal cumple la política de Moodle", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTempPassword();
      expect(pw).toMatch(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[^a-zA-Z0-9]).{12}$/);
    }
  });
});

describe("findOrCreateUser", () => {
  it("crea la cuenta nueva (username = email en minúsculas, auth manual, temp password + cambio forzado)", async () => {
    const r = await client.findOrCreateUser(ana);
    expect(r.created).toBe(true);
    expect(r.tempPassword).toBeTruthy();
    expect(r.user).toMatchObject({ username: "ana.perez@example.com", email: "Ana.Perez@Example.com", auth: "manual", firstname: "Ana" });
    const st = await ctl("state");
    const u = st.users.find((x: { id: number }) => x.id === r.user.id);
    expect(u.password).toBe(r.tempPassword);
    expect(u.preferences.auth_forcepasswordchange).toBe("1");
  });

  it("idempotente: la segunda vez devuelve la misma cuenta sin contraseña", async () => {
    const a = await client.findOrCreateUser(ana);
    const b = await client.findOrCreateUser({ ...ana, email: "ana.perez@example.com" });
    expect(b.created).toBe(false);
    expect(b.tempPassword).toBeUndefined();
    expect(b.user.id).toBe(a.user.id);
    expect((await ctl("state")).users).toHaveLength(3);
  });

  it("llamadas concurrentes no duplican la cuenta", async () => {
    const rs = await Promise.all([client.findOrCreateUser(ana), client.findOrCreateUser(ana), client.findOrCreateUser(ana)]);
    expect(new Set(rs.map((r) => r.user.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect((await ctl("state")).users).toHaveLength(3);
  });

  it("encuentra por email una cuenta existente con otro username", async () => {
    await client.call("core_user_create_users", {
      users: [{ username: "aperez", password: "Xx#12345", firstname: "Ana", lastname: "P", email: "ana.perez@example.com" }],
    });
    const r = await client.findOrCreateUser({ ...ana, email: "ana.perez@example.com" });
    expect(r.created).toBe(false);
    expect(r.user.username).toBe("aperez");
  });

  it("reactiva una cuenta suspendida", async () => {
    const a = await client.findOrCreateUser(ana);
    await client.updateUsers([{ id: a.user.id, suspended: 1 }]);
    const b = await client.findOrCreateUser(ana);
    expect(b.reactivated).toBe(true);
    expect((await client.getUserById(a.user.id))?.suspended).toBe(false);
  });

  it("modo moodle-email usa createpassword=1 y no devuelve contraseña", async () => {
    const c = new MoodleClient({ baseUrl: url, token: TOKEN, passwordMode: "moodle-email" });
    const r = await c.findOrCreateUser(ana);
    expect(r.created).toBe(true);
    expect(r.tempPassword).toBeUndefined();
    expect((await ctl("state")).sentMail).toHaveLength(1);
  });
});

describe("enrol / unenrol", () => {
  it("matricula como estudiante (rol 5) en varios cursos y es idempotente", async () => {
    const { user } = await client.findOrCreateUser(ana);
    await client.enrol(user.id, [101, 102, 102]);
    await client.enrol(user.id, [101, 102]);
    const st = await ctl("state");
    expect(st.enrolments.map((e: { courseid: number; roleid: number }) => [e.courseid, e.roleid])).toEqual([[101, 5], [102, 5]]);
  });

  it("curso inexistente → MoodleError no reintentable, sin matrículas parciales", async () => {
    const { user } = await client.findOrCreateUser(ana);
    const err = await client.enrol(user.id, [101, 9999]).catch((e) => e);
    expect(err).toBeInstanceOf(MoodleError);
    expect(err).toMatchObject({ kind: "moodle", exception: "dml_missing_record_exception", errorcode: "invalidrecord", retryable: false });
    expect((await ctl("state")).enrolments).toHaveLength(0);
  });

  it("instancia manual deshabilitada → wsnoinstance", async () => {
    await ctl("course", { id: 200, manualEnrol: false });
    const { user } = await client.findOrCreateUser(ana);
    await expect(client.enrol(user.id, [200])).rejects.toMatchObject({ errorcode: "wsnoinstance" });
  });

  it("unenrol quita la matrícula y repetirlo no falla", async () => {
    const { user } = await client.findOrCreateUser(ana);
    await client.enrol(user.id, [101, 102]);
    await client.unenrol(user.id, [101]);
    await client.unenrol(user.id, [101]);
    expect((await ctl("state")).enrolments.map((e: { courseid: number }) => e.courseid)).toEqual([102]);
  });
});

describe("getCompletion", () => {
  it("no completado → completado solo tras marcarlo en Moodle", async () => {
    const { user } = await client.findOrCreateUser(ana);
    expect((await client.getCompletion(user.id, 101)).state).toBe("NOT_ENROLLED");
    await client.enrol(user.id, [101]);
    const before = await client.getCompletion(user.id, 101);
    expect(before).toMatchObject({ state: "INCOMPLETE", completed: false, timecompleted: null });
    expect(before.completions.length).toBeGreaterThan(0);
    await ctl("complete", { userid: user.id, courseid: 101 });
    const after = await client.getCompletion(user.id, 101);
    expect(after).toMatchObject({ state: "COMPLETE", completed: true });
    expect(after.timecompleted).toBeGreaterThan(0);
  });

  it("curso sin criterios o sin finalización habilitada → no completado", async () => {
    const { user } = await client.findOrCreateUser(ana);
    await ctl("course", { id: 201, criteria: [] });
    await ctl("course", { id: 202, enablecompletion: 0 });
    await client.enrol(user.id, [201, 202]);
    expect(await client.getCompletion(user.id, 201)).toMatchObject({ state: "NO_CRITERIA", completed: false });
    expect(await client.getCompletion(user.id, 202)).toMatchObject({ state: "NOT_ENABLED", completed: false });
  });
});

describe("errores y transporte", () => {
  it("token inválido → invalidtoken (no reintentable)", async () => {
    const bad = new MoodleClient({ baseUrl: url, token: "nope" });
    await expect(bad.getCourses([101])).rejects.toMatchObject({ kind: "moodle", errorcode: "invalidtoken", retryable: false });
  });

  it("HTTP 503 → kind http, reintentable; la siguiente llamada funciona", async () => {
    await ctl("fail-next", { type: "http", status: 503, wsfunction: "enrol_manual_enrol_users" });
    const { user } = await client.findOrCreateUser(ana);
    await expect(client.enrol(user.id, [101])).rejects.toMatchObject({ kind: "http", status: 503, retryable: true });
    await client.enrol(user.id, [101]);
    expect((await ctl("state")).enrolments).toHaveLength(1);
  });

  it("timeout → kind timeout, reintentable", async () => {
    await ctl("fail-next", { type: "timeout" });
    await expect(client.getCourses([101])).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });

  it("respuesta no JSON → kind protocol", async () => {
    await ctl("fail-next", { type: "garbage" });
    await expect(client.getCourse(101)).rejects.toMatchObject({ kind: "protocol" });
  });

  it("excepción de BD inyectada → kind moodle reintentable (dmlreadexception)", async () => {
    await ctl("fail-next", {});
    await expect(client.getCourse(101)).rejects.toMatchObject({ kind: "moodle", errorcode: "dmlreadexception", retryable: true });
  });

  it("servidor caído → kind network", async () => {
    const down = new MoodleClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN });
    await expect(down.getCourse(101)).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("getCourses devuelve los cursos pedidos", async () => {
    const cs = await client.getCourses([101, 126]);
    expect(cs.map((c) => c.id)).toEqual([101, 126]);
    expect(await client.getCourse(9999)).toBeNull();
  });
});
