// Tipos de las respuestas de las funciones de Moodle que usamos (subconjunto de campos reales).

export interface MoodleUser {
  id: number;
  username: string;
  firstname: string;
  lastname: string;
  fullname: string;
  email: string;
  auth: string;
  suspended: boolean;
  confirmed: boolean;
  idnumber?: string;
  [extra: string]: unknown;
}

export interface MoodleCourse {
  id: number;
  fullname: string;
  displayname?: string;
  shortname: string;
  categoryid: number;
  visible: number;
  enablecompletion?: number;
  startdate?: number;
  enddate?: number;
  [extra: string]: unknown;
}

export interface MoodleWarning {
  item?: string;
  itemid?: number;
  warningcode: string;
  message: string;
}

export interface MoodleCompletionCriterion {
  type: number;
  title: string;
  status: string;
  complete: boolean;
  timecompleted: number | null;
  details: { type: string; criteria: string; requirement: string; status: string };
}

/** Respuesta cruda de core_completion_get_course_completion_status. */
export interface MoodleCompletionStatusResponse {
  completionstatus: { completed: boolean; aggregation: number; completions: MoodleCompletionCriterion[] };
  warnings: MoodleWarning[];
}

/**
 * Resultado normalizado de getCompletion:
 * - COMPLETE / INCOMPLETE: Moodle respondió con el estado.
 * - NOT_ENROLLED (usernotenroled), NO_CRITERIA (nocriteriaset), NOT_ENABLED (completionnotenabled):
 *   Moodle no puede evaluar la finalización → se trata como NO completado (nunca emitir certificado).
 */
export type CompletionState = "COMPLETE" | "INCOMPLETE" | "NOT_ENROLLED" | "NO_CRITERIA" | "NOT_ENABLED";

export interface CourseCompletion {
  userId: number;
  courseId: number;
  state: CompletionState;
  completed: boolean;
  /** Mayor timecompleted de los criterios (segundos Unix) si completó. */
  timecompleted: number | null;
  completions: MoodleCompletionCriterion[];
}

export interface FindOrCreateUserResult {
  user: MoodleUser;
  created: boolean;
  /** Solo si la cuenta es nueva y passwordMode = "temp": la contraseña temporal para el correo de acceso. */
  tempPassword?: string;
  /** Si la cuenta existía suspendida y se reactivó. */
  reactivated?: boolean;
}
