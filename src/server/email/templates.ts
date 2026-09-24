// Plantillas de correo transaccional (español de Venezuela). Funciones puras: datos → {subject, html, text}.
// Estilo alineado con la tienda: tinta #001E2B, acento teal #09B0B0, Inter con fallbacks de sistema.
import { formatUSD } from "@/server/pricing";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface OrderItemView {
  title: string;
  modalityLabel: string; // "Online" | "Semipresencial — Barquisimeto"
  choiceLabel?: string | null;
  planLabel?: string | null;
  cohortName?: string | null;
  totalCents: number;
  dueNowCents: number;
}

export interface OrderView {
  number: number;
  statusUrl: string;
  customerFirstName: string;
  customerEmail: string;
  items: OrderItemView[];
  totalCents: number;
  dueNowCents: number;
  amountPaidCents: number;
  balanceCents: number;
  paymentMethodLabel?: string | null;
  expiresAt?: Date | null;
}

export interface PaymentView {
  methodLabel: string;
  amountLabel: string; // "$120.00" o "Bs. 12.000,00 (≈ $120.00)"
  reference?: string | null;
  date?: Date | null;
}

export interface ManualInstructionsView {
  label: string;
  details: Record<string, string>;
  instructions: string;
  amountLabel: string;
}

export const METHOD_LABELS: Record<string, string> = {
  PAYPAL: "PayPal",
  PAGO_MOVIL: "Pago móvil",
  TRANSFERENCIA: "Transferencia bancaria",
  ZELLE: "Zelle",
  EFECTIVO: "Efectivo",
};

const DETAIL_LABELS: Record<string, string> = {
  banco: "Banco",
  telefono: "Teléfono",
  cedulaRif: "Cédula / RIF",
  titular: "Titular",
  cuenta: "Cuenta",
  tipo: "Tipo de cuenta",
  correo: "Correo",
  lugar: "Lugar",
};

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TZ = "America/Caracas";
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("es-VE", { day: "numeric", month: "long", year: "numeric", timeZone: TZ });
}
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("es-VE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
}
export function formatVES(cents: number): string {
  return "Bs. " + (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ───────────── Layout ─────────────
const INK = "#001E2B";
const TEAL = "#09B0B0";
const MUTED = "#5c6b73";
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function layout(title: string, preheader: string, body: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f7;font-family:${FONT};color:${INK};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:${INK};padding:20px 32px;"><span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:1px;">CEIUM</span>
<span style="color:${TEAL};font-size:12px;display:block;margin-top:2px;">Centro de Enseñanza e Investigación de Ultrasonido en Medicina</span></td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6;">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${INK};">${esc(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e6ebed;font-size:12px;color:${MUTED};">
¿Tienes preguntas? Responde a este correo o escríbenos a registroceium@gmail.com.<br>CEIUM · Barquisimeto · Caracas · Maracaibo
</td></tr></table></td></tr></table></body></html>`;
}

const p = (html: string) => `<p style="margin:0 0 14px;">${html}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:24px 0;"><a href="${esc(href)}" style="background:${TEAL};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block;">${esc(label)}</a></p>`;
const kv = (rows: [string, string][]) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 18px;border-collapse:collapse;">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:${MUTED};width:42%;vertical-align:top;">${esc(k)}</td><td style="padding:6px 0;font-weight:600;">${esc(v)}</td></tr>`)
    .join("")}</table>`;

function itemsTable(v: OrderView): string {
  const rows = v.items
    .map((it) => {
      const meta = [it.modalityLabel, it.choiceLabel, it.cohortName, it.planLabel].filter(Boolean).map(esc).join(" · ");
      return `<tr><td style="padding:10px 0;border-bottom:1px solid #e6ebed;"><strong>${esc(it.title)}</strong><br><span style="font-size:13px;color:${MUTED};">${meta}</span></td>
<td style="padding:10px 0;border-bottom:1px solid #e6ebed;text-align:right;white-space:nowrap;vertical-align:top;">${formatUSD(it.totalCents)}</td></tr>`;
    })
    .join("");
  const totals: [string, number][] = [["Total del programa", v.totalCents]];
  if (v.dueNowCents !== v.totalCents) totals.push(["Primer pago", v.dueNowCents]);
  if (v.amountPaidCents > 0) totals.push(["Pagado", v.amountPaidCents]);
  if (v.amountPaidCents > 0 && v.balanceCents > 0) totals.push(["Saldo pendiente", v.balanceCents]);
  const trows = totals.map(([k, c]) => `<tr><td style="padding:6px 0;color:${MUTED};">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600;">${formatUSD(c)}</td></tr>`).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:8px 0 18px;">${rows}${trows}</table>`;
}

function itemsText(v: OrderView): string {
  const lines = v.items.map((it) => `- ${it.title} (${[it.modalityLabel, it.choiceLabel, it.cohortName, it.planLabel].filter(Boolean).join(" · ")}): ${formatUSD(it.totalCents)}`);
  lines.push(`Total del programa: ${formatUSD(v.totalCents)}`);
  if (v.dueNowCents !== v.totalCents) lines.push(`Primer pago: ${formatUSD(v.dueNowCents)}`);
  if (v.amountPaidCents > 0) lines.push(`Pagado: ${formatUSD(v.amountPaidCents)}`);
  if (v.amountPaidCents > 0 && v.balanceCents > 0) lines.push(`Saldo pendiente: ${formatUSD(v.balanceCents)}`);
  return lines.join("\n");
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");

// ───────────── Plantillas ─────────────

export function orderConfirmation(v: OrderView, opts: { paid: boolean; manual?: ManualInstructionsView }): RenderedEmail {
  const subject = opts.paid ? `Compra confirmada — Pedido #${v.number}` : `Recibimos tu pedido #${v.number}`;
  const intro = opts.paid
    ? `Hola ${esc(v.customerFirstName)}, ¡gracias por tu compra! Recibimos tu pago y estamos activando tu acceso a la plataforma.`
    : `Hola ${esc(v.customerFirstName)}, recibimos tu pedido. Para completar la inscripción realiza el pago y registra tu comprobante.`;
  let manual = "";
  let manualText = "";
  if (!opts.paid && opts.manual) {
    const m = opts.manual;
    const rows: [string, string][] = [["Monto a pagar", m.amountLabel], ...Object.entries(m.details).map(([k, val]) => [DETAIL_LABELS[k] ?? k, val] as [string, string])];
    manual = `<h2 style="font-size:17px;margin:24px 0 8px;">Datos para pagar con ${esc(m.label)}</h2>${kv(rows)}${p(esc(m.instructions))}`;
    if (v.expiresAt) manual += p(`Tu cupo queda reservado hasta el <strong>${esc(formatDateTime(v.expiresAt))}</strong>.`);
    manualText = `\n\nDatos para pagar con ${m.label}:\n${rows.map(([k, val]) => `${k}: ${val}`).join("\n")}\n${m.instructions}` + (v.expiresAt ? `\nCupo reservado hasta: ${formatDateTime(v.expiresAt)}` : "");
  }
  const html = layout(subject, stripTags(intro), p(intro) + itemsTable(v) + manual + button(v.statusUrl, opts.paid ? "Ver mi pedido" : "Registrar mi pago"));
  const text = `${stripTags(intro)}\n\nPedido #${v.number}\n${itemsText(v)}${manualText}\n\nVer pedido: ${v.statusUrl}`;
  return { subject, html, text };
}

export function paymentUnderVerification(v: OrderView, pay: PaymentView): RenderedEmail {
  const subject = `Estamos verificando tu pago — Pedido #${v.number}`;
  const intro = `Hola ${esc(v.customerFirstName)}, recibimos el comprobante de tu pago. Nuestro equipo lo verificará y te avisaremos por este medio (normalmente en menos de 24 horas hábiles).`;
  const rows: [string, string][] = [["Método", pay.methodLabel], ["Monto", pay.amountLabel]];
  if (pay.reference) rows.push(["Referencia", pay.reference]);
  if (pay.date) rows.push(["Fecha del pago", formatDate(pay.date)]);
  const html = layout(subject, "Recibimos tu comprobante", p(intro) + kv(rows) + itemsTable(v) + button(v.statusUrl, "Ver estado del pedido"));
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${itemsText(v)}\n\nEstado: ${v.statusUrl}`;
  return { subject, html, text };
}

export function paymentApproved(v: OrderView, pay: PaymentView): RenderedEmail {
  const subject = `Pago aprobado — Pedido #${v.number}`;
  const intro = `Hola ${esc(v.customerFirstName)}, verificamos y aprobamos tu pago de ${esc(pay.amountLabel)}.`;
  const rows: [string, string][] = [["Método", pay.methodLabel], ["Monto", pay.amountLabel]];
  if (pay.reference) rows.push(["Referencia", pay.reference]);
  const html = layout(subject, "Tu pago fue aprobado", p(intro) + kv(rows) + itemsTable(v) + button(v.statusUrl, "Ver mi pedido"));
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${itemsText(v)}\n\nPedido: ${v.statusUrl}`;
  return { subject, html, text };
}

export function paymentRejected(v: OrderView, pay: PaymentView, reason: string | null | undefined, orderClosed: boolean): RenderedEmail {
  const subject = `No pudimos verificar tu pago — Pedido #${v.number}`;
  const intro = `Hola ${esc(v.customerFirstName)}, revisamos el pago que registraste y no pudimos confirmarlo.`;
  const why = reason ? p(`<strong>Motivo:</strong> ${esc(reason)}`) : "";
  const next = orderClosed
    ? p("El cupo reservado fue liberado. Si crees que se trata de un error, responde a este correo con tu comprobante y te ayudaremos.")
    : p("Puedes registrar nuevamente el pago desde la página de tu pedido.");
  const rows: [string, string][] = [["Método", pay.methodLabel], ["Monto declarado", pay.amountLabel]];
  if (pay.reference) rows.push(["Referencia", pay.reference]);
  const html = layout(subject, "Tu pago no pudo ser verificado", p(intro) + why + kv(rows) + next + button(v.statusUrl, "Ver mi pedido"));
  const text = `${stripTags(intro)}\n${reason ? `Motivo: ${reason}\n` : ""}\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${stripTags(next)}\n\nPedido: ${v.statusUrl}`;
  return { subject, html, text };
}

export interface PlatformAccessView {
  firstName: string;
  username: string;
  loginUrl: string;
  tempPassword?: string;
  courses: string[];
  /** true si la matrícula aún se está procesando (se envió porque la cuenta es nueva). */
  activationPending?: boolean;
}

export function platformAccess(a: PlatformAccessView): RenderedEmail {
  const subject = a.tempPassword ? "Tus datos de acceso a la plataforma CEIUM" : "Ya tienes acceso a tus cursos en la plataforma CEIUM";
  const intro = a.activationPending
    ? `Hola ${esc(a.firstName)}, creamos tu cuenta en la plataforma de CEIUM. Tus cursos se activarán en breve.`
    : `Hola ${esc(a.firstName)}, ya estás inscrito. Ingresa a la plataforma para comenzar.`;
  const rows: [string, string][] = [["Plataforma", a.loginUrl], ["Usuario", a.username]];
  if (a.tempPassword) rows.push(["Contraseña temporal", a.tempPassword]);
  const pwNote = a.tempPassword
    ? p("Por seguridad, la plataforma te pedirá cambiar la contraseña temporal en tu primer ingreso.")
    : p("Usa la contraseña que ya tienes en la plataforma. Si no la recuerdas, usa la opción «¿Olvidó su nombre de usuario o contraseña?».");
  const courses = a.courses.length
    ? `<h2 style="font-size:17px;margin:24px 0 8px;">Cursos</h2><ul style="margin:0 0 18px;padding-left:20px;">${a.courses.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
    : "";
  const html = layout(subject, "Acceso a la plataforma", p(intro) + kv(rows) + pwNote + courses + button(a.loginUrl, "Ingresar a la plataforma"));
  const text = `${stripTags(intro)}\n\nPlataforma: ${a.loginUrl}\nUsuario: ${a.username}${a.tempPassword ? `\nContraseña temporal: ${a.tempPassword}` : ""}\n\n${stripTags(pwNote)}${a.courses.length ? `\n\nCursos:\n${a.courses.map((c) => `- ${c}`).join("\n")}` : ""}`;
  return { subject, html, text };
}

export interface CohortView {
  firstName: string;
  productTitle: string;
  cohortName: string;
  sedeName: string;
  sedeAddress?: string | null;
  startDate: Date;
  endDate: Date;
  sessions: { date: string; title?: string; startTime?: string; endTime?: string }[];
  notes?: string | null;
  orderNumber: number;
}

export function cohortDetails(c: CohortView): RenderedEmail {
  const subject = `Tu cohorte en ${c.sedeName}: ${c.productTitle}`;
  const intro = `Hola ${esc(c.firstName)}, estos son los datos de tu cohorte semipresencial.`;
  const rows: [string, string][] = [
    ["Programa", c.productTitle],
    ["Cohorte", c.cohortName],
    ["Sede", c.sedeName],
    ["Inicio", formatDate(c.startDate)],
    ["Fin", formatDate(c.endDate)],
  ];
  if (c.sedeAddress) rows.push(["Dirección", c.sedeAddress]);
  const sess = c.sessions.length
    ? `<h2 style="font-size:17px;margin:24px 0 8px;">Sesiones presenciales</h2><ul style="margin:0 0 18px;padding-left:20px;">${c.sessions
        .map((s) => `<li>${esc(formatDate(s.date + "T12:00:00-04:00"))}${s.startTime ? ` · ${esc(s.startTime)}${s.endTime ? `–${esc(s.endTime)}` : ""}` : ""}${s.title ? ` — ${esc(s.title)}` : ""}</li>`)
        .join("")}</ul>`
    : "";
  const notes = c.notes ? p(esc(c.notes)) : "";
  const html = layout(subject, `Cohorte ${c.cohortName} — ${c.sedeName}`, p(intro) + kv(rows) + sess + notes);
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}${c.sessions.length ? `\n\nSesiones:\n${c.sessions.map((s) => `- ${formatDate(s.date + "T12:00:00-04:00")}${s.title ? ` — ${s.title}` : ""}`).join("\n")}` : ""}${c.notes ? `\n\n${c.notes}` : ""}`;
  return { subject, html, text };
}

export interface CertificateView {
  firstName: string;
  fullName: string;
  diplomaTitle: string;
  code: string;
  verifyUrl: string;
  issuedAt: Date;
}

export function certificateIssued(c: CertificateView): RenderedEmail {
  const subject = `¡Felicitaciones! Tu certificado del ${c.diplomaTitle}`;
  const intro = `Hola ${esc(c.firstName)}, completaste todos los cursos del <strong>${esc(c.diplomaTitle)}</strong>. Adjuntamos tu certificado en PDF.`;
  const rows: [string, string][] = [
    ["Titular", c.fullName],
    ["Código de verificación", c.code],
    ["Fecha de emisión", formatDate(c.issuedAt)],
  ];
  const html = layout(subject, "Tu certificado está listo", p(intro) + kv(rows) + p("Cualquier persona puede verificar la autenticidad del certificado con el código en el siguiente enlace.") + button(c.verifyUrl, "Verificar certificado"));
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\nVerificación: ${c.verifyUrl}`;
  return { subject, html, text };
}

export function refundIssued(v: OrderView, r: { amountCents: number; methodLabel: string; reason?: string | null; full: boolean }): RenderedEmail {
  const subject = `Reembolso procesado — Pedido #${v.number}`;
  const intro = `Hola ${esc(v.customerFirstName)}, procesamos un reembolso ${r.full ? "total" : "parcial"} de <strong>${formatUSD(r.amountCents)}</strong> de tu pedido #${v.number}.`;
  const rows: [string, string][] = [["Monto", formatUSD(r.amountCents)], ["Método", r.methodLabel]];
  if (r.reason) rows.push(["Motivo", r.reason]);
  const how = r.methodLabel === "PayPal" ? p("El dinero se acreditará en tu cuenta PayPal; puede tardar algunos días hábiles en reflejarse.") : p("El reembolso se realizó por el mismo medio de pago o el acordado con nuestro equipo.");
  const html = layout(subject, "Reembolso procesado", p(intro) + kv(rows) + how + button(v.statusUrl, "Ver mi pedido"));
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${stripTags(how)}\n\nPedido: ${v.statusUrl}`;
  return { subject, html, text };
}

export interface InstallmentReminderView {
  firstName: string;
  orderNumber: number;
  sequence: number;
  totalInstallments: number;
  /** Diplomado / programa del ítem. */
  programTitle?: string | null;
  /** Mes a mes: curso que habilita esta cuota. */
  courseTitle?: string | null;
  amountCents: number;
  dueDate?: Date | null;
  overdue: boolean;
  balanceCents: number;
  /** Enlace de PayPal; null cuando PayPal no está habilitado (no se ofrece). */
  paypalUrl: string | null;
  /** Enlace para registrar un pago manual; null cuando no hay ningún método manual habilitado. */
  manualUrl: string | null;
  /** Métodos manuales realmente ofrecidos (p.ej. "Pago móvil o Zelle"); solo se usa con manualUrl. */
  manualLabel?: string | null;
  statusUrl: string;
}

export function installmentReminder(r: InstallmentReminderView): RenderedEmail {
  const subject = r.overdue
    ? `Cuota vencida — Pedido #${r.orderNumber}${r.courseTitle ? `: ${r.courseTitle}` : ""}`
    : r.courseTitle
      ? `Paga tu próximo curso: ${r.courseTitle}`
      : `Recordatorio de pago — Pedido #${r.orderNumber}`;
  const when = r.dueDate ? (r.overdue ? `venció el <strong>${esc(formatDate(r.dueDate))}</strong>` : `vence el <strong>${esc(formatDate(r.dueDate))}</strong>`) : "está pendiente";
  const intro = `Hola ${esc(r.firstName)}, la cuota ${r.sequence} de ${r.totalInstallments}${r.programTitle ? ` del <strong>${esc(r.programTitle)}</strong>` : ""} ${when}.`;
  const unlock = r.courseTitle
    ? p(`Al confirmarse el pago te matricularemos en <strong>${esc(r.courseTitle)}</strong> en la plataforma y te avisaremos por correo.`)
    : "";
  const rows: [string, string][] = [
    ["Pedido", `#${r.orderNumber}`],
    ["Cuota", `${r.sequence} de ${r.totalInstallments}`],
  ];
  if (r.courseTitle) rows.push(["Curso", r.courseTitle]);
  rows.push(["Monto", formatUSD(r.amountCents)]);
  if (r.dueDate) rows.push([r.overdue ? "Venció" : "Vence", formatDate(r.dueDate)]);
  rows.push(["Saldo total pendiente", formatUSD(r.balanceCents)]);
  const manualLabel = r.manualLabel || "otro método de pago";
  let buttons = "";
  const textPay: string[] = [];
  if (r.paypalUrl) {
    buttons += button(r.paypalUrl, `Pagar ${formatUSD(r.amountCents)} con PayPal`);
    textPay.push(`Pagar con PayPal: ${r.paypalUrl}`);
  }
  if (r.manualUrl) {
    buttons += r.paypalUrl
      ? p(`¿Prefieres pagar con ${esc(manualLabel)}? <a href="${esc(r.manualUrl)}" style="color:${TEAL};font-weight:600;">Registra tu pago aquí</a> y nuestro equipo lo verificará.`)
      : button(r.manualUrl, `Pagar ${formatUSD(r.amountCents)} con ${manualLabel}`) + p("Registra tu pago y nuestro equipo lo verificará.");
    textPay.push(`Pagar con ${manualLabel}: ${r.manualUrl}`);
  }
  if (!r.paypalUrl && !r.manualUrl) {
    buttons += p(`En este momento no hay métodos de pago en línea disponibles. Responde a este correo o revisa <a href="${esc(r.statusUrl)}" style="color:${TEAL};font-weight:600;">tu pedido</a> y te indicaremos cómo pagar.`);
    textPay.push("En este momento no hay métodos de pago en línea disponibles. Responde a este correo y te indicaremos cómo pagar.");
  }
  const html = layout(subject, stripTags(`Cuota ${r.sequence} de ${r.totalInstallments}: ${formatUSD(r.amountCents)}`), p(intro) + kv(rows) + unlock + buttons);
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n${r.courseTitle ? `\nAl confirmarse el pago te matricularemos en ${r.courseTitle}.\n` : ""}\n${textPay.join("\n")}\n\nPedido: ${r.statusUrl}`;
  return { subject, html, text };
}
