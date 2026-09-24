// Contratos de los clientes externos que usan los servicios de dominio.
// Las implementaciones reales viven en src/server/moodle y src/server/paypal; los tests usan fakes en memoria.

export interface MoodleUserResult {
  id: number;
  /** true si la cuenta se creó ahora (entonces viene tempPassword). */
  created: boolean;
  tempPassword?: string;
  username?: string;
}

export interface MoodlePort {
  /**
   * core_user_get_users_by_field (email) → si no existe core_user_create_users. `beforeCreate` se llama
   * (y se espera) justo antes de core_user_create_users: si la respuesta se pierde, quien llama sabe que
   * la cuenta pudo crearse sin que recibiera la contraseña.
   */
  findOrCreateUser(email: string, names: { firstname: string; lastname: string }, hooks?: { beforeCreate?: () => Promise<void> }): Promise<MoodleUserResult>;
  /**
   * true si Moodle genera y envía él mismo las credenciales al crear la cuenta (createpassword=1): entonces
   * la app nunca fija contraseñas temporales por su cuenta.
   */
  readonly sendsOwnCredentials?: boolean;
  /**
   * Cuenta existente por id («1234»), email (sin distinguir mayúsculas) o username, para que el staff vincule a un
   * cliente con la cuenta que ya tenía en Moodle. null si no existe.
   */
  findUser(ref: string): Promise<{ id: number; username: string; email: string; suspended: boolean } | null>;
  /** enrol_manual_enrol_users (rol estudiante). Moodle lo trata de forma idempotente. */
  enrol(userId: number, courseIds: number[]): Promise<unknown>;
  /** enrol_manual_unenrol_users */
  unenrol(userId: number, courseIds: number[]): Promise<unknown>;
  /** core_completion_get_course_completion_status */
  getCompletion(userId: number, courseId: number): Promise<{ completed: boolean }>;
  /**
   * core_user_update_users: fija una contraseña temporal NUEVA (con auth_forcepasswordchange=1) y la
   * devuelve. Se usa cuando hay que reenviar credenciales: la original nunca se guarda.
   */
  resetTempPassword(userId: number): Promise<string>;
}

export interface PaypalCreateOrderInput {
  amountCents: number;
  currency: string;
  /** Nuestro Order.id (va como reference_id / custom_id). */
  orderId: string;
  returnUrl: string;
  cancelUrl: string;
  description?: string;
  invoiceId?: string;
}

/** Forma normalizada de una captura. `normalizeCapture` acepta también la respuesta cruda de Orders v2. */
export interface PaypalCaptureResult {
  /** id de la orden PayPal */
  id?: string;
  status: string; // COMPLETED | PENDING | DECLINED ...
  captureId?: string;
  captureStatus?: string;
  amountCents?: number;
  currency?: string;
  raw?: unknown;
}

export interface PaypalRefundResult {
  id: string;
  status: string; // COMPLETED | PENDING | FAILED
  amountCents?: number;
}

export interface PaypalRefundOptions {
  requestId?: string;
  invoiceId?: string;
  noteToPayer?: string;
}

export interface PaypalPort {
  createOrder(input: PaypalCreateOrderInput): Promise<{ id: string; approveUrl: string }>;
  captureOrder(paypalOrderId: string): Promise<unknown>;
  /** GET /v2/checkout/orders/{id} (respuesta cruda de Orders v2; se normaliza con normalizeCapture). */
  getOrder(paypalOrderId: string): Promise<unknown>;
  /**
   * POST /v2/payments/captures/{id}/refund. `requestId` va como PayPal-Request-Id: repetir la llamada con el
   * mismo id devuelve el mismo reembolso (nunca reembolsa dos veces). `invoiceId` vuelve en el webhook.
   */
  refundCapture(captureId: string, amountCents?: number, opts?: PaypalRefundOptions): Promise<unknown>;
  verifyWebhookSignature(headers: Record<string, string | string[] | undefined> | Headers, body: string | unknown): Promise<boolean> | boolean;
}

const toCents = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
};

/** Normaliza el resultado de captureOrder: forma propia o respuesta cruda de POST /v2/checkout/orders/{id}/capture. */
export function normalizeCapture(res: unknown): PaypalCaptureResult {
  const r = (res ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!r.purchase_units && ("captureId" in r || "captureStatus" in r || "amountCents" in r)) {
    return { id: r.id ?? r.orderId, status: String(r.status ?? r.orderStatus ?? r.captureStatus ?? "UNKNOWN"), captureId: r.captureId, captureStatus: r.captureStatus ?? r.status, amountCents: r.amountCents, currency: r.currency, raw: r.raw ?? res };
  }
  const cap = r.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    id: r.id,
    status: String(r.status ?? "UNKNOWN"),
    captureId: cap?.id,
    captureStatus: cap?.status,
    amountCents: toCents(cap?.amount?.value),
    currency: cap?.amount?.currency_code,
    raw: res,
  };
}

export function normalizeRefund(res: unknown): PaypalRefundResult {
  const r = (res ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { id: String(r.id), status: String(r.status ?? "COMPLETED"), amountCents: typeof r.amountCents === "number" ? r.amountCents : toCents(r.amount?.value) };
}
