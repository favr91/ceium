#!/usr/bin/env node
// Mock de Moodle — implementa /webservice/rest/server.php con el mismo protocolo que Moodle real:
//   POST/GET form-urlencoded, wstoken, wsfunction, moodlewsrestformat=json,
//   parámetros anidados (users[0][username]=..., enrolments[0][roleid]=5, values[0]=...),
//   errores con HTTP 200 y cuerpo {"exception","errorcode","message","debuginfo"} (debuginfo como con debug activado).
//
// Funciones (las únicas que usa la app, ver SPEC.md):
//   core_user_get_users_by_field, core_user_create_users, core_user_update_users,
//   enrol_manual_enrol_users, enrol_manual_unenrol_users,
//   core_completion_get_course_completion_status, core_course_get_courses_by_field
//
// API de control para tests (JSON):
//   GET  /health
//   GET  /__mock/state                         → estado completo
//   POST /__mock/reset        {courses?}       → estado inicial (cursos 101..128 por defecto: 26 cursos + 2 niveles del taller transfontanelar)
//   POST /__mock/complete     {userid, courseid, completed?=true}
//   POST /__mock/course       {id, fullname?, shortname?, enablecompletion?, criteria?, manualEnrol?}
//   POST /__mock/fail-next    {wsfunction?, count?=1, type?: "exception"|"http"|"timeout"|"garbage",
//                              exception?, errorcode?, message?, status?, delayMs?}
//   GET  /__mock/calls                         → últimas llamadas recibidas (wsfunction + params)
//
// Env: MOCK_MOODLE_PORT (4010, igual que .env/playwright), MOCK_MOODLE_TOKEN o MOODLE_TOKEN
//      ("mock-moodle-token"), MOCK_MOODLE_STATE (var/mock-moodle/state.json).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_FILE = path.resolve(here, '../../var/mock-moodle/state.json');
const DEFAULT_COURSE_IDS = Array.from({ length: 28 }, (_, i) => 101 + i);
const ASSIGNABLE_ROLES = new Set([3, 4, 5]); // editingteacher, teacher, student
const VALID_AUTHS = new Set(['manual', 'nologin', 'email', 'oauth2', 'webservice']);

// ───────────────────────── errores al estilo Moodle ─────────────────────────
class MoodleException extends Error {
  constructor(exception, errorcode, message, debuginfo) {
    super(message);
    this.exception = exception;
    this.errorcode = errorcode;
    this.debuginfo = debuginfo;
  }
  toJSON() {
    const o = { exception: this.exception, errorcode: this.errorcode, message: this.message };
    if (this.debuginfo) o.debuginfo = this.debuginfo;
    return o;
  }
}
const invalidParam = (debuginfo) =>
  new MoodleException('invalid_parameter_exception', 'invalidparameter', 'Invalid parameter value detected', debuginfo);
const missingRecord = (table) =>
  new MoodleException('dml_missing_record_exception', 'invalidrecord', `Can't find data record in database table ${table}.`);
const moodleEx = (errorcode, message, debuginfo) => new MoodleException('moodle_exception', errorcode, message, debuginfo);

// ───────────────────────── parser de parámetros anidados ─────────────────────────
/** "users[0][preferences][1][type]" → ["users","0","preferences","1","type"] */
function splitKey(key) {
  const m = key.match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
  if (!m) return [key];
  const parts = [m[1]];
  for (const seg of m[2].matchAll(/\[([^[\]]*)\]/g)) parts.push(seg[1]);
  return parts;
}
export function parseNestedParams(searchParams) {
  const root = {};
  for (const [key, value] of searchParams) {
    const parts = splitKey(key);
    let node = root;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = value;
      else {
        if (node[p] === undefined || typeof node[p] !== 'object') node[p] = {};
        node = node[p];
      }
    });
  }
  return root;
}

// ───────────────────────── validación estilo external_api ─────────────────────────
const V = {
  int: (required = true, dflt) => ({ t: 'int', required, dflt }),
  bool: (required = true, dflt) => ({ t: 'bool', required, dflt }),
  text: (required = true, dflt) => ({ t: 'text', required, dflt }),
  single: (keys, required = true) => ({ t: 'single', keys, required }),
  multiple: (of, required = true) => ({ t: 'multiple', of, required }),
};
function wrap(key, inner) { return `${key} => Invalid parameter value detected: ${inner}`; }
function validate(schema, value) {
  switch (schema.t) {
    case 'int': {
      if (typeof value === 'object' || !/^-?\d+$/.test(String(value)))
        throw invalidParam(`Invalid external api parameter: the value is "${typeof value === 'object' ? 'array' : value}", the server was expecting "int" type`);
      return Number(value);
    }
    case 'bool': {
      const s = String(value).toLowerCase();
      if (typeof value === 'object' || !['0', '1', 'true', 'false'].includes(s))
        throw invalidParam(`Invalid external api parameter: the value is "${value}", the server was expecting "bool" type`);
      return s === '1' || s === 'true';
    }
    case 'text': {
      if (typeof value === 'object') throw invalidParam('Invalid external api parameter: the value is "array", the server was expecting "raw" type');
      return String(value);
    }
    case 'single': {
      if (value === null || typeof value !== 'object')
        throw invalidParam('Only arrays accepted. The bad value is: \'' + value + '\'');
      const out = {};
      for (const [k, sub] of Object.entries(schema.keys)) {
        if (value[k] === undefined) {
          if (sub.required && sub.dflt === undefined) throw invalidParam(`Missing required key in single structure: ${k}`);
          if (sub.dflt !== undefined) out[k] = sub.dflt;
          continue;
        }
        try { out[k] = validate(sub, value[k]); }
        catch (e) { throw invalidParam(wrap(k, e.debuginfo ?? e.message)); }
      }
      const extra = Object.keys(value).filter((k) => !(k in schema.keys));
      if (extra.length) throw invalidParam(`Unexpected keys (${extra.join(', ')}) detected in parameter array.`);
      return out;
    }
    case 'multiple': {
      if (value === null || typeof value !== 'object')
        throw invalidParam('Only arrays accepted. The bad value is: \'' + value + '\'');
      return Object.keys(value)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => {
          try { return validate(schema.of, value[k]); }
          catch (e) { throw invalidParam(wrap(k, e.debuginfo ?? e.message)); }
        });
    }
  }
  throw new Error('schema desconocido');
}
/** Valida los parámetros de primer nivel igual que external_api::validate_parameters. */
function validateTop(keys, params) {
  const out = {};
  for (const [k, sub] of Object.entries(keys)) {
    if (params[k] === undefined) {
      if (sub.required && sub.dflt === undefined) throw invalidParam(`Missing required key in single structure: ${k}`);
      if (sub.dflt !== undefined) out[k] = sub.dflt;
      continue;
    }
    try { out[k] = validate(sub, params[k]); }
    catch (e) { throw invalidParam(wrap(k, e.debuginfo ?? e.message)); }
  }
  const extra = Object.keys(params).filter((k) => !(k in keys));
  if (extra.length) throw invalidParam(`Unexpected keys (${extra.join(', ')}) detected in parameter array.`);
  return out;
}

// ───────────────────────── estado ─────────────────────────
function makeCourse(id, extra = {}) {
  return {
    id,
    fullname: extra.fullname ?? `Curso ${id}`,
    shortname: extra.shortname ?? `C${id}`,
    categoryid: extra.categoryid ?? 1,
    categoryname: extra.categoryname ?? 'CEIUM',
    idnumber: extra.idnumber ?? '',
    summary: extra.summary ?? '',
    visible: extra.visible ?? 1,
    startdate: extra.startdate ?? 1790000000,
    enddate: extra.enddate ?? 0,
    enablecompletion: extra.enablecompletion ?? 1,
    manualEnrol: extra.manualEnrol ?? true,
    // Criterios de finalización (aggregation 1 = TODOS).
    criteria: extra.criteria ?? [
      { type: 4, title: 'Finalización de actividad', criteria: 'Evaluación final', requirement: 'Marcar como completada' },
      { type: 6, title: 'Calificación del curso', criteria: 'Calificación del curso', requirement: 'Calificación mínima: 70.00' },
    ],
  };
}
export function initialState(courseIds = DEFAULT_COURSE_IDS) {
  return {
    nextUserId: 3,
    users: [
      { id: 1, username: 'guest', firstname: 'Guest user', lastname: ' ', email: 'root@localhost', auth: 'manual', suspended: 0, confirmed: 1, deleted: 0, password: null, preferences: {}, createdAt: 0 },
      { id: 2, username: 'admin', firstname: 'Admin', lastname: 'User', email: 'admin@moodle.test', auth: 'manual', suspended: 0, confirmed: 1, deleted: 0, password: null, preferences: {}, createdAt: 0 },
    ],
    courses: courseIds.map((id) => makeCourse(id)),
    /** { userid, courseid, roleid, status: 0 activo | 1 suspendido, timestart, timeend } */
    enrolments: [],
    /** { userid, courseid, timecompleted } */
    completions: [],
    /** correos que Moodle "habría enviado" (createpassword=1) */
    sentMail: [],
  };
}

export function createMoodleMock(opts = {}) {
  const token = opts.token ?? process.env.MOCK_MOODLE_TOKEN ?? process.env.MOODLE_TOKEN ?? 'mock-moodle-token';
  const stateFile = opts.stateFile ?? process.env.MOCK_MOODLE_STATE ?? DEFAULT_STATE_FILE;
  const persist = opts.persist ?? true;
  let state = loadState();
  let failQueue = [];
  const calls = [];

  function loadState() {
    if (persist) {
      try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* no existe o inválido */ }
    }
    return initialState(opts.courseIds);
  }
  function save() {
    if (!persist) return;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  }
  const now = () => Math.floor(Date.now() / 1000);
  const findUser = (id) => state.users.find((u) => u.id === id && !u.deleted);
  const findCourse = (id) => state.courses.find((c) => c.id === id);
  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    firstname: u.firstname,
    lastname: u.lastname,
    fullname: `${u.firstname} ${u.lastname}`.trim(),
    email: u.email,
    department: '',
    idnumber: u.idnumber ?? '',
    firstaccess: 0,
    lastaccess: 0,
    auth: u.auth,
    suspended: !!u.suspended,
    confirmed: !!u.confirmed,
    lang: 'es',
    theme: '',
    timezone: '99',
    mailformat: 1,
    description: '',
    descriptionformat: 1,
    profileimageurlsmall: 'http://localhost/theme/image.php/boost/core/1/u/f2',
    profileimageurl: 'http://localhost/theme/image.php/boost/core/1/u/f1',
    preferences: Object.entries(u.preferences ?? {}).map(([name, value]) => ({ name, value })),
  });

  // Política de contraseña por defecto de Moodle (passwordpolicy on).
  function checkPasswordPolicy(pw) {
    const errs = [];
    if (pw.length < 8) errs.push('Las contraseñas deben tener al menos 8 caracteres.');
    if ((pw.match(/\d/g) ?? []).length < 1) errs.push('Las contraseñas deben tener al menos 1 dígito(s).');
    if ((pw.match(/[a-z]/g) ?? []).length < 1) errs.push('Las contraseñas deben tener al menos 1 minúscula(s).');
    if ((pw.match(/[A-Z]/g) ?? []).length < 1) errs.push('Las contraseñas deben tener al menos 1 mayúscula(s).');
    if ((pw.match(/[^a-zA-Z0-9]/g) ?? []).length < 1) errs.push('Las contraseñas deben tener al menos 1 caracter(es) no alfanuméricos como *, -, o #.');
    return errs.join('<br />');
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const userFields = (required) => ({
    ...(required ? {} : { id: V.int() }),
    createpassword: V.int(false),
    username: V.text(required),
    auth: V.text(false, required ? 'manual' : undefined),
    password: V.text(false),
    firstname: V.text(required),
    lastname: V.text(required),
    email: V.text(required),
    suspended: V.int(false),
    idnumber: V.text(false),
    lang: V.text(false),
    city: V.text(false),
    country: V.text(false),
    timezone: V.text(false),
    maildisplay: V.int(false),
    description: V.text(false),
    preferences: V.multiple(V.single({ type: V.text(), value: V.text() }), false),
  });

  function validateUsername(username) {
    if (username !== username.toLowerCase()) throw invalidParam('The username must be in lower case');
    if (/[^-.@_a-z0-9]/.test(username))
      throw invalidParam('The username can only contain alphanumeric lowercase characters (letters and numbers), underscore (_), hyphen (-), period (.) or at symbol (@).');
  }

  const functions = {
    core_user_get_users_by_field(params) {
      const p = validateTop({ field: V.text(), values: V.multiple(V.text()) }, params);
      if (!['id', 'idnumber', 'username', 'email'].includes(p.field))
        throw invalidParam(`The search field '${p.field}' is not supported, look at the web service documentation`);
      const vals = new Set(p.values.map((v) => (p.field === 'id' ? Number(v) : v)));
      return state.users.filter((u) => !u.deleted && vals.has(u[p.field])).map(publicUser);
    },

    core_user_create_users(params) {
      const p = validateTop({ users: V.multiple(V.single(userFields(true))) }, params);
      // Moodle valida todo el lote dentro de una transacción: si uno falla, no se crea ninguno.
      const batchUsernames = new Set();
      for (const u of p.users) {
        for (const f of ['username', 'firstname', 'lastname', 'email'])
          if (!String(u[f] ?? '').trim()) throw invalidParam(`The field '${f}' cannot be blank`);
        validateUsername(u.username);
        if (state.users.some((x) => x.username === u.username && !x.deleted) || batchUsernames.has(u.username))
          throw invalidParam(`Username already exists: ${u.username}`);
        batchUsernames.add(u.username);
        if (!VALID_AUTHS.has(u.auth)) throw invalidParam(`Invalid authentication type: ${u.auth}`);
        if (!u.createpassword && !u.password && u.auth === 'manual')
          throw invalidParam('Invalid password: you must provide a password, or set createpassword.');
        if (!EMAIL_RE.test(u.email)) throw invalidParam(`Email address is invalid: ${u.email}`);
        // allowaccountssameemail = 0 (por defecto): comparación sin mayúsculas.
        if (state.users.some((x) => !x.deleted && x.email.toLowerCase() === u.email.toLowerCase()))
          throw invalidParam(`Email address already exists: ${u.email}`);
        if (u.password && !u.createpassword) {
          const err = checkPasswordPolicy(u.password);
          if (err) throw invalidParam(err);
        }
      }
      const created = [];
      for (const u of p.users) {
        const id = state.nextUserId++;
        const prefs = {};
        for (const pr of u.preferences ?? []) prefs[pr.type] = pr.value;
        const rec = {
          id, username: u.username, firstname: u.firstname, lastname: u.lastname, email: u.email,
          auth: u.auth, suspended: u.suspended ?? 0, confirmed: 1, deleted: 0, idnumber: u.idnumber ?? '',
          password: u.createpassword ? '(generada por Moodle)' : u.password, preferences: prefs, createdAt: now(),
        };
        if (u.createpassword) {
          rec.preferences.create_password = '1';
          state.sentMail.push({ to: u.email, subject: 'Nueva cuenta de usuario', userid: id, at: now() });
        }
        state.users.push(rec);
        created.push({ id, username: u.username });
      }
      save();
      return created;
    },

    core_user_update_users(params) {
      const p = validateTop({ users: V.multiple(V.single(userFields(false))) }, params);
      const warnings = [];
      for (const u of p.users) {
        const rec = findUser(u.id);
        if (!rec) {
          warnings.push({ item: 'user', itemid: u.id, warningcode: 'invaliduserid', message: 'Invalid user ID' });
          continue;
        }
        if (u.username !== undefined) {
          validateUsername(u.username);
          if (state.users.some((x) => x.id !== rec.id && x.username === u.username && !x.deleted)) {
            warnings.push({ item: 'user', itemid: u.id, warningcode: 'usernameexists', message: 'Username already exists: ' + u.username });
            continue;
          }
        }
        if (u.email !== undefined && !EMAIL_RE.test(u.email)) {
          warnings.push({ item: 'user', itemid: u.id, warningcode: 'useremailinvalid', message: 'Invalid email address' });
          continue;
        }
        if (u.password !== undefined) {
          const err = checkPasswordPolicy(u.password);
          if (err) { warnings.push({ item: 'user', itemid: u.id, warningcode: 'invalidpassword', message: err }); continue; }
        }
        for (const f of ['username', 'firstname', 'lastname', 'email', 'auth', 'suspended', 'password', 'idnumber'])
          if (u[f] !== undefined) rec[f] = u[f];
        for (const pr of u.preferences ?? []) rec.preferences[pr.type] = pr.value;
      }
      save();
      return { warnings };
    },

    enrol_manual_enrol_users(params) {
      const p = validateTop({
        enrolments: V.multiple(V.single({
          roleid: V.int(), userid: V.int(), courseid: V.int(),
          timestart: V.int(false), timeend: V.int(false), suspend: V.int(false),
        })),
      }, params);
      // Validación completa antes de escribir (Moodle usa una transacción delegada).
      for (const e of p.enrolments) {
        const course = findCourse(e.courseid);
        if (!course) throw missingRecord('course');
        if (!course.manualEnrol)
          throw moodleEx('wsnoinstance', `Manual enrolment plugin instance doesn't exist or is disabled for the course (id = ${e.courseid})`);
        if (!ASSIGNABLE_ROLES.has(e.roleid))
          throw moodleEx('wsusercannotassign', `You don't have the permission to assign this role (${e.roleid}) to this user (${e.userid}) in this course(${e.courseid}).`);
        if (!findUser(e.userid)) throw missingRecord('user');
      }
      for (const e of p.enrolments) {
        const existing = state.enrolments.find((x) => x.userid === e.userid && x.courseid === e.courseid);
        const status = e.suspend ? 1 : 0;
        if (existing) Object.assign(existing, { roleid: e.roleid, status, timestart: e.timestart ?? existing.timestart, timeend: e.timeend ?? existing.timeend });
        else state.enrolments.push({ userid: e.userid, courseid: e.courseid, roleid: e.roleid, status, timestart: e.timestart ?? 0, timeend: e.timeend ?? 0, timecreated: now() });
      }
      save();
      return null;
    },

    enrol_manual_unenrol_users(params) {
      const p = validateTop({
        enrolments: V.multiple(V.single({ userid: V.int(), courseid: V.int(), roleid: V.int(false) })),
      }, params);
      for (const e of p.enrolments) {
        const course = findCourse(e.courseid);
        if (!course) throw missingRecord('course');
        if (!course.manualEnrol)
          throw moodleEx('wsnoinstance', `Manual enrolment plugin instance doesn't exist or is disabled for the course (id = ${e.courseid})`);
        if (!findUser(e.userid)) throw invalidParam('User id not exist: ' + e.userid);
      }
      for (const e of p.enrolments)
        state.enrolments = state.enrolments.filter((x) => !(x.userid === e.userid && x.courseid === e.courseid));
      save();
      return null;
    },

    core_completion_get_course_completion_status(params) {
      const p = validateTop({ courseid: V.int(), userid: V.int() }, params);
      const course = findCourse(p.courseid);
      if (!course) throw missingRecord('course');
      if (!findUser(p.userid)) throw missingRecord('user');
      if (!course.enablecompletion) throw moodleEx('completionnotenabled', 'Completion is not enabled for this course');
      const enrolled = state.enrolments.some((x) => x.userid === p.userid && x.courseid === p.courseid && x.status === 0);
      if (!enrolled) throw moodleEx('usernotenroled', 'User is not enrolled in this course');
      if (!course.criteria.length) throw moodleEx('nocriteriaset', 'No criteria set for this course');
      const done = state.completions.find((x) => x.userid === p.userid && x.courseid === p.courseid);
      const completions = course.criteria.map((c) => ({
        type: c.type,
        title: c.title,
        status: done ? 'Sí' : 'No',
        complete: !!done,
        timecompleted: done ? done.timecompleted : null,
        details: { type: c.title, criteria: c.criteria, requirement: c.requirement, status: done ? 'Sí' : '' },
      }));
      return { completionstatus: { completed: !!done, aggregation: 1, completions }, warnings: [] };
    },

    core_course_get_courses_by_field(params) {
      const p = validateTop({ field: V.text(false, ''), value: V.text(false, '') }, params);
      let list = state.courses;
      switch (p.field) {
        case '': break;
        case 'id': list = list.filter((c) => c.id === Number(p.value)); break;
        case 'ids': { const ids = new Set(String(p.value).split(',').map(Number)); list = list.filter((c) => ids.has(c.id)); break; }
        case 'shortname': list = list.filter((c) => c.shortname === p.value); break;
        case 'idnumber': list = list.filter((c) => c.idnumber === p.value); break;
        case 'category': list = list.filter((c) => c.categoryid === Number(p.value)); break;
        default: throw invalidParam('Invalid field name');
      }
      const courses = list.map((c) => ({
        id: c.id, fullname: c.fullname, displayname: c.fullname, shortname: c.shortname,
        categoryid: c.categoryid, categoryname: c.categoryname, sortorder: 0,
        summary: c.summary, summaryformat: 1, summaryfiles: [], overviewfiles: [], showactivitydates: true,
        showcompletionconditions: true, contacts: [], enrollmentmethods: c.manualEnrol ? ['manual'] : [],
        idnumber: c.idnumber, format: 'topics', showgrades: 1, newsitems: 5, startdate: c.startdate, enddate: c.enddate,
        maxbytes: 0, showreports: 0, visible: c.visible, groupmode: 0, groupmodeforce: 0, defaultgroupingid: 0,
        enablecompletion: c.enablecompletion, completionnotify: 0, lang: '', theme: '', marker: 0, legacyfiles: 0,
        calendartype: '', timecreated: 1780000000, timemodified: 1780000000, requested: 0, cacherev: 1,
        filters: [], courseformatoptions: [],
      }));
      return { courses, warnings: [] };
    },
  };

  // ───────────────────────── HTTP ─────────────────────────
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body === undefined ? 'null' : JSON.stringify(body));
  };
  const xmlException = (ex) =>
    `<?xml version="1.0" encoding="UTF-8" ?>\n<EXCEPTION class="${ex.exception}">\n<ERRORCODE>${ex.errorcode}</ERRORCODE>\n<MESSAGE>${ex.message}</MESSAGE>\n</EXCEPTION>\n`;

  async function handleRest(req, res, url) {
    const body = req.method === 'POST' ? await readBody(req) : '';
    const sp = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(body)) sp.append(k, v);
    const all = parseNestedParams(sp);
    const { wstoken, wsfunction, moodlewsrestformat, ...params } = all;
    const json = moodlewsrestformat === 'json';
    calls.push({ at: Date.now(), wsfunction, params });
    if (calls.length > 200) calls.shift();

    const reply = (payload) => {
      if (payload instanceof MoodleException) {
        if (json) return sendJson(res, 200, payload.toJSON());
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        return res.end(xmlException(payload));
      }
      if (!json) {
        // Solo implementamos JSON; Moodle respondería XML.
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        return res.end('<?xml version="1.0" encoding="UTF-8" ?>\n<RESPONSE/>\n');
      }
      return sendJson(res, 200, payload);
    };

    // Fallos inyectados (antes de validar token, como un problema de red/servidor).
    const idx = failQueue.findIndex((f) => !f.wsfunction || f.wsfunction === wsfunction);
    if (idx >= 0) {
      const f = failQueue[idx];
      f.count -= 1;
      if (f.count <= 0) failQueue.splice(idx, 1);
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      switch (f.type ?? 'exception') {
        case 'timeout':
          return; // nunca responde (el socket queda abierto hasta que el cliente aborta)
        case 'http':
          res.writeHead(f.status ?? 503, { 'content-type': 'text/html' });
          return res.end('<html><body><h1>Service Unavailable</h1></body></html>');
        case 'garbage':
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end('<!DOCTYPE html><html><body>Error de lectura de la base de datos</body></html>');
        default:
          return reply(new MoodleException(f.exception ?? 'dml_read_exception', f.errorcode ?? 'dmlreadexception',
            f.message ?? 'Error reading from database', f.debuginfo));
      }
    }

    if (!wstoken || wstoken !== token)
      return reply(moodleEx('invalidtoken', 'Invalid token - token not found'));
    const fn = functions[wsfunction];
    if (!fn) return reply(missingRecord('external_functions'));
    try {
      return reply(fn(params));
    } catch (e) {
      if (e instanceof MoodleException) return reply(e);
      console.error(e);
      return reply(moodleEx('generalexceptionmessage', 'Excepción general: ' + e.message));
    }
  }

  async function handleControl(req, res, url) {
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'JSON inválido' }); } }
    switch (url.pathname) {
      case '/__mock/state': return sendJson(res, 200, state);
      case '/__mock/calls': return sendJson(res, 200, calls);
      case '/__mock/reset':
        state = initialState(body.courses ?? opts.courseIds);
        failQueue = [];
        calls.length = 0;
        save();
        return sendJson(res, 200, { ok: true });
      case '/__mock/complete': {
        const userid = Number(body.userid), courseid = Number(body.courseid);
        if (!findUser(userid) || !findCourse(courseid)) return sendJson(res, 404, { error: 'usuario o curso inexistente' });
        state.completions = state.completions.filter((x) => !(x.userid === userid && x.courseid === courseid));
        if (body.completed !== false) state.completions.push({ userid, courseid, timecompleted: now() });
        save();
        return sendJson(res, 200, { ok: true });
      }
      case '/__mock/course': {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 1) return sendJson(res, 400, { error: 'id inválido' });
        const course = makeCourse(id, body);
        state.courses = state.courses.filter((c) => c.id !== id).concat(course);
        save();
        return sendJson(res, 200, course);
      }
      case '/__mock/fail-next': {
        failQueue.push({ ...body, count: Number(body.count ?? 1) });
        return sendJson(res, 200, { ok: true, queued: failQueue.length });
      }
      default: return sendJson(res, 404, { error: 'no encontrado' });
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/health') return sendJson(res, 200, { ok: true, mock: 'moodle' });
      if (url.pathname === '/webservice/rest/server.php') return await handleRest(req, res, url);
      if (url.pathname.startsWith('/__mock/')) return await handleControl(req, res, url);
      if (url.pathname === '/login/index.php') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!DOCTYPE html><html><body><h1>Moodle (mock) — Acceso</h1></body></html>');
      }
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>404</h1>');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    }
  });

  return {
    server,
    get state() { return state; },
    listen(port = Number(opts.port ?? process.env.MOCK_MOODLE_PORT ?? 4010), host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(`http://localhost:${typeof addr === 'object' && addr ? addr.port : port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Ejecutado como CLI: carga app/.env (sin pisar variables ya definidas: las del proceso padre, p.ej. el
  // `env` de playwright.config.ts, tienen prioridad).
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });
  const mock = createMoodleMock();
  mock.listen().then((url) => console.log('mock moodle escuchando en ' + url));
}
