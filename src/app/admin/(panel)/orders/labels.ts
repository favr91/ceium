// Etiquetas y tonos de estado de pedidos/pagos del panel.
export const ORDER_STATUS: Record<string, { label: string; tone: "success" | "info" | "attention" | "critical" | "neutral" }> = {
  PENDING_PAYMENT: { label: "Pago pendiente", tone: "attention" },
  AWAITING_VERIFICATION: { label: "En verificación", tone: "attention" },
  PARTIALLY_PAID: { label: "Pagado parcialmente", tone: "info" },
  PAID: { label: "Pagado", tone: "success" },
  ENROLLED: { label: "Inscrito", tone: "success" },
  REJECTED: { label: "Rechazado", tone: "critical" },
  CANCELLED: { label: "Cancelado", tone: "neutral" },
  EXPIRED: { label: "Vencido", tone: "neutral" },
  REFUNDED: { label: "Reembolsado", tone: "neutral" },
};
export const PAYMENT_STATUS: Record<string, { label: string; tone: "success" | "info" | "attention" | "critical" | "neutral" }> = {
  PENDING: { label: "Pendiente", tone: "neutral" },
  AWAITING_VERIFICATION: { label: "Por verificar", tone: "attention" },
  COMPLETED: { label: "Confirmado", tone: "success" },
  REJECTED: { label: "Rechazado", tone: "critical" },
  FAILED: { label: "Fallido", tone: "critical" },
  REFUNDED: { label: "Reembolsado", tone: "neutral" },
  PARTIALLY_REFUNDED: { label: "Reembolso parcial", tone: "info" },
  CANCELLED: { label: "Cancelado", tone: "neutral" },
};
export const RESERVATION_STATUS: Record<string, string> = { HELD: "Reservado", CONFIRMED: "Ocupado", RELEASED: "Liberado" };
export const ENROLLMENT_STATUS: Record<string, string> = { PENDING: "Pendiente", ENROLLED: "Matriculado", FAILED: "Falló", UNENROLLED: "Desmatriculado" };
export const ACTOR: Record<string, string> = { SYSTEM: "Sistema", ADMIN: "Panel", CUSTOMER: "Cliente", WEBHOOK: "PayPal (webhook)" };
export const EMAIL_TEMPLATE: Record<string, string> = {
  order_confirmation: "Confirmación de pedido",
  payment_under_verification: "Pago en verificación",
  payment_approved: "Pago aprobado",
  payment_rejected: "Pago rechazado",
  platform_access: "Acceso a la plataforma",
  cohort_details: "Datos de la cohorte",
  certificate_issued: "Certificado emitido",
  installment_reminder: "Recordatorio de cuota",
  refund_issued: "Reembolso",
};
export const EVENT: Record<string, string> = {
  CREATED: "Pedido creado",
  STATUS_CHANGE: "Cambio de estado",
  PAYMENT_SUBMITTED: "Pago registrado por el cliente",
  PAYMENT_VERIFIED: "Pago aprobado",
  PAYMENT_REJECTED: "Pago rechazado",
  PAYMENT_RECEIVED: "Pago recibido",
  REFUND_REQUESTED: "Reembolso solicitado",
  REFUND: "Reembolso aplicado",
  ENROLLMENT: "Matrícula",
  ENROLLMENT_FAILED: "Matrícula fallida",
  UNENROLLMENT: "Desmatrícula en Moodle",
  NOTE: "Nota",
  EMAIL_SENT: "Correo enviado",
  EMAIL_FAILED: "Correo fallido",
  MOODLE_USER: "Cuenta de Moodle",
  MOODLE_USER_CREATE_REQUESTED: "Alta en Moodle solicitada",
  MOODLE_USER_CREATE_UNCONFIRMED: "Alta en Moodle sin confirmar",
  ATTENTION: "Requiere atención",
  CUSTOMER_UPDATED: "Cliente actualizado",
  COHORT_REASSIGNED: "Cohorte reasignada",
  CERTIFICATE_ISSUED: "Certificado emitido",
  CERTIFICATE_REVOKED: "Certificado revocado",
  INSTALLMENT_PAID: "Cuota pagada",
  INSTALLMENT_OVERDUE: "Cuota vencida",
  PAYPAL_ORDER_CREATED: "Pago PayPal iniciado",
  PAYMENT_CAPTURED: "Pago PayPal capturado",
  PAYMENT_FAILED: "Pago fallido",
  PAYMENT_NOT_CAPTURED: "Pago PayPal no capturado",
  PAYMENT_PENDING_REVIEW: "PayPal retuvo el pago",
  SEAT_HOLD_EXTENDED: "Reserva extendida",
  SEAT_REACQUIRED: "Cupo vuelto a tomar",
  SEAT_UNAVAILABLE: "Sin cupo",
  SEAT_RELEASED: "Cupo liberado",
};
export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dateTime = (d: Date | string) =>
  new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Caracas" }).format(new Date(d));
