// Adaptadores de los clientes reales (src/server/moodle, src/server/paypal) a los puertos del dominio.
import type { MoodleClient } from "@/server/moodle";
import type { PayPalClient } from "@/server/paypal";
import type { MoodlePort, PaypalPort, PaypalCaptureResult, PaypalRefundResult } from "@/server/ports";
import { normalizeRefund } from "@/server/ports";

/** Un cliente o una función que lo construye al primer uso (así la app arranca aunque falte configuración). */
export type ClientSource<C> = C | (() => C);

function lazy<C extends object>(src: ClientSource<C>): () => C {
  if (typeof src !== "function") return () => src;
  let c: C | undefined;
  return () => (c ??= (src as () => C)());
}

export function moodlePort(source: ClientSource<MoodleClient>): MoodlePort {
  const get = lazy(source);
  const client = new Proxy({} as MoodleClient, { get: (_t, prop) => { const c = get(); const v = Reflect.get(c, prop, c); return typeof v === "function" ? v.bind(c) : v; } });
  return {
    async findOrCreateUser(email, names) {
      const r = await client.findOrCreateUser({ email, firstname: names.firstname, lastname: names.lastname });
      return { id: r.user.id, created: r.created, tempPassword: r.tempPassword, username: r.user.username };
    },
    enrol: (userId, courseIds) => client.enrol(userId, courseIds),
    unenrol: (userId, courseIds) => client.unenrol(userId, courseIds),
    async getCompletion(userId, courseId) {
      const c = await client.getCompletion(userId, courseId);
      return { completed: c.completed === true };
    },
    resetTempPassword: (userId) => client.resetTempPassword(userId),
  };
}

export function paypalPort(source: ClientSource<PayPalClient>): PaypalPort {
  const get = lazy(source);
  const client = new Proxy({} as PayPalClient, { get: (_t, prop) => { const c = get(); const v = Reflect.get(c, prop, c); return typeof v === "function" ? v.bind(c) : v; } });
  return {
    async createOrder(input) {
      const r = await client.createOrder({
        amountCents: input.amountCents,
        currency: input.currency,
        referenceId: input.orderId,
        customId: input.orderId,
        invoiceId: input.invoiceId,
        description: input.description,
        returnUrl: input.returnUrl,
        cancelUrl: input.cancelUrl,
        brandName: "CEIUM",
        locale: "es-VE",
        userAction: "PAY_NOW",
      });
      return { id: r.id, approveUrl: r.approveUrl };
    },
    async captureOrder(id): Promise<PaypalCaptureResult> {
      const r = await client.captureOrder(id);
      return { id: r.orderId, status: String(r.orderStatus), captureId: r.captureId, captureStatus: r.captureStatus, amountCents: r.amountCents, currency: r.capture?.amount?.currency_code, raw: r.raw };
    },
    getOrder: (id) => client.getOrder(id),
    async refundCapture(captureId, amountCents): Promise<PaypalRefundResult> {
      return normalizeRefund(await client.refundCapture(captureId, amountCents != null ? { amountCents } : {}));
    },
    async verifyWebhookSignature(headers, body) {
      const r = await client.verifyWebhookSignature({ headers, body: body as string });
      return r.verified;
    },
  };
}
