// Tipos de la API REST de PayPal (Orders v2, Payments v2, Webhooks v1) — solo los campos que usamos.
// Nombres de campo idénticos a developer.paypal.com/docs/api/orders/v2 y /webhooks/v1.

export interface Money {
  currency_code: string;
  /** Decimal como string, p.ej. "180.00" */
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

export type OrderStatus = "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
export type CaptureStatus = "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
export type RefundStatus = "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";

export interface PayPalItem {
  name: string;
  quantity: string;
  unit_amount: Money;
  sku?: string;
  description?: string;
  category?: "DIGITAL_GOODS" | "PHYSICAL_GOODS" | "DONATION";
}

export interface PurchaseUnitRequest {
  reference_id?: string;
  description?: string;
  custom_id?: string;
  invoice_id?: string;
  soft_descriptor?: string;
  amount: Money & { breakdown?: { item_total?: Money; tax_total?: Money; discount?: Money } };
  items?: PayPalItem[];
}

export interface ExperienceContext {
  brand_name?: string;
  locale?: string;
  shipping_preference?: "GET_FROM_FILE" | "NO_SHIPPING" | "SET_PROVIDED_ADDRESS";
  user_action?: "CONTINUE" | "PAY_NOW";
  landing_page?: "LOGIN" | "GUEST_CHECKOUT" | "NO_PREFERENCE";
  payment_method_preference?: "UNRESTRICTED" | "IMMEDIATE_PAYMENT_REQUIRED";
  return_url?: string;
  cancel_url?: string;
}

export interface CreateOrderRequest {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: PurchaseUnitRequest[];
  payment_source?: { paypal: { experience_context?: ExperienceContext } };
  /** Legado; PayPal recomienda payment_source.paypal.experience_context. */
  application_context?: ExperienceContext;
}

export interface SellerReceivableBreakdown {
  gross_amount: Money;
  paypal_fee?: Money;
  net_amount?: Money;
}

export interface Capture {
  id: string;
  status: CaptureStatus;
  status_details?: { reason?: string };
  amount: Money;
  final_capture?: boolean;
  seller_protection?: { status: string; dispute_categories?: string[] };
  seller_receivable_breakdown?: SellerReceivableBreakdown;
  custom_id?: string;
  invoice_id?: string;
  create_time?: string;
  update_time?: string;
  links?: Link[];
  /** Presente en recursos de webhook */
  supplementary_data?: { related_ids?: { order_id?: string } };
}

export interface Refund {
  id: string;
  status: RefundStatus;
  status_details?: { reason?: string };
  amount?: Money;
  invoice_id?: string;
  custom_id?: string;
  note_to_payer?: string;
  seller_payable_breakdown?: {
    gross_amount?: Money;
    paypal_fee?: Money;
    net_amount?: Money;
    total_refunded_amount?: Money;
  };
  create_time?: string;
  update_time?: string;
  links?: Link[];
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
}

export interface Payer {
  name?: { given_name?: string; surname?: string };
  email_address?: string;
  payer_id?: string;
  address?: { country_code?: string };
}

export interface PurchaseUnit {
  reference_id?: string;
  description?: string;
  custom_id?: string;
  invoice_id?: string;
  amount?: Money;
  payee?: { email_address?: string; merchant_id?: string };
  items?: PayPalItem[];
  payments?: { captures?: Capture[]; refunds?: Refund[] };
}

export interface Order {
  id: string;
  status: OrderStatus;
  intent?: "CAPTURE" | "AUTHORIZE";
  payment_source?: { paypal?: { email_address?: string; account_id?: string; account_status?: string; name?: Payer["name"] } };
  purchase_units?: PurchaseUnit[];
  payer?: Payer;
  create_time?: string;
  update_time?: string;
  links: Link[];
}

export interface WebhookEvent<R = Capture | Refund | Record<string, unknown>> {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: string;
  resource_version?: string;
  event_type: string;
  summary?: string;
  resource: R;
  links?: Link[];
}

export type PayPalErrorDetail = {
  field?: string;
  value?: string;
  location?: string;
  issue: string;
  description?: string;
};

/** Cuerpo de error estándar de PayPal (o de OAuth: error/error_description). */
export interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  links?: Link[];
  error?: string;
  error_description?: string;
}
