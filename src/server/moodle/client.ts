// Cliente REST de Moodle (/webservice/rest/server.php) — solo funciones reales de la API:
// core_user_get_users_by_field, core_user_create_users, core_user_update_users,
// enrol_manual_enrol_users, enrol_manual_unenrol_users,
// core_completion_get_course_completion_status, core_course_get_courses_by_field.
//
// Protocolo: POST application/x-www-form-urlencoded con wstoken, wsfunction, moodlewsrestformat=json y
// parámetros anidados al estilo PHP (users[0][username]=..., enrolments[0][roleid]=5).
// Moodle responde HTTP 200 incluso en error: {"exception","errorcode","message","debuginfo"?}.
//
// Decisión de contraseña (passwordMode):
//   "temp" (por defecto): generamos una contraseña temporal que cumple la política por defecto de Moodle,
//     la enviamos en core_user_create_users junto con la preferencia auth_forcepasswordchange=1
//     (Moodle obliga a cambiarla en el primer acceso). La app la incluye en SU correo de acceso
//     ("contraseña temporal solo si la cuenta es nueva", SPEC.md) y nunca la guarda.
//   "moodle-email": createpassword=1 → Moodle genera la contraseña y envía él mismo el correo de
//     credenciales; tempPassword queda undefined y nuestro correo solo lleva usuario + enlace.
import { randomInt } from "node:crypto";
import { MoodleError } from "./errors";
import type {
  CourseCompletion,
  FindOrCreateUserResult,
  MoodleCompletionStatusResponse,
  MoodleCourse,
  MoodleUser,
  MoodleWarning,
} from "./types";

export type PasswordMode = "temp" | "moodle-email";

export interface MoodleClientOptions {
  /** URL base de Moodle, p.ej. https://aula.ceium.net (sin /webservice/...). */
  baseUrl: string;
  token: string;
  /** Timeout por petición (ms). Por defecto 15 s. */
  timeoutMs?: number;
  /** Rol de estudiante para enrol_manual_enrol_users (Moodle estándar: 5). */
  studentRoleId?: number;
  passwordMode?: PasswordMode;
  /** Inyectable para tests. */
  fetch?: typeof fetch;
}

export interface NewUserInput {
  email: string;
  firstname: string;
  lastname: string;
}

export interface EnrolOptions {
  roleId?: number;
  /** Segundos Unix. */
  timestart?: number;
  timeend?: number;
}

type Scalar = string | number | boolean;
type ParamValue = Scalar | null | undefined | ParamValue[] | { [k: string]: ParamValue };

/** Codifica un objeto como lo espera Moodle: arrays → [0], objetos → [clave], booleanos → 1/0. */
export function encodeMoodleParams(params: Record<string, ParamValue>, into = new URLSearchParams()): URLSearchParams {
  const walk = (key: string, v: ParamValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${key}[${i}]`, item));
    else if (typeof v === "object") for (const [k, sub] of Object.entries(v)) walk(`${key}[${k}]`, sub);
    else if (typeof v === "boolean") into.append(key, v ? "1" : "0");
    else into.append(key, String(v));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return into;
}

/** Contraseña temporal que cumple la política por defecto de Moodle (≥8, dígito, minúscula, mayúscula, símbolo). */
export function generateTempPassword(length = 12): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "#*-!%+"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < Math.max(8, length)) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export class MoodleClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  readonly studentRoleId: number;
  readonly passwordMode: PasswordMode;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MoodleClientOptions) {
    if (!opts.baseUrl) throw new Error("MoodleClient: falta baseUrl (MOODLE_URL)");
    if (!opts.token) throw new Error("MoodleClient: falta token (MOODLE_TOKEN)");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.studentRoleId = opts.studentRoleId ?? 5;
    this.passwordMode = opts.passwordMode ?? "temp";
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Llamada genérica a una función del web service. Lanza MoodleError. */
  async call<T>(wsfunction: string, params: Record<string, ParamValue> = {}): Promise<T> {
    const body = new URLSearchParams({ wstoken: this.token, wsfunction, moodlewsrestformat: "json" });
    encodeMoodleParams(params, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/webservice/rest/server.php`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      const aborted = controller.signal.aborted;
      throw new MoodleError({
        kind: aborted ? "timeout" : "network",
        wsfunction,
        message: aborted ? `sin respuesta en ${this.timeoutMs} ms` : `error de red: ${(e as Error).message}`,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new MoodleError({ kind: "http", wsfunction, status: res.status, message: `HTTP ${res.status}` });
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new MoodleError({
        kind: "protocol",
        wsfunction,
        status: res.status,
        message: `respuesta no JSON: ${text.slice(0, 120)}`,
        cause: e,
      });
    }
    if (data && typeof data === "object" && !Array.isArray(data) && "exception" in data && "errorcode" in data) {
      const d = data as { exception: string; errorcode: string; message?: string; debuginfo?: string };
      throw new MoodleError({
        kind: "moodle",
        wsfunction,
        exception: d.exception,
        errorcode: d.errorcode,
        debuginfo: d.debuginfo,
        message: d.message ?? d.errorcode,
      });
    }
    return data as T;
  }

  // ───────────── usuarios ─────────────

  async getUsersByField(field: "id" | "idnumber" | "username" | "email", values: (string | number)[]): Promise<MoodleUser[]> {
    if (!values.length) return [];
    return this.call<MoodleUser[]>("core_user_get_users_by_field", { field, values });
  }

  async getUserById(id: number): Promise<MoodleUser | null> {
    return (await this.getUsersByField("id", [id]))[0] ?? null;
  }

  /**
   * Busca por username (= email en minúsculas) y luego por email; si no existe, crea la cuenta
   * (auth manual). Idempotente y a prueba de carreras: si la creación falla por duplicado,
   * vuelve a buscar y devuelve la cuenta existente. Si la cuenta existe suspendida, la reactiva.
   */
  async findOrCreateUser(input: NewUserInput): Promise<FindOrCreateUserResult> {
    const email = input.email.trim();
    const username = email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Email inválido: ${input.email}`);

    const existing = await this.lookupUser(username, email);
    if (existing) return this.ensureActive(existing);

    const user: Record<string, ParamValue> = {
      username,
      auth: "manual",
      firstname: input.firstname.trim() || "-",
      lastname: input.lastname.trim() || "-",
      email,
    };
    let tempPassword: string | undefined;
    if (this.passwordMode === "temp") {
      tempPassword = generateTempPassword();
      user.password = tempPassword;
      user.preferences = [{ type: "auth_forcepasswordchange", value: 1 }];
    } else {
      user.createpassword = 1;
    }
    try {
      const created = await this.call<{ id: number; username: string }[]>("core_user_create_users", { users: [user] });
      const id = created?.[0]?.id;
      if (!id) throw new MoodleError({ kind: "protocol", wsfunction: "core_user_create_users", message: "respuesta sin id" });
      const full = await this.getUserById(id);
      return {
        user: full ?? { id, username, firstname: String(user.firstname), lastname: String(user.lastname), fullname: `${user.firstname} ${user.lastname}`, email, auth: "manual", suspended: false, confirmed: true },
        created: true,
        tempPassword,
      };
    } catch (e) {
      // Carrera (otra petición la creó) o email ya usado con otro username: Moodle devuelve
      // invalidparameter y, sin debug, no dice por qué → volver a buscar.
      if (e instanceof MoodleError && e.errorcode === "invalidparameter") {
        const again = await this.lookupUser(username, email);
        if (again) return this.ensureActive(again);
      }
      throw e;
    }
  }

  private async lookupUser(username: string, email: string): Promise<MoodleUser | null> {
    const byUsername = await this.getUsersByField("username", [username]);
    if (byUsername[0]) return byUsername[0];
    const candidates = email === username ? [email] : [email, username];
    const byEmail = await this.getUsersByField("email", candidates);
    return byEmail[0] ?? null;
  }

  private async ensureActive(user: MoodleUser): Promise<FindOrCreateUserResult> {
    if (!user.suspended) return { user, created: false };
    await this.updateUsers([{ id: user.id, suspended: 0 }]);
    return { user: { ...user, suspended: false }, created: false, reactivated: true };
  }

  /**
   * Fija una contraseña temporal nueva (política de Moodle) y obliga a cambiarla en el primer ingreso.
   * core_user_update_users no admite createpassword, así que se usa siempre la contraseña generada aquí.
   */
  async resetTempPassword(userId: number): Promise<string> {
    const password = generateTempPassword();
    await this.updateUsers([{ id: userId, password, preferences: [{ type: "auth_forcepasswordchange", value: 1 }] }]);
    return password;
  }

  /** core_user_update_users. Lanza si Moodle devuelve warnings (p.ej. invaliduserid). */
  async updateUsers(users: ({ id: number } & Record<string, ParamValue>)[]): Promise<void> {
    const res = await this.call<{ warnings?: MoodleWarning[] } | null>("core_user_update_users", { users });
    const w = res?.warnings ?? [];
    if (w.length) {
      throw new MoodleError({
        kind: "moodle",
        wsfunction: "core_user_update_users",
        exception: "warning",
        errorcode: w[0].warningcode,
        message: w.map((x) => `${x.itemid ?? ""} ${x.message}`.trim()).join("; "),
      });
    }
  }

  // ───────────── matrícula ─────────────

  /** Matricula (manual) al usuario en los cursos como estudiante. Idempotente: re-matricular no falla. */
  async enrol(userId: number, courseIds: number[], opts: EnrolOptions = {}): Promise<void> {
    const ids = [...new Set(courseIds)];
    if (!ids.length) return;
    const roleid = opts.roleId ?? this.studentRoleId;
    await this.call<null>("enrol_manual_enrol_users", {
      enrolments: ids.map((courseid) => ({ roleid, userid: userId, courseid, timestart: opts.timestart, timeend: opts.timeend })),
    });
  }

  /** Desmatricula (manual). No falla si el usuario no estaba matriculado. */
  async unenrol(userId: number, courseIds: number[]): Promise<void> {
    const ids = [...new Set(courseIds)];
    if (!ids.length) return;
    await this.call<null>("enrol_manual_unenrol_users", {
      enrolments: ids.map((courseid) => ({ userid: userId, courseid })),
    });
  }

  // ───────────── finalización ─────────────

  /**
   * Estado de finalización del curso para el usuario. Nunca devuelve completed=true salvo que Moodle
   * reporte completionstatus.completed === true. usernotenroled / nocriteriaset / completionnotenabled
   * se normalizan como no completado; el resto de errores se lanzan.
   */
  async getCompletion(userId: number, courseId: number): Promise<CourseCompletion> {
    const base = { userId, courseId, completions: [], timecompleted: null, completed: false } as const;
    try {
      const r = await this.call<MoodleCompletionStatusResponse>("core_completion_get_course_completion_status", {
        courseid: courseId,
        userid: userId,
      });
      if (!r?.completionstatus || typeof r.completionstatus.completed !== "boolean") {
        throw new MoodleError({ kind: "protocol", wsfunction: "core_completion_get_course_completion_status", message: "respuesta sin completionstatus" });
      }
      const completed = r.completionstatus.completed === true;
      const times = r.completionstatus.completions.map((c) => c.timecompleted ?? 0).filter((t) => t > 0);
      return {
        userId,
        courseId,
        state: completed ? "COMPLETE" : "INCOMPLETE",
        completed,
        timecompleted: completed && times.length ? Math.max(...times) : null,
        completions: r.completionstatus.completions,
      };
    } catch (e) {
      if (e instanceof MoodleError && e.kind === "moodle") {
        if (e.errorcode === "usernotenroled" || e.errorcode === "notenroled") return { ...base, completions: [], state: "NOT_ENROLLED" };
        if (e.errorcode === "nocriteriaset") return { ...base, completions: [], state: "NO_CRITERIA" };
        if (e.errorcode === "completionnotenabled") return { ...base, completions: [], state: "NOT_ENABLED" };
      }
      throw e;
    }
  }

  // ───────────── cursos ─────────────

  async getCourses(ids: number[]): Promise<MoodleCourse[]> {
    if (!ids.length) return [];
    const r = await this.call<{ courses: MoodleCourse[] }>("core_course_get_courses_by_field", { field: "ids", value: ids.join(",") });
    return r.courses;
  }

  async getCourse(id: number): Promise<MoodleCourse | null> {
    const r = await this.call<{ courses: MoodleCourse[] }>("core_course_get_courses_by_field", { field: "id", value: id });
    return r.courses[0] ?? null;
  }
}

let singleton: MoodleClient | null = null;

/** Cliente configurado desde env: MOODLE_URL, MOODLE_TOKEN, MOODLE_STUDENT_ROLE_ID, MOODLE_TIMEOUT_MS, MOODLE_PASSWORD_MODE. */
export function getMoodleClient(): MoodleClient {
  if (!singleton) {
    singleton = new MoodleClient({
      baseUrl: process.env.MOODLE_URL ?? "",
      token: process.env.MOODLE_TOKEN ?? "",
      studentRoleId: Number(process.env.MOODLE_STUDENT_ROLE_ID ?? 5),
      timeoutMs: process.env.MOODLE_TIMEOUT_MS ? Number(process.env.MOODLE_TIMEOUT_MS) : undefined,
      passwordMode: process.env.MOODLE_PASSWORD_MODE === "moodle-email" ? "moodle-email" : "temp",
    });
  }
  return singleton;
}

/** Solo tests. */
export function resetMoodleClientForTests(): void {
  singleton = null;
}
