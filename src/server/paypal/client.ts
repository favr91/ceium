// Cliente REST de PayPal (Orders v2 + Payments v2 + Webhooks v1).
// Funciona igual contra el sandbox real (https://api-m.sandbox.paypal.com), producción o mocks/paypal:
// solo cambia PAYPAL_BASE_URL. Sin SDK: fetch + OAuth client_credentials con caché del token.
import crypto from "node:crypto";
import type {
  Capture,
  CreateOrderRequest,
  ExperienceContext,
  Money,
  Order,
  PayPalErrorBody,
  PayPalErrorDetail,
  PayPalItem,
  Refund,
  WebhookEvent,
} from "./types";

export interface PayPalConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  /** ms por petición (defecto 20 s) */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class PayPalApiError extends Error {
  readonly status: number;
  readonly body: PayPalErrorBody;
  /** `name` de PayPal (INVALID_REQUEST, UNPROCESSABLE_ENTITY, RESOURCE_NOT_FOUND…) o `error` de OAuth */
  readonly errorName: string;
  /** Primer `details[].issue` (ORDER_NOT_APPROVED, ORDER_ALREADY_CAPTURED, INSTRUMENT_DECLINED…) */
  readonly issue: string | undefined;
  readonly details: PayPalErrorDetail[];
  readonly debugId: string | undefined;

  constructor(status: number, body: PayPalErrorBody, context: string) {
    const name = body.name ?? body.error ?? `HTTP_${status}`;
    const issue = body.details?.[0]?.issue;
    super(`PayPal ${context}: ${status} ${name}${issue ? `/${issue}` : ""} — ${body.details?.[0]?.description ?? body.message ?? body.error_description ?? ""}`.trim());
    this.name = "PayPalApiError";
    this.status = status;
    this.body = body;
    this.errorName = name;
    this.issue = issue;
    this.details = body.details ?? [];
    this.debugId = body.debug_id;
  }

  hasIssue(issue: string): boolean {
    return this.details.some((d) => d.issue === issue);
  }
}

// ─── dinero ───
/** 18000 → "180.00" */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`centavos no enteros: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
/** "180.00" | "180.5" | "180" → 18000 / 18050 / 18000 */
export function valueToCents(value: string): number {
  const m = /^(-)?(\d*)(?:\.(\d{0,2})\d*)?$/.exec(value.trim());
  if (!m) throw new Error(`monto inválido: ${value}`);
  const cents = Number(m[2] || "0") * 100 + Number(((m[3] ?? "") + "00").slice(0, 2));
  return m[1] ? -cents : cents;
}

// ─── inputs de alto nivel ───
export interface CreateOrderInput {
  /** Total a cobrar en centavos */
  amountCents: number;
  currency?: string; // USD
  /** Nuestro id de orden/pago (va en reference_id y custom_id para correlacionar webhooks) */
  referenceId: string;
  customId?: string;
  /** Único por pago en PayPal (evita cobros duplicados); p.ej. "CEIUM-1001-1" */
  invoiceId?: string;
  description?: string;
  items?: { name: string; unitAmountCents: number; quantity?: number; sku?: string }[];
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
  locale?: string; // "es-VE"
  userAction?: "PAY_NOW" | "CONTINUE";
  /** Idempotencia (PayPal-Request-Id). Si falta se genera uno. */
  requestId?: string;
}

export interface CreatedOrder {
  id: string;
  status: Order["status"];
  /** URL a la que se redirige al comprador (rel "payer-action" o "approve") */
  approveUrl: string;
  raw: Order;
}

export interface CaptureResult {
  orderId: string;
  orderStatus: Order["status"];
  /** Primer capture de la primera purchase_unit (nuestro caso: una sola) */
  capture: Capture | undefined;
  captureId: string | undefined;
  captureStatus: Capture["status"] | undefined;
  amountCents: number | undefined;
  feeCents: number | undefined;
  netCents: number | undefined;
  payerEmail: string | undefined;
  payerId: string | undefined;
  raw: Order;
}

export interface RefundInput {
  /** Omitir = reembolso total del saldo no reembolsado */
  amountCents?: number;
  currency?: string;
  invoiceId?: string;
  noteToPayer?: string;
  requestId?: string;
}

/** Cabeceras de un webhook entrante (Headers de fetch/Next o un objeto plano). */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface VerifyWebhookInput {
  headers: WebhookHeaders;
  /** Cuerpo crudo tal como llegó (preferido) o el evento ya parseado */
  body: string | WebhookEvent;
  /** Por defecto config.webhookId (PAYPAL_WEBHOOK_ID) */
  webhookId?: string;
}

export interface VerifyWebhookResult {
  verified: boolean;
  status: "SUCCESS" | "FAILURE";
  event: WebhookEvent;
}

function header(h: WebhookHeaders, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export class PayPalClient {
  private readonly cfg: Required<Pick<PayPalConfig, "baseUrl" | "clientId" | "clientSecret" | "timeoutMs">> & PayPalConfig;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInflight: Promise<string> | null = null;

  constructor(cfg: PayPalConfig) {
    if (!cfg.baseUrl || !cfg.clientId || !cfg.clientSecret) throw new Error("PayPal: faltan baseUrl/clientId/clientSecret");
    this.cfg = { timeoutMs: 20_000, ...cfg, baseUrl: cfg.baseUrl.replace(/\/+$/, "") };
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  private get fetchImpl(): typeof fetch {
    return this.cfg.fetch ?? fetch;
  }

  /** Access token OAuth2 (client_credentials), cacheado hasta 60 s antes de expirar. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (!this.tokenInflight) {
      this.tokenInflight = (async () => {
        const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
        const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/oauth2/token`, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: "grant_type=client_credentials",
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number } & PayPalErrorBody;
        if (!res.ok || !body.access_token) throw new PayPalApiError(res.status, body, "oauth2/token");
        const ttlMs = Math.max(0, (body.expires_in ?? 0) * 1000 - 60_000);
        this.token = { value: body.access_token, expiresAt: Date.now() + ttlMs };
        return body.access_token;
      })().finally(() => {
        this.tokenInflight = null;
      });
    }
    return this.tokenInflight;
  }

  /** Petición autenticada. Reintenta una vez si el token fue rechazado (401) y una vez ante 5xx/red en operaciones idempotentes. */
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; requestId?: string; prefer?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<T> {
    const idempotent = method === "GET" || Boolean(opts.requestId);
    let refreshed = false;
    let retried = false;
    for (;;) {
      const token = await this.getAccessToken(refreshed);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(opts.body !== undefined || method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(opts.requestId ? { "PayPal-Request-Id": opts.requestId } : {}),
        ...(opts.prefer ? { Prefer: opts.prefer } : {}),
        ...opts.extraHeaders,
      };
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (err) {
        if (idempotent && !retried) {
          retried = true;
          continue;
        }
        throw err;
      }
      const text = await res.text();
      let data: unknown = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text.slice(0, 500) };
        }
      }
      if (res.status === 401 && !refreshed) {
        this.token = null;
        refreshed = true;
        continue;
      }
      if (res.status >= 500 && idempotent && !retried) {
        retried = true;
        continue;
      }
      if (!res.ok) throw new PayPalApiError(res.status, data as PayPalErrorBody, `${method} ${path}`);
      return data as T;
    }
  }

  // ─── Orders v2 ───

  /** Construye el cuerpo real de POST /v2/checkout/orders (exportado para tests/inspección). */
  static buildCreateOrderBody(input: CreateOrderInput): CreateOrderRequest {
    const currency = input.currency ?? "USD";
    const value = centsToValue(input.amountCents);
    const items: PayPalItem[] | undefined = input.items?.length
      ? input.items.map((it) => ({
          name: it.name.slice(0, 127),
          quantity: String(it.quantity ?? 1),
          unit_amount: { currency_code: currency, value: centsToValue(it.unitAmountCents) },
          category: "DIGITAL_GOODS" as const,
          ...(it.sku ? { sku: it.sku.slice(0, 127) } : {}),
        }))
      : undefined;
    if (items) {
      const sum = input.items!.reduce((s, it) => s + it.unitAmountCents * (it.quantity ?? 1), 0);
      if (sum !== input.amountCents) throw new Error(`PayPal: suma de ítems (${sum}) ≠ total (${input.amountCents})`);
    }
    const experience: ExperienceContext = {
      brand_name: input.brandName ?? "CEIUM",
      locale: input.locale ?? "es-VE",
      shipping_preference: "NO_SHIPPING",
      user_action: input.userAction ?? "PAY_NOW",
      payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
    };
    return {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.referenceId.slice(0, 256),
          custom_id: (input.customId ?? input.referenceId).slice(0, 127),
          ...(input.invoiceId ? { invoice_id: input.invoiceId.slice(0, 127) } : {}),
          ...(input.description ? { description: input.description.slice(0, 127) } : {}),
          amount: {
            currency_code: currency,
            value,
            ...(items ? { breakdown: { item_total: { currency_code: currency, value } } } : {}),
          },
          ...(items ? { items } : {}),
        },
      ],
      payment_source: { paypal: { experience_context: experience } },
    };
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    const raw = await this.request<Order>("POST", "/v2/checkout/orders", {
      body: PayPalClient.buildCreateOrderBody(input),
      requestId: input.requestId ?? crypto.randomUUID(),
      prefer: "return=representation",
    });
    const link = raw.links?.find((l) => l.rel === "payer-action") ?? raw.links?.find((l) => l.rel === "approve");
    if (!link) throw new Error(`PayPal: la orden ${raw.id} no trae enlace de aprobación`);
    return { id: raw.id, status: raw.status, approveUrl: link.href, raw };
  }

  async getOrder(orderId: string): Promise<Order> {
    return this.request<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * Captura una orden aprobada. Usa PayPal-Request-Id (defecto `capture-${orderId}`) para que un doble
   * clic o un reintento devuelva la misma captura en lugar de fallar.
   * Errores típicos: PayPalApiError con issue ORDER_NOT_APPROVED, ORDER_ALREADY_CAPTURED, INSTRUMENT_DECLINED.
   */
  async captureOrder(orderId: string, opts: { requestId?: string } = {}): Promise<CaptureResult> {
    const raw = await this.request<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      body: {},
      requestId: opts.requestId ?? `capture-${orderId}`,
      prefer: "return=representation",
    });
    return summarizeCapture(raw);
  }

  // ─── Payments v2 ───

  async getCapture(captureId: string): Promise<Capture> {
    return this.request<Capture>("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
  }

  /** Reembolso total (sin amountCents) o parcial. Errores: REFUND_AMOUNT_EXCEEDED, CAPTURE_FULLY_REFUNDED… */
  async refundCapture(captureId: string, input: RefundInput = {}): Promise<Refund> {
    const body: Record<string, unknown> = {};
    if (input.amountCents !== undefined) body.amount = { value: centsToValue(input.amountCents), currency_code: input.currency ?? "USD" } satisfies Money;
    if (input.invoiceId) body.invoice_id = input.invoiceId;
    if (input.noteToPayer) body.note_to_payer = input.noteToPayer.slice(0, 255);
    return this.request<Refund>("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      body,
      requestId: input.requestId ?? crypto.randomUUID(),
      prefer: "return=representation",
    });
  }

  async getRefund(refundId: string): Promise<Refund> {
    return this.request<Refund>("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
  }

  // ─── Webhooks v1 ───

  /**
   * Verifica un webhook entrante con POST /v1/notifications/verify-webhook-signature.
   * No lanza por firma inválida ni por cabeceras paypal-* ausentes: devuelve verified=false (FAILURE).
   * Sí lanza (PayPalApiError) si la API de PayPal falla, para que el webhook responda 5xx y PayPal reintente.
   */
  async verifyWebhookSignature(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    const event: WebhookEvent = typeof input.body === "string" ? (JSON.parse(input.body) as WebhookEvent) : input.body;
    const webhookId = input.webhookId ?? this.cfg.webhookId;
    if (!webhookId) throw new Error("PayPal: falta PAYPAL_WEBHOOK_ID para verificar webhooks");
    const h = input.headers;
    const fields = {
      auth_algo: header(h, "paypal-auth-algo"),
      cert_url: header(h, "paypal-cert-url"),
      transmission_id: header(h, "paypal-transmission-id"),
      transmission_sig: header(h, "paypal-transmission-sig"),
      transmission_time: header(h, "paypal-transmission-time"),
    };
    if (Object.values(fields).some((v) => !v)) return { verified: false, status: "FAILURE", event };
    // Un certificado que no es de PayPal no es un webhook suyo: se descarta sin llamar a su API (una ráfaga de
    // webhooks falsos no gasta llamadas ni cuota de PayPal).
    if (!/^https:\/\/api(-m)?(\.sandbox)?\.paypal\.com\//.test(fields.cert_url!)) return { verified: false, status: "FAILURE", event };
    const res = await this.request<{ verification_status: "SUCCESS" | "FAILURE" }>("POST", "/v1/notifications/verify-webhook-signature", {
      body: { ...fields, webhook_id: webhookId, webhook_event: event },
    });
    const ok = res.verification_status === "SUCCESS";
    return { verified: ok, status: ok ? "SUCCESS" : "FAILURE", event };
  }
}

/** Extrae lo relevante de la respuesta de captura / GET order. */
export function summarizeCapture(raw: Order): CaptureResult {
  const capture = raw.purchase_units?.[0]?.payments?.captures?.[0];
  const brk = capture?.seller_receivable_breakdown;
  return {
    orderId: raw.id,
    orderStatus: raw.status,
    capture,
    captureId: capture?.id,
    captureStatus: capture?.status,
    amountCents: capture ? valueToCents(capture.amount.value) : undefined,
    feeCents: brk?.paypal_fee ? valueToCents(brk.paypal_fee.value) : undefined,
    netCents: brk?.net_amount ? valueToCents(brk.net_amount.value) : undefined,
    payerEmail: raw.payer?.email_address ?? raw.payment_source?.paypal?.email_address,
    payerId: raw.payer?.payer_id ?? raw.payment_source?.paypal?.account_id,
    raw,
  };
}

/** Config desde el entorno (PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID). */
export function paypalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  return {
    baseUrl: env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com",
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    webhookId: env.PAYPAL_WEBHOOK_ID,
  };
}

const globalForPayPal = globalThis as unknown as { __ceiumPayPal?: PayPalClient };

/** Cliente singleton configurado por entorno (el token se cachea entre peticiones). */
export function getPayPal(): PayPalClient {
  globalForPayPal.__ceiumPayPal ??= new PayPalClient(paypalConfigFromEnv());
  return globalForPayPal.__ceiumPayPal;
}
