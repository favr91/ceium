// Protocolo crudo del mock de Moodle: codificación form-urlencoded, forma de respuestas y errores.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMoodleMock, parseNestedParams } from "../../mocks/moodle/server.mjs";

const TOKEN = "t-raw";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moodle-mock-"));
const stateFile = path.join(dir, "state.json");
const mock = createMoodleMock({ token: TOKEN, stateFile });
let url = "";

async function ws(fn: string, params: Record<string, string>, token = TOKEN) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json", ...params });
  const res = await fetch(`${url}/webservice/rest/server.php`, { method: "POST", body });
  expect(res.status).toBe(200);
  return res.json();
}
const ctl = (p: string, body?: unknown) =>
  fetch(`${url}/__mock/${p}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

beforeAll(async () => { url = await mock.listen(0); });
afterAll(async () => { await mock.close(); fs.rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { await ctl("reset", {}); });

const newUser = {
  "users[0][username]": "ana@example.com",
  "users[0][password]": "Temp#1234",
  "users[0][firstname]": "Ana",
  "users[0][lastname]": "Pérez",
  "users[0][email]": "ana@example.com",
  "users[0][auth]": "manual",
};

describe("mock moodle — protocolo", () => {
  it("parsea claves anidadas estilo PHP", () => {
    const p = parseNestedParams(new URLSearchParams("users[0][preferences][1][type]=x&values[0]=a&values[1]=b&field=email"));
    expect(p).toEqual({ users: { "0": { preferences: { "1": { type: "x" } } } }, values: { "0": "a", "1": "b" }, field: "email" });
  });

  it("token inválido → moodle_exception/invalidtoken con HTTP 200", async () => {
    expect(await ws("core_user_get_users_by_field", { field: "id", "values[0]": "2" }, "malo")).toEqual({
      exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token - token not found",
    });
  });

  it("función inexistente → dml_missing_record_exception", async () => {
    const r = await ws("core_no_existe", {});
    expect(r.exception).toBe("dml_missing_record_exception");
    expect(r.errorcode).toBe("invalidrecord");
  });

  it("core_user_create_users devuelve [{id, username}] y get_users_by_field la encuentra", async () => {
    const created = await ws("core_user_create_users", newUser);
    expect(created).toEqual([{ id: 3, username: "ana@example.com" }]);
    const found = await ws("core_user_get_users_by_field", { field: "email", "values[0]": "ana@example.com" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: 3, username: "ana@example.com", fullname: "Ana Pérez", auth: "manual", suspended: false });
  });

  it("errores de validación con la forma real (invalid_parameter_exception)", async () => {
    await ws("core_user_create_users", newUser);
    const dup = await ws("core_user_create_users", newUser);
    expect(dup).toEqual({
      exception: "invalid_parameter_exception", errorcode: "invalidparameter",
      message: "Invalid parameter value detected", debuginfo: "Username already exists: ana@example.com",
    });
    const missing = await ws("core_user_create_users", { "users[0][username]": "x@y.com", "users[0][firstname]": "X", "users[0][lastname]": "Y" });
    expect(missing.debuginfo).toBe("users => Invalid parameter value detected: 0 => Invalid parameter value detected: Missing required key in single structure: email");
    const nopw = await ws("core_user_create_users", { ...newUser, "users[0][username]": "b@example.com", "users[0][email]": "b@example.com", "users[0][password]": "" });
    expect(nopw.debuginfo).toBe("Invalid password: you must provide a password, or set createpassword.");
    const upper = await ws("core_user_create_users", { ...newUser, "users[0][username]": "Ana@example.com" });
    expect(upper.debuginfo).toBe("The username must be in lower case");
    const badInt = await ws("enrol_manual_enrol_users", { "enrolments[0][roleid]": "x", "enrolments[0][userid]": "3", "enrolments[0][courseid]": "101" });
    expect(badInt.errorcode).toBe("invalidparameter");
    expect(badInt.debuginfo).toContain('the server was expecting "int" type');
  });

  it("enrol_manual_enrol_users devuelve null y es idempotente; curso inexistente → invalidrecord", async () => {
    await ws("core_user_create_users", newUser);
    const e = { "enrolments[0][roleid]": "5", "enrolments[0][userid]": "3", "enrolments[0][courseid]": "101" };
    expect(await ws("enrol_manual_enrol_users", e)).toBeNull();
    expect(await ws("enrol_manual_enrol_users", e)).toBeNull();
    const st = await ctl("state");
    expect(st.enrolments).toHaveLength(1);
    const bad = await ws("enrol_manual_enrol_users", { ...e, "enrolments[0][courseid]": "9999" });
    expect(bad).toMatchObject({ exception: "dml_missing_record_exception", errorcode: "invalidrecord" });
  });

  it("core_completion_get_course_completion_status: forma real y /__mock/complete", async () => {
    await ws("core_user_create_users", newUser);
    const q = { courseid: "101", userid: "3" };
    expect(await ws("core_completion_get_course_completion_status", q)).toMatchObject({ errorcode: "usernotenroled", exception: "moodle_exception" });
    await ws("enrol_manual_enrol_users", { "enrolments[0][roleid]": "5", "enrolments[0][userid]": "3", "enrolments[0][courseid]": "101" });
    const before = await ws("core_completion_get_course_completion_status", q);
    expect(before.completionstatus.completed).toBe(false);
    expect(before.completionstatus.aggregation).toBe(1);
    expect(before.warnings).toEqual([]);
    expect(Object.keys(before.completionstatus.completions[0]).sort()).toEqual(["complete", "details", "status", "timecompleted", "title", "type"]);
    expect(Object.keys(before.completionstatus.completions[0].details).sort()).toEqual(["criteria", "requirement", "status", "type"]);
    await ctl("complete", { userid: 3, courseid: 101 });
    const after = await ws("core_completion_get_course_completion_status", q);
    expect(after.completionstatus.completed).toBe(true);
    expect(after.completionstatus.completions.every((c: { complete: boolean }) => c.complete)).toBe(true);
  });

  it("core_course_get_courses_by_field y core_user_update_users ({warnings})", async () => {
    const r = await ws("core_course_get_courses_by_field", { field: "ids", value: "101,102" });
    expect(r.courses.map((c: { id: number }) => c.id)).toEqual([101, 102]);
    expect(r.warnings).toEqual([]);
    expect(await ws("core_user_update_users", { "users[0][id]": "999", "users[0][firstname]": "Z" })).toEqual({
      warnings: [{ item: "user", itemid: 999, warningcode: "invaliduserid", message: "Invalid user ID" }],
    });
  });

  it("persiste el estado en el archivo JSON", async () => {
    await ws("core_user_create_users", newUser);
    const onDisk = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(onDisk.users.some((u: { username: string }) => u.username === "ana@example.com")).toBe(true);
    const again = createMoodleMock({ token: TOKEN, stateFile });
    expect(again.state.users.some((u: { username: string }) => u.username === "ana@example.com")).toBe(true);
  });
});
