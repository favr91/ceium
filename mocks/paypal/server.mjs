#!/usr/bin/env node
// Mock de la API REST de PayPal (Orders v2 + Payments v2 + Webhooks v1) para dev/test.
//
// Implementa con las mismas rutas, formas de request/response y errores que la API real:
//   POST /v1/oauth2/token                          (client_credentials, Basic auth)
//   POST /v2/checkout/orders                       (intent CAPTURE, purchase_units, payment_source.paypal.experience_context
//                                                   o application_context legado; PayPal-Request-Id; Prefer)
//   GET  /v2/checkout/orders/:id
//   POST /v2/checkout/orders/:id/capture           (ORDER_NOT_APPROVED, ORDER_ALREADY_CAPTURED, INSTRUMENT_DECLINED…)
//   GET  /v2/payments/captures/:id
//   POST /v2/payments/captures/:id/refund          (total o parcial; REFUND_AMOUNT_EXCEEDED, CAPTURE_FULLY_REFUNDED)
//   GET  /v2/payments/refunds/:id
//   POST /v1/notifications/verify-webhook-signature  → SUCCESS solo para eventos emitidos por este mock
//                                                     con las cabeceras paypal-transmission-* correctas.
//   GET  /checkoutnow?token=ID                     página de aprobación con aspecto PayPal (para e2e)
//
// Webhooks: tras capturar (o reembolsar) se envía automáticamente el evento firmado a MOCK_PAYPAL_WEBHOOK_TARGET
// (PAYMENT.CAPTURE.COMPLETED / PENDING / DENIED / REFUNDED), igual que PayPal. Se puede desactivar con /__mock/config.
//
// API de control (solo mock):
//   GET|POST /__mock/approve/:orderId[?capture=COMPLETED|PENDING|DECLINED|INSTRUMENT_DECLINED][&json=1]
//            simula que el comprador aprueba → 302 a return_url?token=ID&PayerID=…
//   GET|POST /__mock/deny/:orderId[?json=1]        el comprador cancela → 302 a cancel_url?token=ID
//   POST     /__mock/send-webhook/:captureId[?event_type=PAYMENT.CAPTURE.COMPLETED][&tamper=body|signature]
//            envía (de nuevo) el evento firmado del capture al target y devuelve {status, event, headers}
//   POST     /__mock/captures/:captureId/complete | /deny   resuelve un capture PENDING (+ webhook)
//   POST     /__mock/reset          borra todo el estado (y la config vuelve a la de arranque)
//   POST     /__mock/config         {autoWebhooks, webhookTarget, webhookId, webhookDelayMs, tokenTtlSec}
//   POST     /__mock/revoke-tokens  invalida los access tokens emitidos (para probar reintento 401)
//   GET      /__mock/state          órdenes, captures, refunds, webhooks enviados
//   GET      /health
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-mock0000';
const AUTH_ALGO = 'SHA256withRSA';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function ppId(len = 17) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALNUM[bytes[i] % ALNUM.length];
  return s;
}
const debugId = () => crypto.randomBytes(7).toString('hex').slice(0, 13);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ─── dinero (enteros en centavos) ───
const VALUE_RE = /^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$/;
function toCents(value) {
  const [i, d = ''] = String(value).split('.');
  return Number(i || '0') * 100 + Number((d + '00').slice(0, 2));
}
const toValue = (cents) => (cents / 100).toFixed(2);
const omit = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const money = (currency_code, cents) => ({ currency_code, value: toValue(cents) });

// ─── errores con la forma real de PayPal ───
class PPError extends Error {
  constructor(status, body) { super(body.message); this.status = status; this.body = body; }
}
function infoLink(issue, api = 'orders/v2') {
  return [{ href: `https://developer.paypal.com/docs/api/${api}/#error-${issue}`, rel: 'information_link', method: 'GET' }];
}
function invalidRequest(details, api) {
  return new PPError(400, {
    name: 'INVALID_REQUEST',
    message: 'Request is not well-formed, syntactically incorrect, or violates schema.',
    debug_id: debugId(),
    details: details.map((d) => ({ location: 'body', ...d })),
    links: infoLink(details[0].issue, api),
  });
}
function unprocessable(issue, description, api, extra = {}) {
  return new PPError(422, {
    name: 'UNPROCESSABLE_ENTITY',
    details: [{ issue, description, ...extra }],
    message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
    debug_id: debugId(),
    links: infoLink(issue, api),
  });
}
function notFound(api) {
  return new PPError(404, {
    name: 'RESOURCE_NOT_FOUND',
    details: [{ issue: 'INVALID_RESOURCE_ID', description: 'Specified resource ID does not exist. Please check the resource ID and try again.' }],
    message: 'The specified resource does not exist.',
    debug_id: debugId(),
    links: infoLink('INVALID_RESOURCE_ID', api),
  });
}
const authFailure = () => new PPError(401, {
  name: 'AUTHENTICATION_FAILURE',
  message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
  links: [{ href: 'https://developer.paypal.com/docs/api/overview/#error', rel: 'information_link' }],
});

// ─── servidor ───
export function createPaypalMock(options = {}) {
  const initialConfig = {
    clientId: options.clientId ?? process.env.MOCK_PAYPAL_CLIENT_ID ?? process.env.PAYPAL_CLIENT_ID ?? 'mock-client-id',
    clientSecret: options.clientSecret ?? process.env.MOCK_PAYPAL_CLIENT_SECRET ?? process.env.PAYPAL_CLIENT_SECRET ?? 'mock-client-secret',
    webhookId: options.webhookId ?? process.env.MOCK_PAYPAL_WEBHOOK_ID ?? process.env.PAYPAL_WEBHOOK_ID ?? 'mock-webhook-id',
    webhookTarget: options.webhookTarget ?? process.env.MOCK_PAYPAL_WEBHOOK_TARGET ?? 'http://localhost:3000/api/webhooks/paypal',
    autoWebhooks: options.autoWebhooks ?? process.env.MOCK_PAYPAL_AUTO_WEBHOOKS !== 'false',
    webhookDelayMs: options.webhookDelayMs ?? Number(process.env.MOCK_PAYPAL_WEBHOOK_DELAY_MS ?? 50),
    tokenTtlSec: options.tokenTtlSec ?? 32400,
    signingSecret: crypto.randomBytes(32),
  };
  let config;
  let state;
  function reset() {
    config = { ...initialConfig };
    state = {
      tokens: new Map(), // access_token -> expiresAt(ms)
      orders: new Map(),
      captures: new Map(), // captureId -> { capture, orderId }
      refunds: new Map(),
      idempotency: new Map(), // `${route}|${requestId}` -> { status, body }
      transmissions: new Map(), // transmission_id -> { event }
      sentWebhooks: [],
      pendingTimers: new Set(),
    };
  }
  reset();

  let baseUrl = options.baseUrl ?? '';
  const origin = (req) => baseUrl || `http://${req.headers.host}`;

  // ── helpers de recursos ──
  function orderLinks(o, base) {
    const self = { href: `${base}/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' };
    if (o.status === 'COMPLETED' || o.status === 'APPROVED') {
      return o.status === 'APPROVED'
        ? [self, { href: `${base}/v2/checkout/orders/${o.id}`, rel: 'update', method: 'PATCH' }, { href: `${base}/v2/checkout/orders/${o.id}/capture`, rel: 'capture', method: 'POST' }]
        : [self];
    }
    const approveHref = `${base}/checkoutnow?token=${o.id}`;
    return [
      self,
      o.usesPaymentSource
        ? { href: approveHref, rel: 'payer-action', method: 'GET' }
        : { href: approveHref, rel: 'approve', method: 'GET' },
      { href: `${base}/v2/checkout/orders/${o.id}`, rel: 'update', method: 'PATCH' },
      { href: `${base}/v2/checkout/orders/${o.id}/capture`, rel: 'capture', method: 'POST' },
    ];
  }
  function captureLinks(c, orderId, base) {
    return [
      { href: `${base}/v2/payments/captures/${c.id}`, rel: 'self', method: 'GET' },
      { href: `${base}/v2/payments/captures/${c.id}/refund`, rel: 'refund', method: 'POST' },
      { href: `${base}/v2/checkout/orders/${orderId}`, rel: 'up', method: 'GET' },
    ];
  }
  function captureView(c, base) {
    return { ...omit(c, ['orderId', '_cents', '_refundedCents']), links: captureLinks(c, c.orderId, base) };
  }
  function refundView(r, base) {
    return {
      ...omit(r, ['_cents', '_captureId']),
      links: [
        { href: `${base}/v2/payments/refunds/${r.id}`, rel: 'self', method: 'GET' },
        { href: `${base}/v2/payments/captures/${r._captureId}`, rel: 'up', method: 'GET' },
      ],
    };
  }
  function orderView(o, base) {
    const view = {
      id: o.id,
      intent: o.intent,
      status: o.status,
      ...(o.payment_source ? { payment_source: o.payment_source } : {}),
      purchase_units: o.purchase_units.map((pu) => {
        const out = { ...pu };
        if (pu.payments) {
          out.payments = {
            captures: pu.payments.captures.map((cid) => captureView(state.captures.get(cid), base)),
            ...(pu.payments.refunds?.length ? { refunds: pu.payments.refunds.map((rid) => refundView(state.refunds.get(rid), base)) } : {}),
          };
        }
        return out;
      }),
      ...(o.payer ? { payer: o.payer } : {}),
      create_time: o.create_time,
      ...(o.update_time ? { update_time: o.update_time } : {}),
      links: orderLinks(o, base),
    };
    return view;
  }

  // ── webhooks firmados ──
  function signature(transmissionId, time, webhookId, body) {
    const crc = zlib.crc32(Buffer.from(body, 'utf8'));
    return crypto.createHmac('sha256', config.signingSecret).update(`${transmissionId}|${time}|${webhookId}|${crc}`).digest('base64');
  }
  function buildEvent(eventType, resource, base) {
    const id = `WH-${ppId(17)}-${ppId(17)}`;
    const amount = resource.amount ? `${resource.amount.currency_code === 'USD' ? '$' : ''} ${Number(resource.amount.value)} ${resource.amount.currency_code}` : '';
    const summaries = {
      'PAYMENT.CAPTURE.COMPLETED': `Payment completed for ${amount}`,
      'PAYMENT.CAPTURE.PENDING': `Payment pending for ${amount}`,
      'PAYMENT.CAPTURE.DENIED': `Payment denied for ${amount}`,
      'PAYMENT.CAPTURE.REFUNDED': `A ${amount} capture payment was refunded`,
      'PAYMENT.CAPTURE.REVERSED': `A ${amount} capture payment was reversed`,
    };
    return {
      id,
      event_version: '1.0',
      create_time: nowIso(),
      resource_type: eventType === 'PAYMENT.CAPTURE.REFUNDED' ? 'refund' : 'capture',
      resource_version: '2.0',
      event_type: eventType,
      summary: summaries[eventType] ?? eventType,
      resource,
      links: [
        { href: `${base}/v1/notifications/webhooks-events/${id}`, rel: 'self', method: 'GET' },
        { href: `${base}/v1/notifications/webhooks-events/${id}/resend`, rel: 'resend', method: 'POST' },
      ],
    };
  }
  function captureEventResource(c, base) {
    const o = state.orders.get(c.orderId);
    return {
      ...captureView(c, base),
      supplementary_data: { related_ids: { order_id: c.orderId } },
      payee: o?.purchase_units[0]?.payee,
    };
  }
  function refundEventResource(r, base) {
    const c = state.captures.get(r._captureId);
    return {
      ...refundView(r, base),
      supplementary_data: { related_ids: { order_id: c?.orderId, capture_id: r._captureId } },
      payer: o2payee(c),
    };
  }
  function o2payee(c) {
    const o = c && state.orders.get(c.orderId);
    const payee = o?.purchase_units[0]?.payee;
    return payee ? { email_address: payee.email_address, merchant_id: payee.merchant_id } : undefined;
  }
  async function deliver(event, { tamper } = {}) {
    const body = JSON.stringify(event);
    const transmissionId = crypto.randomUUID();
    const time = nowIso();
    let sig = signature(transmissionId, time, config.webhookId, body);
    state.transmissions.set(transmissionId, { eventId: event.id });
    let sentBody = body;
    if (tamper === 'signature') sig = crypto.randomBytes(32).toString('base64');
    if (tamper === 'body') {
      const t = JSON.parse(body);
      if (t.resource?.amount) t.resource.amount.value = '0.01';
      else t.summary = 'tampered';
      sentBody = JSON.stringify(t);
    }
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'PayPal/AUHD-214.0-58268017',
      'paypal-transmission-id': transmissionId,
      'paypal-transmission-time': time,
      'paypal-transmission-sig': sig,
      'paypal-cert-url': CERT_URL,
      'paypal-auth-algo': AUTH_ALGO,
      'paypal-auth-version': 'v2',
      'correlation-id': debugId(),
    };
    const record = { eventId: event.id, eventType: event.event_type, target: config.webhookTarget, headers, status: null, error: null, at: nowIso() };
    state.sentWebhooks.push(record);
    try {
      const r = await fetch(config.webhookTarget, { method: 'POST', headers, body: sentBody, signal: AbortSignal.timeout(15000) });
      record.status = r.status;
      await r.arrayBuffer().catch(() => {});
    } catch (e) {
      record.error = String(e?.cause?.code ?? e?.message ?? e);
    }
    return { ...record, event: JSON.parse(sentBody) };
  }
  function autoWebhook(makeEvent) {
    if (!config.autoWebhooks || !config.webhookTarget) return;
    const t = setTimeout(() => {
      state.pendingTimers.delete(t);
      deliver(makeEvent()).catch(() => {});
    }, config.webhookDelayMs);
    state.pendingTimers.add(t);
  }

  // ── auth ──
  function requireBearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m) throw authFailure();
    const exp = state.tokens.get(m[1]);
    if (!exp || exp < Date.now()) {
      state.tokens.delete(m[1]);
      throw new PPError(401, { error: 'invalid_token', error_description: 'Token signature verification failed' });
    }
  }

  // ── validación de create order ──
  function validateCreate(body) {
    const details = [];
    const miss = (field) => details.push({ field, issue: 'MISSING_REQUIRED_PARAMETER', description: 'A required field / parameter is missing.' });
    if (!body || typeof body !== 'object') throw invalidRequest([{ field: '/', issue: 'MALFORMED_REQUEST_JSON', description: 'The request JSON is not well formed.' }]);
    if (!body.intent) miss('/intent');
    else if (!['CAPTURE', 'AUTHORIZE'].includes(body.intent)) details.push({ field: '/intent', value: String(body.intent), issue: 'INVALID_PARAMETER_VALUE', description: 'The value of a field is invalid.' });
    if (!Array.isArray(body.purchase_units) || body.purchase_units.length === 0) miss('/purchase_units');
    else {
      body.purchase_units.forEach((pu, i) => {
        const p = `/purchase_units/@reference_id=='${pu.reference_id ?? 'default'}'`;
        if (!pu.amount) return miss(`${p}/amount`);
        if (!pu.amount.currency_code) miss(`${p}/amount/currency_code`);
        else if (!/^[A-Z]{3}$/.test(pu.amount.currency_code)) details.push({ field: `${p}/amount/currency_code`, value: String(pu.amount.currency_code), issue: 'INVALID_PARAMETER_VALUE', description: 'The value of a field is invalid.' });
        if (pu.amount.value === undefined) miss(`${p}/amount/value`);
        else if (typeof pu.amount.value !== 'string' || !VALUE_RE.test(pu.amount.value)) details.push({ field: `${p}/amount/value`, value: String(pu.amount.value), issue: 'INVALID_PARAMETER_SYNTAX', description: 'The value of a field does not conform to the expected format.' });
        if (body.purchase_units.length > 1 && !pu.reference_id) miss(`/purchase_units/${i}/reference_id`);
      });
    }
    if (details.length) throw invalidRequest(details);
    for (const pu of body.purchase_units) {
      const p = `/purchase_units/@reference_id=='${pu.reference_id ?? 'default'}'`;
      const val = pu.amount.value;
      if (pu.amount.currency_code !== 'JPY' && /\.\d{3,}$/.test(val)) throw unprocessable('DECIMAL_PRECISION', 'If the currency supports decimals, only two decimal place precision is supported.', 'orders/v2', { field: `${p}/amount/value`, value: val, location: 'body' });
      const cents = toCents(val);
      if (cents <= 0) throw unprocessable('CANNOT_BE_ZERO_OR_NEGATIVE', 'Must be greater than zero. If the currency supports decimals, only two decimal place precision is supported.', 'orders/v2', { field: `${p}/amount/value`, value: val, location: 'body' });
      const bd = pu.amount.breakdown;
      if (bd) {
        const part = (k) => (bd[k] ? toCents(bd[k].value) : 0);
        const total = part('item_total') + part('tax_total') + part('shipping') + part('handling') + part('insurance') - part('shipping_discount') - part('discount');
        if (total !== cents) throw unprocessable('AMOUNT_MISMATCH', 'Should equal item_total + tax_total + shipping + handling + insurance - shipping_discount - discount.', 'orders/v2', { field: `${p}/amount/value`, value: val, location: 'body' });
      }
      if (Array.isArray(pu.items) && pu.items.length) {
        if (!bd?.item_total) throw unprocessable('ITEM_TOTAL_REQUIRED', 'If item details are specified (items.unit_amount and items.quantity) corresponding amount.breakdown.item_total is required.', 'orders/v2', { field: `${p}/amount/breakdown/item_total`, location: 'body' });
        const sum = pu.items.reduce((s, it) => s + toCents(it.unit_amount?.value ?? '0') * Number(it.quantity ?? 1), 0);
        if (sum !== toCents(bd.item_total.value)) throw unprocessable('ITEM_TOTAL_MISMATCH', 'Should equal sum of (unit_amount * quantity) across all items for a given purchase_unit.', 'orders/v2', { field: `${p}/amount/breakdown/item_total/value`, value: bd.item_total.value, location: 'body' });
      }
    }
  }

  function withIdempotency(req, route, fn) {
    const rid = req.headers['paypal-request-id'];
    const key = rid ? `${route}|${rid}` : null;
    if (key && state.idempotency.has(key)) return state.idempotency.get(key);
    const result = fn();
    if (key) state.idempotency.set(key, result);
    return result;
  }
  const wantsRepresentation = (req) => /return=representation/i.test(req.headers.prefer ?? '');

  // ── handlers ──
  function createOrder(req, body) {
    requireBearer(req);
    return withIdempotency(req, 'create', () => {
      validateCreate(body);
      const base = origin(req);
      const ps = body.payment_source?.paypal;
      const ctx = { ...(body.application_context ?? {}), ...(ps?.experience_context ?? {}) };
      const o = {
        id: ppId(17),
        intent: body.intent,
        status: ps ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
        usesPaymentSource: Boolean(ps),
        purchase_units: body.purchase_units.map((pu) => ({
          reference_id: pu.reference_id ?? 'default',
          amount: pu.amount,
          payee: { email_address: 'sb-merchant@business.example.com', merchant_id: 'MOCKMERCHANT01', ...(pu.payee ?? {}) },
          ...(pu.description ? { description: pu.description } : {}),
          ...(pu.custom_id ? { custom_id: pu.custom_id } : {}),
          ...(pu.invoice_id ? { invoice_id: pu.invoice_id } : {}),
          ...(pu.soft_descriptor ? { soft_descriptor: pu.soft_descriptor } : {}),
          ...(pu.items ? { items: pu.items } : {}),
        })),
        ...(ps ? { payment_source: { paypal: {} } } : {}),
        create_time: nowIso(),
        _ctx: ctx,
        _captureOutcome: 'COMPLETED',
      };
      if (o.intent === 'CAPTURE') {
        // la invoice_id duplicada se rechaza al capturar en la API real; aquí se valida al crear para detectar pronto
      }
      state.orders.set(o.id, o);
      const view = orderView(o, base);
      const out = wantsRepresentation(req) ? view : { id: view.id, status: view.status, ...(ps ? { payment_source: view.payment_source } : {}), links: view.links };
      return { status: 200, body: out };
    });
  }
  function getOrder(req, id) {
    requireBearer(req);
    const o = state.orders.get(id);
    if (!o) throw notFound();
    return { status: 200, body: orderView(o, origin(req)) };
  }
  function approve(id, outcome) {
    const o = state.orders.get(id);
    if (!o) throw notFound();
    if (o.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured.If \'intent=CAPTURE\' only one capture per order is allowed.');
    const payer = {
      name: { given_name: 'John', surname: 'Doe' },
      email_address: 'sb-buyer@personal.example.com',
      payer_id: o._payerId ?? ppId(13),
      address: { country_code: 'US' },
    };
    o._payerId = payer.payer_id;
    o.payer = payer;
    o.payment_source = {
      paypal: {
        email_address: payer.email_address,
        account_id: payer.payer_id,
        account_status: 'VERIFIED',
        name: payer.name,
        address: payer.address,
      },
    };
    o.status = 'APPROVED';
    o.update_time = nowIso();
    if (outcome) o._captureOutcome = outcome;
    return o;
  }
  function captureOrder(req, id) {
    requireBearer(req);
    return withIdempotency(req, `capture:${id}`, () => {
      const o = state.orders.get(id);
      if (!o) throw notFound();
      if (o.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured.If \'intent=CAPTURE\' only one capture per order is allowed.');
      if (o.status !== 'APPROVED') throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment. Please redirect the payer to the \'rel\':\'approve\' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.');
      if (o.intent !== 'CAPTURE') throw unprocessable('ACTION_DOES_NOT_MATCH_INTENT', 'Order was created with an intent to \'AUTHORIZE\'. Please use \'/v2/checkout/orders/order_id/authorize\' to complete the transaction or alternately Create an order with an intent of \'CAPTURE\'.');
      let mockCode = null;
      try { mockCode = JSON.parse(req.headers['paypal-mock-response'] ?? 'null')?.mock_application_codes ?? null; } catch { /* ignore */ }
      const outcome = mockCode ?? o._captureOutcome;
      if (outcome === 'INSTRUMENT_DECLINED') {
        throw unprocessable('INSTRUMENT_DECLINED', 'The instrument presented  was either declined by the processor or bank, or it can\'t be used for this payment.', 'orders/v2', { });
      }
      const base = origin(req);
      const time = nowIso();
      for (const pu of o.purchase_units) {
        const cents = toCents(pu.amount.value);
        const cur = pu.amount.currency_code;
        const fee = Math.round(cents * 0.0349) + 49;
        const status = outcome === 'PENDING' ? 'PENDING' : outcome === 'DECLINED' ? 'DECLINED' : 'COMPLETED';
        const c = {
          id: ppId(17),
          status,
          ...(status === 'PENDING' ? { status_details: { reason: 'PENDING_REVIEW' } } : {}),
          amount: { currency_code: cur, value: toValue(cents) },
          final_capture: true,
          seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
          ...(status === 'COMPLETED'
            ? { seller_receivable_breakdown: { gross_amount: money(cur, cents), paypal_fee: money(cur, fee), net_amount: money(cur, cents - fee) } }
            : {}),
          ...(pu.custom_id ? { custom_id: pu.custom_id } : {}),
          ...(pu.invoice_id ? { invoice_id: pu.invoice_id } : {}),
          create_time: time,
          update_time: time,
          orderId: o.id,
          _cents: cents,
          _refundedCents: 0,
        };
        state.captures.set(c.id, c);
        pu.payments = { captures: [c.id] };
        const evType = { COMPLETED: 'PAYMENT.CAPTURE.COMPLETED', PENDING: 'PAYMENT.CAPTURE.PENDING', DECLINED: 'PAYMENT.CAPTURE.DENIED' }[status];
        autoWebhook(() => buildEvent(evType, captureEventResource(c, base), base));
      }
      o.status = 'COMPLETED';
      o.update_time = time;
      const view = orderView(o, base);
      const body = wantsRepresentation(req)
        ? view
        : {
            id: view.id,
            status: view.status,
            payment_source: view.payment_source,
            purchase_units: view.purchase_units.map((pu) => ({ reference_id: pu.reference_id, payments: pu.payments })),
            payer: view.payer,
            links: view.links,
          };
      return { status: 201, body };
    });
  }
  function getCapture(req, id) {
    requireBearer(req);
    const c = state.captures.get(id);
    if (!c) throw notFound('payments/v2');
    return { status: 200, body: captureView(c, origin(req)) };
  }
  function getRefund(req, id) {
    requireBearer(req);
    const r = state.refunds.get(id);
    if (!r) throw notFound('payments/v2');
    return { status: 200, body: refundView(r, origin(req)) };
  }
  function refundCapture(req, id, body) {
    requireBearer(req);
    return withIdempotency(req, `refund:${id}`, () => {
      const c = state.captures.get(id);
      if (!c) throw notFound('payments/v2');
      const api = 'payments/v2';
      if (c.status === 'REFUNDED') throw unprocessable('CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded', api);
      if (c.status !== 'COMPLETED' && c.status !== 'PARTIALLY_REFUNDED') throw unprocessable('REFUND_NOT_ALLOWED', 'Full refund refused - partial refund has already been done on this payment. You cannot refund this capture.', api);
      const remaining = c._cents - c._refundedCents;
      let cents = remaining;
      if (body?.amount) {
        if (!body.amount.value || !body.amount.currency_code) throw invalidRequest([{ field: '/amount/value', issue: 'MISSING_REQUIRED_PARAMETER', description: 'A required field / parameter is missing.' }], api);
        if (typeof body.amount.value !== 'string' || !VALUE_RE.test(body.amount.value)) throw invalidRequest([{ field: '/amount/value', value: String(body.amount.value), issue: 'INVALID_PARAMETER_SYNTAX', description: 'The value of a field does not conform to the expected format.' }], api);
        if (body.amount.currency_code !== c.amount.currency_code) throw unprocessable('REFUND_CAPTURE_CURRENCY_MISMATCH', 'Refund must be in the same currency as the capture.', api);
        cents = toCents(body.amount.value);
        if (cents <= 0) throw unprocessable('REFUND_AMOUNT_TOO_LOW', 'The refund amount must be positive.', api);
        if (cents > remaining) throw unprocessable('REFUND_AMOUNT_EXCEEDED', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.', api);
      }
      const cur = c.amount.currency_code;
      const fee = Math.round((c._cents ? (Math.round(c._cents * 0.0349) + 49) : 0) * (cents / c._cents));
      const time = nowIso();
      const r = {
        id: ppId(17),
        status: 'COMPLETED',
        amount: money(cur, cents),
        ...(body?.invoice_id ?? c.invoice_id ? { invoice_id: body?.invoice_id ?? c.invoice_id } : {}),
        ...(c.custom_id ? { custom_id: c.custom_id } : {}),
        ...(body?.note_to_payer ? { note_to_payer: body.note_to_payer } : {}),
        seller_payable_breakdown: {
          gross_amount: money(cur, cents),
          paypal_fee: money(cur, fee),
          net_amount: money(cur, cents - fee),
          total_refunded_amount: money(cur, c._refundedCents + cents),
        },
        create_time: time,
        update_time: time,
        _captureId: c.id,
        _cents: cents,
      };
      state.refunds.set(r.id, r);
      c._refundedCents += cents;
      c.status = c._refundedCents >= c._cents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      c.update_time = time;
      const o = state.orders.get(c.orderId);
      const pu = o?.purchase_units.find((p) => p.payments?.captures.includes(c.id));
      if (pu) (pu.payments.refunds ??= []).push(r.id);
      const base = origin(req);
      autoWebhook(() => buildEvent('PAYMENT.CAPTURE.REFUNDED', refundEventResource(r, base), base));
      const view = refundView(r, base);
      return { status: 201, body: wantsRepresentation(req) ? view : { id: view.id, status: view.status, links: view.links } };
    });
  }
  function verifySignature(req, body) {
    requireBearer(req);
    const api = 'webhooks/v1';
    const required = ['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time', 'webhook_id', 'webhook_event'];
    const missing = required.filter((k) => body?.[k] === undefined || body?.[k] === null || body?.[k] === '');
    if (missing.length) throw invalidRequest(missing.map((k) => ({ field: k, issue: 'MISSING_REQUIRED_PARAMETER', description: 'A required field / parameter is missing.' })), api);
    const ok = (() => {
      const t = state.transmissions.get(body.transmission_id);
      if (!t) return false;
      if (body.auth_algo !== AUTH_ALGO || body.cert_url !== CERT_URL) return false;
      if (body.webhook_id !== config.webhookId) return false;
      if (typeof body.webhook_event !== 'object' || body.webhook_event.id !== t.eventId) return false;
      const expected = signature(body.transmission_id, body.transmission_time, body.webhook_id, JSON.stringify(body.webhook_event));
      const a = Buffer.from(expected);
      const b = Buffer.from(String(body.transmission_sig));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })();
    return { status: 200, body: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
  }
  function issueToken(req, rawBody) {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const [id, secret] = m ? Buffer.from(m[1], 'base64').toString('utf8').split(':') : [];
    if (id !== config.clientId || secret !== config.clientSecret) {
      throw new PPError(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    const params = new URLSearchParams(rawBody);
    const grant = params.get('grant_type');
    if (!grant) throw new PPError(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
    if (grant !== 'client_credentials') throw new PPError(400, { error: 'unsupported_grant_type', error_description: `Grant Type ${grant} is not supported` });
    const token = `A21AA${crypto.randomBytes(40).toString('base64url')}`;
    state.tokens.set(token, Date.now() + config.tokenTtlSec * 1000);
    return {
      status: 200,
      body: {
        scope: 'https://uri.paypal.com/services/payments/payment/authcapture openid https://uri.paypal.com/services/payments/refund https://api.paypal.com/v1/payments/.* https://uri.paypal.com/services/webhooks',
        access_token: token,
        token_type: 'Bearer',
        app_id: 'APP-80W284485P519543T',
        expires_in: config.tokenTtlSec,
        nonce: `${nowIso()}${crypto.randomBytes(16).toString('base64url')}`,
      },
    };
  }

  // ── página de aprobación ──
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function checkoutPage(o) {
    const pu = o.purchase_units[0];
    const brand = o._ctx.brand_name ?? 'Comercio';
    const cur = pu.amount.currency_code;
    const items = (pu.items ?? []).map((it) => `<li><span>${esc(it.name)}${Number(it.quantity) > 1 ? ` × ${esc(it.quantity)}` : ''}</span><span>${esc(it.unit_amount?.value)} ${esc(cur)}</span></li>`).join('');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagar con PayPal (sandbox simulado)</title>
<style>
:root{--pp-blue:#003087;--pp-cta:#0070e0;--pp-gold:#ffc439;--ink:#001c64;--muted:#545d68;--line:#dbe0e5}
*{box-sizing:border-box}body{margin:0;font-family:"Helvetica Neue",Arial,sans-serif;background:#f5f7fa;color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);padding:14px 16px;display:flex;justify-content:space-between;align-items:center}
.logo{font-weight:800;font-style:italic;font-size:26px;letter-spacing:-.5px}.logo b{color:var(--pp-blue)}.logo i{color:#0079c1;font-style:italic}
.cart{font-size:15px;font-weight:700}
main{max-width:460px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:24px}
h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 16px;color:var(--muted);font-size:14px}
ul{list-style:none;margin:0 0 12px;padding:0;font-size:14px}li{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-top:1px solid var(--line);font-size:14px}
.acct{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:8px;margin:12px 0 20px;font-size:14px}
.acct .dot{width:36px;height:36px;border-radius:50%;background:#e5f0fb;display:grid;place-items:center;font-weight:700;color:var(--pp-blue)}
.btn{display:block;width:100%;text-align:center;padding:14px;border-radius:999px;font-size:17px;font-weight:700;text-decoration:none;border:0;cursor:pointer}
.pay{background:var(--pp-cta);color:#fff}.pay:hover{background:#005ea6}
.cancel{margin-top:14px;background:none;color:var(--pp-cta);font-weight:600;font-size:15px}
.note{margin-top:18px;font-size:12px;color:var(--muted);text-align:center}
.total{font-size:18px;font-weight:700}
</style></head><body>
<header><div class="logo" aria-label="PayPal"><b>Pay</b><i>Pal</i></div><div class="cart" data-testid="pp-cart-total">${esc(pu.amount.value)} ${esc(cur)}</div></header>
<main><div class="card">
<h1>Pagar a ${esc(brand)}</h1>
<p class="sub">${esc(pu.description ?? 'Revisa tu compra')}</p>
${items ? `<ul>${items}</ul>` : ''}
<div class="acct"><div class="dot">JD</div><div><strong>John Doe</strong><br>sb-buyer@personal.example.com</div></div>
<div class="row"><span>Pagar con</span><span>Saldo PayPal · Visa x-1111</span></div>
<div class="row"><span>Total</span><span class="total" data-testid="pp-total">${esc(pu.amount.value)} ${esc(cur)}</span></div>
<form method="post" action="/__mock/approve/${esc(o.id)}"><button class="btn pay" type="submit" id="payment-submit-btn" data-testid="pp-approve">${o._ctx.user_action === 'CONTINUE' ? 'Continuar' : 'Pagar ahora'}</button></form>
<form method="post" action="/__mock/deny/${esc(o.id)}"><button class="btn cancel" type="submit" data-testid="pp-cancel">Cancelar y volver a ${esc(brand)}</button></form>
<p class="note">Entorno de pruebas simulado · Pedido ${esc(o.id)}</p>
</div></main></body></html>`;
  }

  // ── router ──
  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  function parseJson(raw) {
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw invalidRequest([{ field: '/', issue: 'MALFORMED_REQUEST_JSON', description: 'The request JSON is not well formed.' }]); }
  }
  function send(res, status, body, headers = {}) {
    const h = { 'content-type': 'application/json', 'paypal-debug-id': debugId(), ...headers };
    res.writeHead(status, h);
    res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  }
  function redirect(res, url) { res.writeHead(302, { location: url }); res.end(); }
  function withQuery(url, params) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    const method = req.method;
    const raw = method === 'GET' || method === 'HEAD' ? '' : await readBody(req);
    let m;
    try {
      if (p === '/health') return send(res, 200, { ok: true, mock: 'paypal' });

      if (method === 'POST' && p === '/v1/oauth2/token') { const r = issueToken(req, raw); return send(res, r.status, r.body); }
      if (method === 'POST' && p === '/v2/checkout/orders') { const r = createOrder(req, parseJson(raw)); return send(res, r.status, r.body); }
      if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(p)) && method === 'GET') { const r = getOrder(req, m[1]); return send(res, r.status, r.body); }
      if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(p)) && method === 'POST') { parseJson(raw); const r = captureOrder(req, m[1]); return send(res, r.status, r.body); }
      if ((m = /^\/v2\/payments\/captures\/([^/]+)$/.exec(p)) && method === 'GET') { const r = getCapture(req, m[1]); return send(res, r.status, r.body); }
      if ((m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(p)) && method === 'POST') { const r = refundCapture(req, m[1], parseJson(raw)); return send(res, r.status, r.body); }
      if ((m = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(p)) && method === 'GET') { const r = getRefund(req, m[1]); return send(res, r.status, r.body); }
      if (method === 'POST' && p === '/v1/notifications/verify-webhook-signature') { const r = verifySignature(req, parseJson(raw)); return send(res, r.status, r.body); }

      if (method === 'GET' && p === '/checkoutnow') {
        const o = state.orders.get(url.searchParams.get('token') ?? '');
        if (!o) return send(res, 404, '<!doctype html><title>PayPal</title><p>Este enlace de pago no es válido o expiró.</p>', { 'content-type': 'text/html; charset=utf-8' });
        return send(res, 200, checkoutPage(o), { 'content-type': 'text/html; charset=utf-8' });
      }

      // ── control ──
      if ((m = /^\/__mock\/approve\/([^/]+)$/.exec(p))) {
        const outcome = url.searchParams.get('capture')?.toUpperCase() || undefined;
        if (outcome && !['COMPLETED', 'PENDING', 'DECLINED', 'INSTRUMENT_DECLINED'].includes(outcome)) return send(res, 400, { error: 'capture debe ser COMPLETED|PENDING|DECLINED|INSTRUMENT_DECLINED' });
        const o = approve(m[1], outcome);
        const returnUrl = o._ctx.return_url;
        const target = returnUrl ? withQuery(returnUrl, { token: o.id, PayerID: o._payerId }) : null;
        if (url.searchParams.get('json') === '1' || !target) return send(res, 200, { id: o.id, status: o.status, payer_id: o._payerId, redirect: target });
        return redirect(res, target);
      }
      if ((m = /^\/__mock\/deny\/([^/]+)$/.exec(p))) {
        const o = state.orders.get(m[1]);
        if (!o) throw notFound();
        o._cancelled = true;
        const target = o._ctx.cancel_url ? withQuery(o._ctx.cancel_url, { token: o.id }) : null;
        if (url.searchParams.get('json') === '1' || !target) return send(res, 200, { id: o.id, status: o.status, cancelled: true, redirect: target });
        return redirect(res, target);
      }
      if ((m = /^\/__mock\/send-webhook\/([^/]+)$/.exec(p))) {
        const c = state.captures.get(m[1]);
        if (!c) throw notFound('payments/v2');
        const base = origin(req);
        const byStatus = { COMPLETED: 'PAYMENT.CAPTURE.COMPLETED', PENDING: 'PAYMENT.CAPTURE.PENDING', DECLINED: 'PAYMENT.CAPTURE.DENIED', REFUNDED: 'PAYMENT.CAPTURE.REFUNDED', PARTIALLY_REFUNDED: 'PAYMENT.CAPTURE.REFUNDED' };
        const type = url.searchParams.get('event_type') ?? byStatus[c.status] ?? 'PAYMENT.CAPTURE.COMPLETED';
        let resource;
        if (type === 'PAYMENT.CAPTURE.REFUNDED') {
          const refunds = [...state.refunds.values()].filter((r) => r._captureId === c.id);
          if (!refunds.length) return send(res, 409, { error: 'el capture no tiene reembolsos' });
          resource = refundEventResource(refunds[refunds.length - 1], base);
        } else {
          resource = captureEventResource(c, base);
          if (type === 'PAYMENT.CAPTURE.DENIED') resource.status = 'DECLINED';
        }
        const r = await deliver(buildEvent(type, resource, base), { tamper: url.searchParams.get('tamper') ?? undefined });
        return send(res, 200, r);
      }
      if ((m = /^\/__mock\/captures\/([^/]+)\/(complete|deny)$/.exec(p))) {
        const c = state.captures.get(m[1]);
        if (!c) throw notFound('payments/v2');
        if (c.status !== 'PENDING') return send(res, 409, { error: `capture en estado ${c.status}, no PENDING` });
        const base = origin(req);
        delete c.status_details;
        c.update_time = nowIso();
        if (m[2] === 'complete') {
          c.status = 'COMPLETED';
          const fee = Math.round(c._cents * 0.0349) + 49;
          const cur = c.amount.currency_code;
          c.seller_receivable_breakdown = { gross_amount: money(cur, c._cents), paypal_fee: money(cur, fee), net_amount: money(cur, c._cents - fee) };
        } else c.status = 'DECLINED';
        const r = await deliver(buildEvent(m[2] === 'complete' ? 'PAYMENT.CAPTURE.COMPLETED' : 'PAYMENT.CAPTURE.DENIED', captureEventResource(c, base), base));
        return send(res, 200, r);
      }
      if (p === '/__mock/reset' && method === 'POST') {
        for (const t of state.pendingTimers) clearTimeout(t);
        reset();
        return send(res, 200, { ok: true });
      }
      if (p === '/__mock/config' && method === 'POST') {
        const b = parseJson(raw);
        for (const k of ['autoWebhooks', 'webhookTarget', 'webhookId', 'webhookDelayMs', 'tokenTtlSec']) if (k in b) config[k] = b[k];
        return send(res, 200, omit(config, ['signingSecret', 'clientSecret']));
      }
      if (p === '/__mock/revoke-tokens' && method === 'POST') { state.tokens.clear(); return send(res, 200, { ok: true }); }
      if (p === '/__mock/state' && method === 'GET') {
        const base = origin(req);
        return send(res, 200, {
          orders: [...state.orders.values()].map((o) => ({ ...orderView(o, base), cancelled: Boolean(o._cancelled) })),
          captures: [...state.captures.values()].map((c) => captureView(c, base)),
          refunds: [...state.refunds.values()].map((r) => refundView(r, base)),
          webhooks: state.sentWebhooks,
        });
      }
      return send(res, 404, {
        name: 'NOT_FOUND', message: 'The specified resource does not exist.', debug_id: debugId(),
        details: [{ issue: 'INVALID_RESOURCE_ID', description: `No route for ${method} ${p}` }],
      });
    } catch (e) {
      if (e instanceof PPError) return send(res, e.status, e.body);
      console.error(e);
      return send(res, 500, { name: 'INTERNAL_SERVER_ERROR', message: 'An internal server error has occurred.', debug_id: debugId() });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { name: 'INTERNAL_SERVER_ERROR' }); }); });
  return {
    server,
    listen(port = 0, host) {
      return new Promise((resolve) => server.listen(port, host, () => {
        const addr = server.address();
        if (!options.baseUrl) baseUrl = `http://localhost:${addr.port}`;
        resolve({ port: addr.port, url: `http://localhost:${addr.port}` });
      }));
    },
    close() {
      for (const t of state.pendingTimers) clearTimeout(t);
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    get config() { return config; },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.MOCK_PAYPAL_PORT ?? 4020);
  const mock = createPaypalMock({ baseUrl: process.env.MOCK_PAYPAL_PUBLIC_URL });
  mock.listen(port).then(({ url }) => {
    console.log(`mock paypal escuchando en ${url} · webhooks → ${mock.config.webhookTarget} (auto=${mock.config.autoWebhooks})`);
  });
}
