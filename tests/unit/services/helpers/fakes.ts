// Fakes en memoria de Moodle y PayPal que respetan los contratos de src/server/ports.ts.
import crypto from "node:crypto";
import type { MoodlePort, PaypalPort, PaypalCreateOrderInput } from "@/server/ports";

export class FakeMoodle implements MoodlePort {
  users = new Map<string, { id: number; email: string; firstname: string; lastname: string }>();
  enrolments = new Map<number, Set<number>>();
  completed = new Set<string>();
  calls: { fn: string; args: unknown[] }[] = [];
  /** Número de próximas llamadas a enrol que fallarán. */
  failEnrol = 0;
  failFindOrCreate = 0;
  private nextId = 1000;

  /** Número de próximas altas que Moodle ejecuta pero cuya respuesta se pierde (timeout/5xx tras crear). */
  loseCreateResponse = 0;
  /** Modo "moodle-email": Moodle envía él mismo las credenciales. */
  sendsOwnCredentials = false;

  async findOrCreateUser(email: string, names: { firstname: string; lastname: string }, hooks?: { beforeCreate?: () => Promise<void> }) {
    this.calls.push({ fn: "findOrCreateUser", args: [email, names] });
    if (this.failFindOrCreate > 0) {
      this.failFindOrCreate--;
      throw new Error("Moodle core_user_create_users: error de conexión");
    }
    const key = email.toLowerCase();
    const u = this.users.get(key);
    if (u) return { id: u.id, created: false, username: key };
    await hooks?.beforeCreate?.();
    const id = this.nextId++;
    this.users.set(key, { id, email: key, ...names });
    if (this.loseCreateResponse > 0) {
      this.loseCreateResponse--;
      throw new Error("Moodle core_user_create_users: sin respuesta en 15000 ms");
    }
    return { id, created: true, tempPassword: "Tmp#" + crypto.randomBytes(4).toString("hex"), username: key };
  }
  async findUser(ref: string) {
    this.calls.push({ fn: "findUser", args: [ref] });
    const r = ref.trim().replace(/^#/, "").toLowerCase();
    const u = [...this.users.values()].find((x) => String(x.id) === r || x.email.toLowerCase() === r);
    return u ? { id: u.id, username: u.email.toLowerCase(), email: u.email, suspended: false } : null;
  }
  async enrol(userId: number, courseIds: number[]) {
    this.calls.push({ fn: "enrol", args: [userId, courseIds] });
    await new Promise((r) => setTimeout(r, 1));
    if (this.failEnrol > 0) {
      this.failEnrol--;
      throw new Error("Moodle enrol_manual_enrol_users: timeout");
    }
    const set = this.enrolments.get(userId) ?? new Set<number>();
    courseIds.forEach((c) => set.add(c));
    this.enrolments.set(userId, set);
  }
  async unenrol(userId: number, courseIds: number[]) {
    this.calls.push({ fn: "unenrol", args: [userId, courseIds] });
    const set = this.enrolments.get(userId);
    courseIds.forEach((c) => set?.delete(c));
  }
  async getCompletion(userId: number, courseId: number) {
    this.calls.push({ fn: "getCompletion", args: [userId, courseId] });
    return { completed: this.completed.has(`${userId}:${courseId}`) };
  }
  passwordResets: { userId: number; password: string }[] = [];
  failReset = 0;
  async resetTempPassword(userId: number) {
    this.calls.push({ fn: "resetTempPassword", args: [userId] });
    if (this.failReset > 0) {
      this.failReset--;
      throw new Error("Moodle core_user_update_users: timeout");
    }
    const password = "Rst#" + crypto.randomBytes(4).toString("hex");
    this.passwordResets.push({ userId, password });
    return password;
  }
  markCompleted(userId: number, courseId: number) {
    this.completed.add(`${userId}:${courseId}`);
  }
  count(fn: string) {
    return this.calls.filter((c) => c.fn === fn).length;
  }
}

interface FakePaypalOrder {
  id: string;
  input: PaypalCreateOrderInput;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  captureId?: string;
  /** Estado de la captura (COMPLETED por defecto; PENDING si PayPal la retuvo). */
  captureStatus?: "COMPLETED" | "PENDING" | "DECLINED";
}

export class FakePaypal implements PaypalPort {
  orders = new Map<string, FakePaypalOrder>();
  refunds: { id: string; captureId: string; amountCents?: number; requestId?: string; invoiceId?: string }[] = [];
  /** Respuestas ya dadas por PayPal-Request-Id (PayPal devuelve la misma sin volver a reembolsar). */
  refundByRequestId = new Map<string, unknown>();
  /** Falla la próxima llamada de reembolso con un error de red (resultado incierto), tras hacer o no el reembolso. */
  refundNetworkErrorAfterRefund: boolean | null = null;
  calls: { fn: string; args: unknown[] }[] = [];
  signatureValid = true;
  declineNextCapture = false;
  failRefund = false;

  async createOrder(input: PaypalCreateOrderInput) {
    this.calls.push({ fn: "createOrder", args: [input] });
    const id = "PAYID-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    this.orders.set(id, { id, input, status: "CREATED" });
    return { id, approveUrl: `https://sandbox.paypal.test/checkoutnow?token=${id}` };
  }
  approve(id: string) {
    const o = this.orders.get(id);
    if (!o) throw new Error("orden desconocida");
    o.status = "APPROVED";
  }
  /** Devuelve la respuesta cruda de Orders v2 (para ejercitar normalizeCapture). */
  async captureOrder(id: string) {
    this.calls.push({ fn: "captureOrder", args: [id] });
    const o = this.orders.get(id);
    if (!o) throw new Error("PayPal capture: 404 RESOURCE_NOT_FOUND");
    if (o.status === "COMPLETED") throw new Error("PayPal capture: 422 UNPROCESSABLE_ENTITY/ORDER_ALREADY_CAPTURED — Order already captured.");
    if (o.status !== "APPROVED") throw new Error("PayPal capture: 422 UNPROCESSABLE_ENTITY/ORDER_NOT_APPROVED");
    const declined = this.declineNextCapture;
    this.declineNextCapture = false;
    o.captureId = "CAP-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    if (!declined) o.status = "COMPLETED";
    return {
      id,
      status: declined ? "APPROVED" : "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: o.captureId, status: declined ? "DECLINED" : "COMPLETED", amount: { currency_code: "USD", value: (o.input.amountCents / 100).toFixed(2) } }] } }],
    };
  }
  failGetOrder = false;
  /** Respuesta cruda de GET /v2/checkout/orders/{id}. */
  async getOrder(id: string) {
    this.calls.push({ fn: "getOrder", args: [id] });
    if (this.failGetOrder) throw new Error("PayPal getOrder: 503 SERVICE_UNAVAILABLE");
    const o = this.orders.get(id);
    if (!o) throw new Error("PayPal getOrder: 404 RESOURCE_NOT_FOUND");
    const value = (o.input.amountCents / 100).toFixed(2);
    return {
      id,
      status: o.status,
      purchase_units: [{ amount: { currency_code: "USD", value }, ...(o.captureId ? { payments: { captures: [{ id: o.captureId, status: o.captureStatus ?? "COMPLETED", amount: { currency_code: "USD", value } }] } } : {}) }],
    };
  }
  /** El comprador aprobó y PayPal capturó por su lado (sin return URL ni webhook). */
  captureOutOfBand(id: string, captureStatus: "COMPLETED" | "PENDING" = "COMPLETED") {
    const o = this.orders.get(id)!;
    o.status = "COMPLETED";
    o.captureId = "CAP-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    o.captureStatus = captureStatus;
    return o.captureId;
  }
  async refundCapture(captureId: string, amountCents?: number, opts: { requestId?: string; invoiceId?: string; noteToPayer?: string } = {}) {
    this.calls.push({ fn: "refundCapture", args: [captureId, amountCents, opts] });
    if (this.failRefund) throw new Error("PayPal refund: 422 CAPTURE_FULLY_REFUNDED");
    if (opts.requestId && this.refundByRequestId.has(opts.requestId)) return this.refundByRequestId.get(opts.requestId);
    const net = this.refundNetworkErrorAfterRefund;
    this.refundNetworkErrorAfterRefund = null;
    if (net === false) throw new Error("fetch failed: ECONNRESET");
    const id = "REF-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    this.refunds.push({ id, captureId, amountCents, requestId: opts.requestId, invoiceId: opts.invoiceId });
    const cap = [...this.orders.values()].find((o) => o.captureId === captureId);
    const value = ((amountCents ?? cap?.input.amountCents ?? 0) / 100).toFixed(2);
    const res = { id, status: "COMPLETED", amount: { value, currency_code: "USD" }, ...(opts.invoiceId ? { invoice_id: opts.invoiceId } : {}) };
    if (opts.requestId) this.refundByRequestId.set(opts.requestId, res);
    if (net === true) throw new Error("fetch failed: socket hang up");
    return res;
  }
  async verifyWebhookSignature() {
    return this.signatureValid;
  }

  /** Cuerpo de webhook PAYMENT.CAPTURE.COMPLETED como lo envía PayPal. */
  captureCompletedEvent(paypalOrderId: string, eventId = "WH-" + crypto.randomBytes(5).toString("hex")) {
    const o = this.orders.get(paypalOrderId)!;
    o.captureId ??= "CAP-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    o.status = "COMPLETED";
    return JSON.stringify({
      id: eventId,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: o.captureId,
        status: "COMPLETED",
        amount: { currency_code: "USD", value: (o.input.amountCents / 100).toFixed(2) },
        supplementary_data: { related_ids: { order_id: paypalOrderId } },
      },
    });
  }
  refundEvent(captureId: string, refundId: string, amountCents: number, eventId = "WH-" + crypto.randomBytes(5).toString("hex"), invoiceId?: string) {
    return JSON.stringify({
      id: eventId,
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: refundId, status: "COMPLETED", ...(invoiceId ? { invoice_id: invoiceId } : {}), amount: { value: (amountCents / 100).toFixed(2), currency_code: "USD" }, links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
    });
  }
}
