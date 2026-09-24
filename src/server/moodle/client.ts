// Cliente REST de Moodle (/webservice/rest/server.php) — solo funciones reales de la API:
// core_user_get_users (búsqueda por email sin mayúsculas), core_user_get_users_by_field, core_user_create_users, core_user_update_users,
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

/**
 * Username válido para Moodle derivado del email: minúsculas, sin acentos y solo [a-z0-9_.@-]
 * (lo que Moodle acepta con extendedusernamechars desactivado, su valor por defecto). Máx. 100 caracteres.
 */
export function usernameFromEmail(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^-.@_a-z0-9]/g, "_")
    .slice(0, 100);
}

/**
 * Formas habituales de escribir un email con mayúsculas, para buscar la cuenta de Moodle. Moodle busca por email
 * EXACTO (core_user_get_users_by_field → get_records_list: en Postgres distingue mayúsculas), pero se niega a crear
 * otra cuenta con el mismo email sin distinguirlas («Email address already exists»). Las cuentas dadas de alta a
 * mano en el flujo anterior (Google Form → staff) guardan el correo como lo escribió el médico en el teléfono
 * («Dra.Lopez@Gmail.com») y la tienda lo guarda en minúsculas: sin esto, el médico que pagó quedaba sin matrícula
 * (error permanente) aunque su cuenta existe. Local: tal cual, minúsculas, Inicial, Cada.Parte, MAYÚSCULAS;
 * dominio: tal cual, minúsculas, Inicial, MAYÚSCULAS (≤ 20 valores, una sola llamada).
 */
export function emailCaseVariants(email: string): string[] {
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return [e];
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lo = local.toLowerCase();
  const dlo = domain.toLowerCase();
  const locals = [local, lo, cap(lo), lo.replace(/(^|[._-])(\p{Ll})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase()), lo.toUpperCase()];
  const domains = [domain, dlo, cap(dlo), dlo.toUpperCase()];
  const out = new Set<string>();
  for (const l of locals) for (const d of domains) out.add(`${l}@${d}`);
  return [...out];
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
   * Busca la cuenta del cliente y, si no existe, la crea (auth manual). Idempotente y a prueba de carreras.
   *  1. Por email (autoritativo; se prueban el email tal cual y en minúsculas).
   *  2. Por username derivado del email (usernameFromEmail): Moodle solo admite [a-z0-9_.@-], así que
   *     medico+ceium@gmail.com → medico_ceium@gmail.com. Una cuenta con ese username solo se acepta si
   *     su email es el mismo (el username nunca basta, aunque coincida con el email del comprador);
   *     si es de OTRA persona se prueba medico_ceium@gmail.com-2, -3…
   * Si la cuenta existe suspendida, la reactiva. Email inválido → MoodleError "validation" (no reintentable).
   */
  async findOrCreateUser(input: NewUserInput, hooks: { beforeCreate?: () => Promise<void> } = {}): Promise<FindOrCreateUserResult> {
    const email = input.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new MoodleError({ kind: "validation", wsfunction: "core_user_create_users", message: `email inválido: ${input.email}` });
    }
    const found = await this.lookupUser(email);
    if (found.user) return this.ensureActive(found.user);
    const username = found.freeUsername;

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
    // Quien llama registra el intento ANTES de crear: si la respuesta se pierde (timeout, 5xx tras crear),
    // el siguiente intento encontrará la cuenta (created=false) y sabrá que nunca recibió su contraseña.
    await hooks.beforeCreate?.();
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
      // Carrera (otra petición la creó) o email ya usado: Moodle devuelve invalidparameter y, sin debug,
      // no dice por qué → volver a buscar.
      if (e instanceof MoodleError && e.errorcode === "invalidparameter") {
        const again = await this.lookupUser(email);
        if (again.user) return this.ensureActive(again.user);
        // Moodle rechazó la cuenta nueva y no hay ninguna con este email que podamos ver: sin modo debug Moodle no
        // dice por qué (casi siempre «Email address already exists» con otras mayúsculas cuando el token no puede
        // usar core_user_get_users, o un dato que Moodle no admite). Reintentar no lo arregla.
        throw new MoodleError({
          kind: "validation",
          wsfunction: "core_user_create_users",
          message: `Moodle no aceptó crear la cuenta de ${email} y no se encontró ninguna cuenta con ese correo (${e.short})`,
          cause: e,
        });
      }
      throw e;
    }
  }

  /**
   * Cuentas cuyo email coincide SIN distinguir mayúsculas: core_user_get_users con criterio email usa
   * `$DB->sql_like(email, :email, false)` (LIKE sin distinguir mayúsculas), así que encuentra «Dra.Lopez@Gmail.com»,
   * «dra.lOpez@gmail.com» o cualquier otra forma. `_` y `%` son comodines de LIKE: el resultado se filtra aquí por
   * igualdad exacta sin mayúsculas. Devuelve null si el servicio web de Moodle no tiene habilitada la función
   * (webservice_access_exception) → quien llama recurre a core_user_get_users_by_field con las variantes habituales.
   */
  async searchUsersByEmailCaseless(email: string): Promise<MoodleUser[] | null> {
    const lower = email.trim().toLowerCase();
    try {
      const r = await this.call<{ users?: MoodleUser[] }>("core_user_get_users", { criteria: [{ key: "email", value: email.trim() }] });
      return (r?.users ?? []).filter((u) => u.email?.toLowerCase() === lower);
    } catch (e) {
      if (e instanceof MoodleError && e.kind === "moodle" && !e.retryable && e.errorcode !== "invalidtoken") return null;
      throw e;
    }
  }

  /**
   * Cuenta de Moodle indicada por el staff para vincularla a un cliente: id numérico («1234» o «#1234»), email
   * (sin distinguir mayúsculas) o username. null si no existe.
   */
  async findUser(ref: string): Promise<MoodleUser | null> {
    const r = ref.trim().replace(/^#/, "");
    if (!r) return null;
    if (/^\d+$/.test(r)) return this.getUserById(Number(r));
    if (r.includes("@")) {
      const lower = r.toLowerCase();
      const byEmail =
        (await this.searchUsersByEmailCaseless(r)) ??
        (await this.getUsersByField("email", emailCaseVariants(r))).filter((u) => u.email?.toLowerCase() === lower);
      if (byEmail.length) return byEmail.find((u) => u.email === r) ?? byEmail[0];
    }
    return (await this.getUsersByField("username", [r.toLowerCase()]))[0] ?? null;
  }

  /** Cuenta existente del email, o el primer username derivado libre para crearla. */
  private async lookupUser(email: string): Promise<{ user: MoodleUser | null; freeUsername: string }> {
    const lower = email.toLowerCase();
    // Moodle rechaza crear otra cuenta con el mismo email sin distinguir mayúsculas: la búsqueda tampoco debe
    // distinguirlas. core_user_get_users (LIKE sin mayúsculas) es completa; si el token no la tiene habilitada,
    // core_user_get_users_by_field (email EXACTO) con las mayúsculas habituales (ver emailCaseVariants).
    const byEmail =
      (await this.searchUsersByEmailCaseless(email)) ??
      (await this.getUsersByField("email", emailCaseVariants(email))).filter((u) => u.email?.toLowerCase() === lower);
    const base = usernameFromEmail(email);
    const match = byEmail.find((u) => u.email === email) ?? byEmail.find((u) => u.email === lower) ?? byEmail[0];
    if (match) return { user: match, freeUsername: base };
    for (let i = 1; i <= 20; i++) {
      const candidate = i === 1 ? base : `${base.slice(0, 96)}-${i}`;
      const [u] = await this.getUsersByField("username", [candidate]);
      if (!u) return { user: null, freeUsername: candidate };
      // Solo se acepta la cuenta si su EMAIL es el del comprador. El username no identifica a nadie:
      // medico+x@gmail.com se guarda como medico_x@gmail.com, que puede ser el email real de otra persona.
      if (u.email?.toLowerCase() === lower) return { user: u, freeUsername: candidate };
    }
    throw new MoodleError({ kind: "validation", wsfunction: "core_user_create_users", message: `no hay un username libre para ${email}` });
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
   * reporte completionstatus.completed === true. Errores reales de core_completion_external:
   * nottracked (no matriculado) / nocriteriaset / completionnotenabled
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
        if (e.errorcode === "nottracked") return { ...base, completions: [], state: "NOT_ENROLLED" };
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
