// Plantillas de correo transaccional (español de Venezuela). Funciones puras: datos → {subject, html, text}.
// Diseño de correo de pedido de Shopify (cabecera logo + «PEDIDO #N», título, botón principal + enlace a la
// tienda, resumen con miniaturas, datos del cliente en dos columnas, pie de contacto) con la marca de ceium.net:
// tinta #001E2B, teal #09B0B0, Inter con fallbacks de sistema. Además, lo que el médico necesita en cada paso:
// progreso del pedido, monto y datos para pagar, credenciales del aula virtual, cohorte con dirección y sesiones.
// HTML de correo: tablas y estilos en línea (Gmail, Outlook, Apple Mail); media query solo para apilar en móvil.
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
  /** Miniatura del programa (URL absoluta). */
  imageUrl?: string | null;
  quantity?: number;
  /** Precio de lista antes del descuento del plan (se muestra tachado si es mayor que el total). */
  listCents?: number | null;
  /** Fechas de la cohorte (semipresencial). */
  cohortDates?: string | null;
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
  /** Datos opcionales para el bloque «Datos del médico» y los totales. */
  customerFullName?: string | null;
  customerPhone?: string | null;
  customerCedula?: string | null;
  placedAt?: Date | null;
  subtotalCents?: number | null;
  discountCents?: number | null;
  storeUrl?: string | null;
  /** Plan mes a mes: cuotas en orden. */
  installments?: { sequence: number; amountCents: number; status: string; courseTitle?: string | null; dueDate?: Date | null }[];
}

export interface PaymentView {
  methodLabel: string;
  amountLabel: string; // "$120.00" o "Bs. 12.000,00 (≈ $120.00)"
  reference?: string | null;
  date?: Date | null;
}

export interface ManualInstructionsView {
  label: string;
  /** Nombre del método dentro de una frase («pago móvil», «transferencia bancaria»). */
  inText?: string;
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
  cedulaRif: "Cédula/RIF",
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
/** Cierra la oración con punto, salvo que ya termine en uno (una fecha termina en «p. m.»). */
const period = (s: string) => (s.endsWith(".") ? s : `${s}.`);
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("es-VE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ });
}
export function formatVES(cents: number): string {
  return "Bs. " + (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function weekdayDate(d: Date | string): string {
  const s = new Date(d).toLocaleDateString("es-VE", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ───────────── Sistema visual ─────────────
const INK = "#001E2B";
const TEAL = "#09B0B0";
const TEAL_INK = "#067C7C"; // teal legible sobre blanco (enlaces de texto)
const MUTED = "#5C6B73";
const LINE = "#E3E8EA";
const SOFT = "#F4F7F8";
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const CONTACT_EMAIL = "registroceium@gmail.com";
const WHATSAPP = { label: "+58 412-0840718", href: "https://wa.me/584120840718" };

function base(): string {
  return (process.env.APP_URL ?? "").replace(/\/$/, "");
}
/** Logo PNG (los clientes de correo no muestran SVG). Servido por la app; sin APP_URL, el del CDN de ceium.net. */
function logoUrl(): string {
  const b = base();
  return b ? `${b}/email/logo-ceium.png` : "https://cdn.shopify.com/s/files/1/0653/7986/0524/files/Rediseno-logotipo--CEIUM_4_x320.png?v=1732738364";
}
function absolute(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  const b = base();
  return b && url.startsWith("/") ? `${b}${url}` : null;
}

interface LayoutOpts {
  /** <title> y título visible. */
  title: string;
  preheader: string;
  /** Rótulo de la cabecera a la derecha (p. ej. «PEDIDO #1001»). */
  tag?: string;
  body: string;
}

function layout({ title, preheader, tag, body }: LayoutOpts): string {
  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
a{color:${TEAL_INK}}
@media (max-width:600px){
 .c-shell{padding:0 16px!important}
 .c-head{padding:24px 0 20px!important}
 .c-h1{font-size:22px!important}
 .c-col{display:block!important;width:100%!important;padding:0 0 20px!important}
 .c-btn-cell{display:block!important;width:100%!important}
 .c-btn-t,.c-btn-o{width:100%!important}
 .c-btn{display:block!important;text-align:center!important}
 .c-or{display:block!important;padding:14px 0 0!important;text-align:center!important}
 .c-big{font-size:26px!important}
 .c-hide-m{display:none!important}
}
</style></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:${FONT};color:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${esc(preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td align="center" class="c-shell" style="padding:0 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td class="c-head" style="padding:36px 0 28px;border-bottom:1px solid ${LINE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle"><a href="${esc(base() || "https://ceium.net")}" style="text-decoration:none;"><img src="${esc(logoUrl())}" width="132" height="48" alt="CEIUM" style="display:block;border:0;width:132px;height:auto;max-width:132px;"></a></td>
${tag ? `<td valign="middle" align="right" style="font-size:13px;line-height:18px;color:${MUTED};text-transform:uppercase;letter-spacing:.08em;font-weight:600;white-space:nowrap;">${esc(tag)}</td>` : ""}
</tr></table>
</td></tr>
<tr><td style="padding:32px 0 0;">
<h1 class="c-h1" style="margin:0 0 12px;font-size:24px;line-height:32px;font-weight:700;color:${INK};letter-spacing:-.01em;">${esc(title)}</h1>
${body}
</td></tr>
${footer()}
</table>
</td></tr></table>
</body></html>`;
}

function footer(): string {
  return `<tr><td style="padding:28px 0 40px;border-top:1px solid ${LINE};font-size:13px;line-height:20px;color:${MUTED};">
<p style="margin:0 0 8px;">¿Tienes preguntas? Responde a este correo, escríbenos a <a href="mailto:${CONTACT_EMAIL}" style="color:${TEAL_INK};text-decoration:none;font-weight:600;">${CONTACT_EMAIL}</a> o por <a href="${WHATSAPP.href}" style="color:${TEAL_INK};text-decoration:none;font-weight:600;white-space:nowrap;">WhatsApp ${WHATSAPP.label}</a>.</p>
<p style="margin:0;color:#8A979E;">CEIUM · Centro de Enseñanza e Investigación de Ultrasonido en Medicina<br>Barquisimeto · Caracas · Maracaibo</p>
</td></tr>`;
}

const p = (html: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${MUTED};">${html}</p>`;
const strong = (s: string) => `<strong style="color:${INK};font-weight:600;">${s}</strong>`;

function button(href: string, label: string, opts: { secondary?: { href: string; label: string }; paypal?: boolean } = {}): string {
  const bg = opts.paypal ? "#FFC439" : TEAL;
  const fg = opts.paypal ? "#111111" : "#ffffff";
  const sec = opts.secondary
    ? `<td class="c-or" valign="middle" style="padding:0 0 0 18px;font-size:15px;line-height:20px;color:${MUTED};">o <a href="${esc(opts.secondary.href)}" style="color:${TEAL_INK};text-decoration:none;font-weight:600;">${esc(opts.secondary.label)}</a></td>`
    : "";
  return `<table class="c-btn-o" role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 32px;"><tr>
<td class="c-btn-cell" valign="middle"><table class="c-btn-t" role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${bg}" style="border-radius:6px;background:${bg};">
<a class="c-btn" href="${esc(href)}" style="display:inline-block;padding:15px 26px;font-size:16px;line-height:20px;font-weight:600;color:${fg};text-decoration:none;border-radius:6px;font-family:${FONT};">${esc(label)}</a>
</td></tr></table></td>${sec}
</tr></table>`;
}

function section(title: string, content: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE};"><tr><td style="padding:28px 0 12px;">
<h2 style="margin:0 0 18px;font-size:18px;line-height:24px;font-weight:700;color:${INK};">${esc(title)}</h2>
${content}
</td></tr></table>`;
}

/** Filas etiqueta → valor (valores ya escapados como texto). */
function kv(rows: [string, string][], opts: { boxed?: boolean; mono?: string[] } = {}): string {
  const trs = rows
    .map(([k, v], i) => {
      const mono = opts.mono?.includes(k);
      const border = i < rows.length - 1 ? `border-bottom:1px solid ${LINE};` : "";
      return `<tr><td style="padding:10px ${opts.boxed ? "0 10px 16px" : "0"};${border}font-size:14px;line-height:20px;color:${MUTED};width:42%;vertical-align:top;">${esc(k)}</td><td style="padding:10px ${opts.boxed ? "16px 10px 0" : "0"};${border}font-size:15px;line-height:20px;color:${INK};font-weight:600;vertical-align:top;${mono ? "font-family:'SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:.02em;" : ""}word-break:break-word;">${esc(v)}</td></tr>`;
    })
    .join("");
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${trs}</table>`;
  return opts.boxed
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;border:1px solid ${LINE};border-radius:8px;border-collapse:separate;"><tr><td style="padding:6px 0;">${table}</td></tr></table>`
    : `<div style="margin:0 0 20px;">${table}</div>`;
}

/** Recuadro de aviso (motivo de rechazo, plazo de reserva…). */
function notice(html: string, tone: "info" | "warn" | "ok" = "info"): string {
  const c = tone === "warn" ? { bg: "#FFF5F5", bar: "#D72C0D" } : tone === "ok" ? { bg: "#EEF9F9", bar: TEAL } : { bg: SOFT, bar: "#9AA7AD" };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td style="background:${c.bg};border-left:4px solid ${c.bar};border-radius:6px;padding:14px 16px;font-size:15px;line-height:22px;color:${INK};">${html}</td></tr></table>`;
}

/** Monto destacado (lo que hay que pagar / lo reembolsado). */
function bigAmount(label: string, amount: string, sub?: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="background:${SOFT};border-radius:8px;padding:18px 20px;">
<div style="font-size:13px;line-height:18px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;font-weight:600;">${esc(label)}</div>
<div class="c-big" style="font-size:30px;line-height:38px;font-weight:700;color:${INK};margin-top:4px;">${esc(amount)}</div>
${sub ? `<div style="font-size:14px;line-height:20px;color:${MUTED};margin-top:2px;">${sub}</div>` : ""}
</td></tr></table>`;
}

type StepState = "done" | "active" | "todo";
/** Barra de progreso del pedido (como la del correo de envío de Shopify, con los pasos de CEIUM). */
function progress(steps: { label: string; state: StepState }[]): string {
  const w = Math.floor(100 / steps.length);
  const cells = steps
    .map((s) => {
      const color = s.state === "todo" ? "#C9D2D6" : TEAL;
      const dot =
        s.state === "done"
          ? `<span style="display:inline-block;width:22px;height:22px;line-height:22px;border-radius:11px;background:${TEAL};color:#ffffff;font-size:13px;font-weight:700;text-align:center;">&#10003;</span>`
          : s.state === "active"
            ? `<span style="display:inline-block;width:14px;height:14px;border-radius:11px;border:4px solid ${TEAL};background:#ffffff;"></span>`
            : `<span style="display:inline-block;width:18px;height:18px;border-radius:11px;border:2px solid #C9D2D6;background:#ffffff;"></span>`;
      return `<td width="${w}%" valign="top" style="padding:0 4px;">
<div style="height:4px;border-radius:2px;background:${color};margin:0 0 10px;font-size:0;line-height:0;">&nbsp;</div>
<div style="height:24px;">${dot}</div>
<div style="font-size:13px;line-height:18px;color:${s.state === "todo" ? MUTED : INK};font-weight:${s.state === "active" ? 700 : 600};margin-top:4px;">${esc(s.label)}</div>
</td>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px;table-layout:fixed;"><tr>${cells}</tr></table>`;
}

function itemMeta(it: OrderItemView): string {
  return [it.modalityLabel, it.choiceLabel, it.planLabel].filter(Boolean).map(esc).join(" · ");
}

function itemsBlock(v: OrderView): string {
  const rows = v.items
    .map((it) => {
      const img = absolute(it.imageUrl);
      const thumb = img
        ? `<img src="${esc(img)}" width="60" height="60" alt="" style="display:block;width:60px;height:60px;border-radius:8px;border:1px solid ${LINE};object-fit:cover;">`
        : `<div style="width:60px;height:60px;border-radius:8px;border:1px solid ${LINE};background:${SOFT};"></div>`;
      const qty = it.quantity && it.quantity > 1 ? ` × ${it.quantity}` : "";
      const cohort = it.cohortName ? `<div style="font-size:13px;line-height:18px;color:${MUTED};margin-top:2px;">${esc(it.cohortName)}${it.cohortDates ? ` · ${esc(it.cohortDates)}` : ""}</div>` : "";
      const was = it.listCents && it.listCents > it.totalCents ? `<div style="font-size:13px;line-height:18px;color:#8A979E;text-decoration:line-through;">${formatUSD(it.listCents)}</div>` : "";
      return `<tr>
<td width="60" valign="top" style="padding:0 16px 20px 0;">${thumb}</td>
<td valign="top" style="padding:0 0 20px;"><div style="font-size:15px;line-height:21px;font-weight:600;color:${INK};">${esc(it.title)}${qty}</div>
<div style="font-size:14px;line-height:20px;color:${MUTED};margin-top:2px;">${itemMeta(it)}</div>${cohort}</td>
<td valign="top" align="right" style="padding:0 0 20px 16px;white-space:nowrap;">${was}<div style="font-size:15px;line-height:21px;font-weight:600;color:${INK};">${formatUSD(it.totalCents)}</div></td>
</tr>`;
    })
    .join("");
  const line = (k: string, val: string, o: { strong?: boolean; big?: boolean; top?: boolean } = {}) =>
    `<tr><td style="padding:${o.top ? "14px" : "5px"} 0 5px;${o.top ? `border-top:1px solid ${LINE};` : ""}font-size:${o.big ? 16 : 15}px;line-height:22px;color:${o.strong || o.big ? INK : MUTED};font-weight:${o.strong || o.big ? 600 : 400};">${esc(k)}</td><td align="right" style="padding:${o.top ? "14px" : "5px"} 0 5px;${o.top ? `border-top:1px solid ${LINE};` : ""}font-size:${o.big ? 22 : 15}px;line-height:${o.big ? 28 : 22}px;color:${INK};font-weight:${o.big || o.strong ? 700 : 600};white-space:nowrap;">${o.big ? `<span style="font-size:13px;color:${MUTED};font-weight:400;">USD</span> ` : ""}${val}</td></tr>`;
  let totals = "";
  if (v.subtotalCents != null && v.discountCents) {
    totals += line(`Subtotal · ${v.items.length === 1 ? "1 programa" : `${v.items.length} programas`}`, formatUSD(v.subtotalCents));
    totals += line("Descuento por forma de pago", `−${formatUSD(v.discountCents)}`);
  }
  totals += line("Total del programa", formatUSD(v.totalCents), { big: true, top: !!(v.subtotalCents != null && v.discountCents) });
  if (v.dueNowCents !== v.totalCents) totals += line("Primer pago", formatUSD(v.dueNowCents));
  if (v.amountPaidCents > 0) totals += line("Pagado", formatUSD(v.amountPaidCents));
  if (v.amountPaidCents > 0 && v.balanceCents > 0) totals += line("Saldo pendiente", formatUSD(v.balanceCents), { strong: true });
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-top:1px solid ${LINE};"><tr><td style="padding-top:10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${totals}</table></td></tr></table>`;
}

function installmentsBlock(v: OrderView): string {
  if (!v.installments || v.installments.length < 2) return "";
  const STATUS: Record<string, [string, string]> = { PAID: ["Pagada", TEAL_INK], WAIVED: ["Exonerada", TEAL_INK], OVERDUE: ["Vencida", "#D72C0D"], PENDING: ["Pendiente", MUTED] };
  const rows = v.installments
    .map((i) => {
      const [label, color] = STATUS[i.status] ?? [i.status, MUTED];
      return `<tr><td style="padding:9px 0;border-bottom:1px solid ${LINE};font-size:14px;line-height:20px;color:${INK};"><strong style="font-weight:600;">Cuota ${i.sequence}</strong>${i.courseTitle ? `<span style="color:${MUTED};"> · ${esc(i.courseTitle)}</span>` : ""}</td>
<td align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid ${LINE};font-size:14px;line-height:20px;white-space:nowrap;color:${INK};font-weight:600;">${formatUSD(i.amountCents)}</td>
<td align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid ${LINE};font-size:13px;line-height:20px;white-space:nowrap;color:${color};font-weight:600;">${label}</td></tr>`;
    })
    .join("");
  return section("Tus cuotas", `<p style="margin:0 0 12px;font-size:14px;line-height:20px;color:${MUTED};">Cada cuota confirmada habilita el siguiente curso del diplomado en el aula virtual.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;">${rows}</table>`);
}

/** «Datos del médico» en dos columnas, como «Customer information» del correo de Shopify. */
function customerBlock(v: OrderView, payment?: string | null): string {
  const cells: [string, string][] = [];
  cells.push(["Contacto", [esc(v.customerFullName ?? ""), escEmail(v.customerEmail), esc(v.customerPhone ?? "")].filter(Boolean).join("<br>")]);
  const pay = payment ?? v.paymentMethodLabel;
  if (pay) cells.push(["Método de pago", esc(pay)]);
  cells.push([
    "Modalidad",
    v.items
      .map((it) => [it.modalityLabel, it.cohortName].filter(Boolean).map(esc).join(" · "))
      .join("<br>"),
  ]);
  if (v.placedAt) cells.push(["Fecha del pedido", esc(formatDate(v.placedAt))]);
  let rows = "";
  for (let i = 0; i < cells.length; i += 2) {
    const col = (c?: [string, string]) =>
      c
        ? `<td class="c-col" width="50%" valign="top" style="padding:0 16px 20px 0;"><div style="font-size:14px;line-height:20px;font-weight:600;color:${INK};margin-bottom:4px;">${esc(c[0])}</div><div style="font-size:14px;line-height:21px;color:${MUTED};word-break:break-word;">${c[1]}</div></td>`
        : `<td class="c-col" width="50%"></td>`;
    rows += `<tr>${col(cells[i])}${col(cells[i + 1])}</tr>`;
  }
  return section("Datos del médico", `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`);
}

function itemsText(v: OrderView): string {
  const lines = v.items.map((it) => `- ${it.title} (${[it.modalityLabel, it.choiceLabel, it.cohortName, it.planLabel].filter(Boolean).join(" · ")}): ${formatUSD(it.totalCents)}`);
  lines.push(`Total del programa: ${formatUSD(v.totalCents)}`);
  if (v.dueNowCents !== v.totalCents) lines.push(`Primer pago: ${formatUSD(v.dueNowCents)}`);
  if (v.amountPaidCents > 0) lines.push(`Pagado: ${formatUSD(v.amountPaidCents)}`);
  if (v.amountPaidCents > 0 && v.balanceCents > 0) lines.push(`Saldo pendiente: ${formatUSD(v.balanceCents)}`);
  return lines.join("\n");
}

/** Correo con corte permitido antes de «@» (evita partirlo a mitad de palabra en columnas estrechas). */
const escEmail = (e: string) => esc(e).replace("@", "<wbr>@");
const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
const storeLink = (v: OrderView) => ({ href: v.storeUrl || base() || "https://ceium.net", label: "visita la tienda" });
const orderTag = (n: number) => `Pedido #${n}`;
const hasCohort = (v: OrderView) => v.items.some((i) => i.cohortName);

// ───────────── Plantillas ─────────────

export function orderConfirmation(v: OrderView, opts: { paid: boolean; manual?: ManualInstructionsView }): RenderedEmail {
  const subject = opts.paid ? `Compra confirmada — Pedido #${v.number}` : `Recibimos tu pedido #${v.number}`;
  const intro = opts.paid
    ? `Hola, ${esc(v.customerFirstName)}, ¡gracias por tu compra! Recibimos tu pago y estamos activando tu acceso a la plataforma.`
    : `Hola, ${esc(v.customerFirstName)}, recibimos tu pedido. Para completar la inscripción, realiza el pago y registra tu comprobante.`;
  let body = p(intro);
  let manualText = "";
  if (opts.paid) {
    body += p(`En unos minutos te llegará otro correo con tu usuario y los datos para entrar al aula virtual${hasCohort(v) ? ", y uno más con la dirección y las fechas de tu cohorte" : ""}.`);
    body += progress([
      { label: "Pago confirmado", state: "done" },
      { label: "Acceso al aula virtual", state: "active" },
      { label: "Clases", state: "todo" },
      { label: "Certificado", state: "todo" },
    ]);
    body += button(v.statusUrl, "Ver mi pedido", { secondary: storeLink(v) });
  } else {
    body += progress([
      { label: "Pedido recibido", state: "done" },
      { label: "Pago y comprobante", state: "active" },
      { label: "Verificación", state: "todo" },
      { label: "Acceso al aula virtual", state: "todo" },
    ]);
    if (opts.manual) {
      const m = opts.manual;
      const rows: [string, string][] = [["Monto a pagar", m.amountLabel], ...Object.entries(m.details).map(([k, val]) => [DETAIL_LABELS[k] ?? k, val] as [string, string])];
      const [amountMain, amountSub] = splitAmount(m.amountLabel);
      body += `<div style="height:12px;"></div>` + bigAmount(`Monto a pagar por ${m.inText ?? m.label}`, amountMain, amountSub ? esc(amountSub) : undefined);
      body += `<h2 style="margin:0 0 12px;font-size:17px;line-height:24px;font-weight:700;color:${INK};">Datos para pagar por ${esc(m.inText ?? m.label)}</h2>`;
      body += kv(rows.slice(1), { boxed: true, mono: ["Cuenta", "Teléfono", "Cédula/RIF"] });
      body += p(esc(m.instructions));
      if (v.expiresAt) body += notice(`Tu cupo queda reservado hasta el ${strong(esc(period(formatDateTime(v.expiresAt))))} Si no registramos tu pago antes, se liberará para otro médico.`);
      manualText = `\n\nDatos para pagar por ${m.inText ?? m.label}:\n${rows.map(([k, val]) => `${k}: ${val}`).join("\n")}\n${m.instructions}` + (v.expiresAt ? `\nTu cupo queda reservado hasta el ${period(formatDateTime(v.expiresAt))} Si no registramos tu pago antes, se liberará para otro médico.` : "");
    } else if (v.expiresAt) {
      body += notice(`Tu cupo queda reservado hasta el ${strong(esc(period(formatDateTime(v.expiresAt))))}`);
    }
    body += button(v.statusUrl, "Registrar mi pago", { secondary: storeLink(v) });
  }
  body += section("Resumen del pedido", itemsBlock(v)) + installmentsBlock(v) + customerBlock(v, opts.paid ? (v.paymentMethodLabel ? `${v.paymentMethodLabel} · ${formatUSD(v.amountPaidCents)}` : null) : opts.manual ? `${opts.manual.label} · pendiente` : null);
  const html = layout({ title: opts.paid ? "¡Gracias por tu compra!" : "Recibimos tu pedido", preheader: stripTags(intro), tag: orderTag(v.number), body });
  const text = `${stripTags(intro)}\n\nPedido #${v.number}\n${itemsText(v)}${manualText}\n\nVer pedido: ${v.statusUrl}`;
  return { subject, html, text };
}

/** "Bs. 67.450,00 ($674.50 a Bs. 100 por USD)" → ["Bs. 67.450,00", "$674.50 a Bs. 100 por USD"]. */
function splitAmount(label: string): [string, string | null] {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(label);
  return m ? [m[1], m[2]] : [label, null];
}

export function paymentUnderVerification(v: OrderView, pay: PaymentView): RenderedEmail {
  const subject = `Estamos verificando tu pago — Pedido #${v.number}`;
  const intro = `Hola, ${esc(v.customerFirstName)}, recibimos el comprobante de tu pago. Nuestro equipo lo verificará y te avisaremos por este medio (normalmente en menos de 24 horas hábiles).`;
  const rows: [string, string][] = [["Método", pay.methodLabel], ["Monto", pay.amountLabel]];
  if (pay.reference) rows.push(["Referencia", pay.reference]);
  if (pay.date) rows.push(["Fecha del pago", formatDate(pay.date)]);
  const body =
    p(intro) +
    progress([
      { label: "Pedido recibido", state: "done" },
      { label: "Comprobante", state: "done" },
      { label: "Verificación", state: "active" },
      { label: "Acceso al aula virtual", state: "todo" },
    ]) +
    `<div style="height:16px;"></div>` +
    kv(rows, { boxed: true, mono: ["Referencia"] }) +
    (hasCohort(v) ? notice("Tu cupo sigue apartado mientras verificamos el pago. No hace falta que pagues de nuevo.") : notice("No hace falta que pagues de nuevo.")) +
    button(v.statusUrl, "Ver estado del pedido", { secondary: storeLink(v) }) +
    section("Resumen del pedido", itemsBlock(v)) +
    customerBlock(v, `${pay.methodLabel} · en verificación`);
  const html = layout({ title: "Estamos verificando tu pago", preheader: "Recibimos tu comprobante", tag: orderTag(v.number), body });
  const text = `${stripTags(intro)}\n\n${hasCohort(v) ? "Tu cupo sigue apartado mientras verificamos el pago. " : ""}No hace falta que pagues de nuevo.\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${itemsText(v)}\n\nEstado: ${v.statusUrl}`;
  return { subject, html, text };
}

export function paymentApproved(v: OrderView, pay: PaymentView): RenderedEmail {
  const subject = `Pago aprobado — Pedido #${v.number}`;
  const intro = `Hola, ${esc(v.customerFirstName)}, verificamos y aprobamos tu pago de ${esc(pay.amountLabel)}.`;
  const rows: [string, string][] = [["Método", pay.methodLabel], ["Monto", pay.amountLabel]];
  if (pay.reference) rows.push(["Referencia", pay.reference]);
  const fully = v.balanceCents <= 0;
  // Pago aprobado que NO completa el primer pago (p. ej. un pago móvil corto): no hay acceso todavía. Decirle
  // «en unos minutos recibirás tu acceso» era falso; se le dice cuánto falta y dónde pagarlo.
  const missing = v.dueNowCents - v.amountPaidCents;
  const next =
    missing > 0
      ? notice(`Aún faltan ${strong(formatUSD(missing))} para completar el primer pago de tu pedido. Tu cupo sigue reservado; paga la diferencia desde la página de tu pedido y te enviaremos el acceso al aula virtual en cuanto se confirme.`, "warn")
      : p(`Si es tu primer pago de este pedido, en unos minutos recibirás tu acceso al aula virtual.${fully ? "" : ` Saldo pendiente: ${strong(formatUSD(v.balanceCents))}.`}`);
  const body =
    p(intro) +
    next +
    progress([
      { label: "Pedido recibido", state: "done" },
      { label: "Pago aprobado", state: missing > 0 ? "active" : "done" },
      { label: "Acceso al aula virtual", state: missing > 0 ? "todo" : "active" },
      { label: "Certificado", state: "todo" },
    ]) +
    `<div style="height:16px;"></div>` +
    kv(rows, { boxed: true, mono: ["Referencia"] }) +
    button(v.statusUrl, "Ver mi pedido", { secondary: storeLink(v) }) +
    section("Resumen del pedido", itemsBlock(v)) +
    installmentsBlock(v) +
    customerBlock(v, pay.methodLabel);
  const html = layout({ title: "Tu pago fue aprobado", preheader: "Tu pago fue aprobado", tag: orderTag(v.number), body });
  const text = `${stripTags(intro)}${missing > 0 ? `\n\nAún faltan ${formatUSD(missing)} para completar el primer pago de tu pedido. Tu cupo sigue reservado; paga la diferencia desde la página de tu pedido y te enviaremos el acceso al aula virtual en cuanto se confirme.` : `\n\nSi es tu primer pago de este pedido, en unos minutos recibirás tu acceso al aula virtual.${fully ? "" : ` Saldo pendiente: ${formatUSD(v.balanceCents)}.`}`}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${itemsText(v)}\n\nPedido: ${v.statusUrl}`;
  return { subject, html, text };
}

/**
 * Qué puede hacer el médico tras el rechazo, según cómo quedó el pedido:
 *  - retry: el pedido admite otro pago (sigue pendiente o con saldo) → «registra el pago de nuevo»;
 *  - released: este rechazo cerró el pedido y liberó el cupo;
 *  - closed: el pedido ya estaba cerrado (reembolsado o cancelado) y no admite pagos;
 *  - paid: el pedido ya está pagado por completo con otro pago (p.ej. comprobante duplicado);
 *  - other_pending: hay otro pago del mismo pedido aún en verificación (la página no pide otro pago).
 * `true`/`false` = released/retry (compatibilidad).
 */
export type RejectedNextStep = "retry" | "released" | "closed" | "paid" | "other_pending";

export function paymentRejected(v: OrderView, pay: PaymentView, reason: string | null | undefined, outcome: boolean | RejectedNextStep): RenderedEmail {
  const next: RejectedNextStep = outcome === true ? "released" : outcome === false ? "retry" : outcome;
  const subject = `No pudimos verificar tu pago — Pedido #${v.number}`;
  const intro = `Hola, ${esc(v.customerFirstName)}, revisamos el pago que registraste y no pudimos confirmarlo.`;
  const why = reason ? notice(`<strong style="font-weight:700;">Motivo:</strong> ${esc(reason)}`, "warn") : "";
  const debited = "Si este monto también se debitó de tu cuenta, responde a este correo con tu comprobante y te lo devolvemos.";
  const nextText = {
    retry: "Puedes registrar nuevamente el pago desde la página de tu pedido.",
    released: "El cupo reservado fue liberado. Si crees que se trata de un error, responde a este correo con tu comprobante y te ayudaremos.",
    closed: `Este pedido ya está cerrado, así que no tienes que registrar ningún pago. ${debited}`,
    paid: `Tu pedido ya está pagado con otro pago, así que no tienes que pagar ni registrar nada más. ${debited}`,
    other_pending: "Seguimos verificando el otro pago que registraste para este pedido: no hace falta que pagues de nuevo. Te avisaremos por correo.",
  }[next];
  const canRetry = next === "retry";
  const rows: [string, string][] = [["Método", pay.methodLabel], ["Monto declarado", pay.amountLabel]];
  if (pay.reference) rows.push(["Referencia", pay.reference]);
  const body =
    p(intro) +
    why +
    kv(rows, { boxed: true, mono: ["Referencia"] }) +
    p(nextText) +
    button(v.statusUrl, canRetry ? "Registrar el pago de nuevo" : "Ver mi pedido", { secondary: next === "released" ? storeLink(v) : { href: `mailto:${CONTACT_EMAIL}`, label: "escríbenos" } }) +
    section("Resumen del pedido", itemsBlock(v));
  const html = layout({ title: "No pudimos verificar tu pago", preheader: "Tu pago no pudo ser verificado", tag: orderTag(v.number), body });
  const text = `${stripTags(intro)}\n${reason ? `Motivo: ${reason}\n` : ""}\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${nextText}\n\nPedido: ${v.statusUrl}`;
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
    ? `Hola, ${esc(a.firstName)}, creamos tu cuenta en la plataforma de CEIUM. Tus cursos se activarán en breve.`
    : `Hola, ${esc(a.firstName)}, ya estás inscrito. Ingresa a la plataforma para comenzar.`;
  const pwNote = a.tempPassword
    ? "Por seguridad, la plataforma te pedirá cambiar la contraseña temporal en tu primer ingreso."
    : "Usa la contraseña que ya tienes en la plataforma. Si no la recuerdas, usa la opción «¿Olvidó su nombre de usuario o contraseña?».";
  const cred = (label: string, value: string) =>
    `<tr><td style="padding:12px 20px;border-bottom:1px solid ${LINE};"><div style="font-size:12px;line-height:16px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;font-weight:600;">${esc(label)}</div><div style="font-size:17px;line-height:24px;color:${INK};font-weight:600;font-family:'SFMono-Regular',Menlo,Consolas,monospace;word-break:break-all;margin-top:2px;">${esc(value)}</div></td></tr>`;
  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;border:1px solid ${LINE};border-radius:8px;border-collapse:separate;overflow:hidden;">
<tr><td style="padding:12px 20px;background:${SOFT};border-bottom:1px solid ${LINE};font-size:14px;line-height:20px;color:${INK};font-weight:600;">Aula virtual CEIUM · <a href="${esc(a.loginUrl)}" style="color:${TEAL_INK};text-decoration:none;word-break:break-all;">${esc(a.loginUrl.replace(/^https?:\/\//, ""))}</a></td></tr>
${cred("Usuario", a.username)}${a.tempPassword ? cred("Contraseña temporal", a.tempPassword) : ""}
</table>`;
  const courses = a.courses.length
    ? section(
        a.courses.length === 1 ? "Tu curso" : "Tus cursos",
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">${a.courses
          .map(
            (c) =>
              `<tr><td width="30" valign="top" style="padding:8px 0;"><span style="display:inline-block;width:20px;height:20px;line-height:20px;border-radius:10px;background:${a.activationPending ? "#C9D2D6" : TEAL};color:#ffffff;font-size:12px;font-weight:700;text-align:center;">&#10003;</span></td><td style="padding:8px 0;font-size:15px;line-height:22px;color:${INK};font-weight:600;border-bottom:1px solid ${LINE};">${esc(c)}</td></tr>`,
          )
          .join("")}</table>`,
      )
    : "";
  const body =
    p(intro) +
    card +
    p(esc(pwNote)) +
    button(a.loginUrl, "Ingresar a la plataforma") +
    courses;
  const html = layout({ title: a.activationPending ? "Tu cuenta en el aula virtual" : "Tu acceso al aula virtual", preheader: "Acceso a la plataforma", tag: "Aula virtual", body });
  const text = `${stripTags(intro)}\n\nPlataforma: ${a.loginUrl}\nUsuario: ${a.username}${a.tempPassword ? `\nContraseña temporal: ${a.tempPassword}` : ""}\n\n${pwNote}${a.courses.length ? `\n\nCursos:\n${a.courses.map((c) => `- ${c}`).join("\n")}` : ""}`;
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
  const intro = `Hola, ${esc(c.firstName)}, estos son los datos de tu cohorte semipresencial.`;
  const rows: [string, string][] = [
    ["Programa", c.productTitle],
    ["Cohorte", c.cohortName],
    ["Sede", c.sedeName],
    ["Inicio", formatDate(c.startDate)],
    ["Fin", formatDate(c.endDate)],
  ];
  if (c.sedeAddress) rows.push(["Dirección", c.sedeAddress]);
  const maps = c.sedeAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`CEIUM ${c.sedeAddress}`)}` : null;
  const dateCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;border:1px solid ${LINE};border-radius:8px;border-collapse:separate;">
<tr><td class="c-col" width="50%" valign="top" style="padding:18px 20px;"><div style="font-size:12px;line-height:16px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Inicio</div><div style="font-size:18px;line-height:26px;color:${INK};font-weight:700;margin-top:2px;">${esc(weekdayDate(c.startDate))}</div><div style="font-size:14px;line-height:20px;color:${MUTED};">${esc(formatDate(c.startDate))}</div></td>
<td class="c-col" width="50%" valign="top" style="padding:18px 20px;"><div style="font-size:12px;line-height:16px;color:${MUTED};text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Fin</div><div style="font-size:18px;line-height:26px;color:${INK};font-weight:700;margin-top:2px;">${esc(weekdayDate(c.endDate))}</div><div style="font-size:14px;line-height:20px;color:${MUTED};">${esc(formatDate(c.endDate))}</div></td></tr>
<tr><td colspan="2" style="padding:16px 20px;border-top:1px solid ${LINE};background:${SOFT};border-radius:0 0 8px 8px;">
<div style="font-size:15px;line-height:22px;color:${INK};font-weight:700;">Sede ${esc(c.sedeName)} · ${esc(c.cohortName)}</div>
${c.sedeAddress ? `<div style="font-size:14px;line-height:21px;color:${MUTED};margin-top:2px;">${esc(c.sedeAddress)}</div>` : ""}
${maps ? `<div style="margin-top:8px;"><a href="${esc(maps)}" style="font-size:14px;line-height:20px;color:${TEAL_INK};font-weight:600;text-decoration:none;">Cómo llegar &rarr;</a></div>` : ""}
</td></tr></table>`;
  const sess = c.sessions.length
    ? section(
        "Sesiones presenciales",
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 16px;">${c.sessions
          .map((s) => {
            const d = new Date(s.date + "T12:00:00-04:00");
            const day = d.toLocaleDateString("es-VE", { day: "numeric", timeZone: TZ });
            const mon = d.toLocaleDateString("es-VE", { month: "short", timeZone: TZ }).replace(".", "").toUpperCase();
            return `<tr><td width="52" valign="top" style="padding:10px 14px 10px 0;border-bottom:1px solid ${LINE};"><div style="width:48px;border:1px solid ${LINE};border-radius:6px;text-align:center;overflow:hidden;"><div style="background:${TEAL};color:#ffffff;font-size:10px;line-height:16px;font-weight:700;letter-spacing:.06em;">${esc(mon)}</div><div style="font-size:18px;line-height:26px;font-weight:700;color:${INK};">${esc(day)}</div></div></td>
<td valign="middle" style="padding:10px 0;border-bottom:1px solid ${LINE};"><div style="font-size:15px;line-height:21px;color:${INK};font-weight:600;">${esc(s.title || "Sesión presencial")}</div><div style="font-size:14px;line-height:20px;color:${MUTED};">${esc(formatDate(s.date + "T12:00:00-04:00"))}${s.startTime ? ` · ${esc(s.startTime)}${s.endTime ? `–${esc(s.endTime)}` : ""}` : ""}</div></td></tr>`;
          })
          .join("")}</table>`,
      )
    : "";
  const notes = c.notes ? notice(esc(c.notes)) : "";
  const body = p(intro) + `<div style="font-size:17px;line-height:24px;font-weight:700;color:${INK};margin:0 0 4px;">${esc(c.productTitle)}</div>` + dateCard + notes + sess;
  const html = layout({ title: `Tu cohorte en ${c.sedeName}`, preheader: `Cohorte ${c.cohortName} — ${c.sedeName}`, tag: orderTag(c.orderNumber), body });
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}${c.sessions.length ? `\n\nSesiones:\n${c.sessions.map((s) => `- ${formatDate(s.date + "T12:00:00-04:00")}${s.startTime ? ` · ${s.startTime}${s.endTime ? `–${s.endTime}` : ""}` : ""}${s.title ? ` — ${s.title}` : ""}`).join("\n")}` : ""}${c.notes ? `\n\n${c.notes}` : ""}`;
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
  const intro = `Hola, ${esc(c.firstName)}, completaste todos los cursos del <strong>${esc(c.diplomaTitle)}</strong>. Adjuntamos tu certificado en PDF.`;
  const rows: [string, string][] = [
    ["Titular", c.fullName],
    ["Código de verificación", c.code],
    ["Fecha de emisión", formatDate(c.issuedAt)],
  ];
  const diploma = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td style="border:1px solid ${LINE};border-radius:8px;padding:6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border:2px solid ${TEAL};border-radius:4px;padding:28px 20px;">
<div style="font-size:12px;line-height:16px;color:${TEAL_INK};text-transform:uppercase;letter-spacing:.14em;font-weight:700;">Certificado</div>
<div style="font-size:14px;line-height:20px;color:${MUTED};margin-top:12px;">otorgado a</div>
<div style="font-size:24px;line-height:32px;color:${INK};font-weight:700;margin-top:2px;">${esc(c.fullName)}</div>
<div style="font-size:14px;line-height:20px;color:${MUTED};margin-top:10px;">por completar el</div>
<div style="font-size:16px;line-height:22px;color:${INK};font-weight:600;margin-top:2px;">${esc(c.diplomaTitle)}</div>
<div style="font-size:13px;line-height:18px;color:${MUTED};margin-top:16px;">${esc(formatDate(c.issuedAt))} · Código <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;color:${INK};font-weight:600;">${esc(c.code)}</span></div>
</td></tr></table></td></tr></table>`;
  const body =
    p(intro) +
    diploma +
    p("Cualquier persona puede verificar la autenticidad del certificado con el código en el siguiente enlace.") +
    button(c.verifyUrl, "Verificar certificado") +
    section("Datos del certificado", kv(rows, { mono: ["Código de verificación"] }));
  const html = layout({ title: `¡Felicitaciones, ${c.firstName}!`, preheader: "Tu certificado está listo", tag: "Certificado", body });
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\nVerificación: ${c.verifyUrl}`;
  return { subject, html, text };
}

export function refundIssued(v: OrderView, r: { amountCents: number; methodLabel: string; reason?: string | null; full: boolean }): RenderedEmail {
  const subject = `Reembolso procesado — Pedido #${v.number}`;
  const intro = `Hola, ${esc(v.customerFirstName)}, procesamos un reembolso ${r.full ? "total" : "parcial"} de <strong>${formatUSD(r.amountCents)}</strong> de tu pedido #${v.number}.`;
  const rows: [string, string][] = [["Monto", formatUSD(r.amountCents)], ["Método", r.methodLabel]];
  if (r.reason) rows.push(["Motivo", r.reason]);
  const howText = r.methodLabel === "PayPal" ? "El dinero se acreditará en tu cuenta PayPal; puede tardar algunos días hábiles en reflejarse." : "El reembolso se realizó por el mismo medio de pago o el acordado con nuestro equipo.";
  const body =
    p(intro) +
    bigAmount(r.full ? "Reembolso total" : "Reembolso parcial", `${formatUSD(r.amountCents)} USD`, `Por ${esc(r.methodLabel)}`) +
    kv(rows.slice(1), { boxed: true }) +
    p(howText) +
    button(v.statusUrl, "Ver mi pedido", { secondary: storeLink(v) }) +
    section("Resumen del pedido", itemsBlock(v));
  const html = layout({ title: "Procesamos tu reembolso", preheader: "Reembolso procesado", tag: orderTag(v.number), body });
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n${howText}\n\nPedido: ${v.statusUrl}`;
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
  const intro = `Hola, ${esc(r.firstName)}, la cuota ${r.sequence} de ${r.totalInstallments}${r.programTitle ? ` del <strong>${esc(r.programTitle)}</strong>` : ""} ${when}.`;
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
    buttons += button(r.paypalUrl, `Pagar ${formatUSD(r.amountCents)} con PayPal`, { paypal: true });
    textPay.push(`Pagar con PayPal: ${r.paypalUrl}`);
  }
  if (r.manualUrl) {
    buttons += r.paypalUrl
      ? p(`¿Prefieres pagar con ${esc(manualLabel)}? <a href="${esc(r.manualUrl)}" style="color:${TEAL_INK};font-weight:600;">Registra tu pago aquí</a> y nuestro equipo lo verificará.`)
      : button(r.manualUrl, `Pagar ${formatUSD(r.amountCents)} con ${manualLabel}`) + p("Registra tu pago y nuestro equipo lo verificará.");
    textPay.push(`Pagar con ${manualLabel}: ${r.manualUrl}`);
  }
  if (!r.paypalUrl && !r.manualUrl) {
    buttons += p(`En este momento no hay métodos de pago en línea disponibles. Responde a este correo o revisa <a href="${esc(r.statusUrl)}" style="color:${TEAL_INK};font-weight:600;">tu pedido</a> y te indicaremos cómo pagar.`);
    textPay.push(`En este momento no hay métodos de pago en línea disponibles. Responde a este correo o revisa tu pedido (${r.statusUrl}) y te indicaremos cómo pagar.`);
  }
  // Progreso del diplomado: una marca por cuota (pagadas = anteriores a esta).
  const dots = Array.from({ length: r.totalInstallments }, (_, i) => {
    const n = i + 1;
    const bg = n < r.sequence ? TEAL : n === r.sequence ? (r.overdue ? "#D72C0D" : INK) : "#DDE3E6";
    return `<td style="padding:0 2px;"><div style="height:6px;border-radius:3px;background:${bg};font-size:0;line-height:0;">&nbsp;</div></td>`;
  }).join("");
  const track = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px;table-layout:fixed;"><tr>${dots}</tr></table><p style="margin:0 0 20px;font-size:13px;line-height:18px;color:${MUTED};">${r.sequence - 1} de ${r.totalInstallments} cuotas pagadas</p>`;
  const body =
    p(intro) +
    (r.courseTitle ? p(`Al confirmarse el pago, te matricularemos en <strong style="color:${INK};">${esc(r.courseTitle)}</strong> en la plataforma y te avisaremos por correo.`) : "") +
    (r.totalInstallments > 1 ? track : "") +
    bigAmount(r.courseTitle ? `Cuota ${r.sequence} · ${r.courseTitle}` : `Cuota ${r.sequence} de ${r.totalInstallments}`, `${formatUSD(r.amountCents)} USD`, r.dueDate ? `${r.overdue ? "Venció" : "Vence"} el ${esc(formatDate(r.dueDate))}` : undefined) +
    buttons +
    section("Detalle", kv(rows));
  const html = layout({
    title: r.overdue ? "Tu cuota está vencida" : r.courseTitle ? "Paga tu próximo curso" : "Recordatorio de pago",
    preheader: stripTags(`Cuota ${r.sequence} de ${r.totalInstallments}: ${formatUSD(r.amountCents)}`),
    tag: orderTag(r.orderNumber),
    body,
  });
  const text = `${stripTags(intro)}\n\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n${r.courseTitle ? `\nAl confirmarse el pago, te matricularemos en ${r.courseTitle} en la plataforma y te avisaremos por correo.\n` : ""}\n${textPay.join("\n")}\n\nPedido: ${r.statusUrl}`;
  return { subject, html, text };
}

// ───────────── Seguridad de la cuenta del panel ─────────────

export type AdminSecurityEvent = "2fa_enabled" | "2fa_disabled" | "2fa_reset" | "recovery_used" | "recovery_regenerated" | "password_changed" | "role_changed";

export interface AdminSecurityView {
  name: string;
  event: AdminSecurityEvent;
  at: Date;
  ip?: string | null;
  device?: string | null;
  recoveryLeft?: number;
  /** Quién hizo el cambio, si fue otra persona del equipo. */
  by?: string | null;
  /** Rol nuevo (role_changed). */
  role?: string;
  accountUrl: string;
}

const SECURITY_COPY: Record<AdminSecurityEvent, { subject: string; what: string | ((v: AdminSecurityView) => string) }> = {
  "2fa_enabled": { subject: "Activaste la verificación en dos pasos", what: "se activó la verificación en dos pasos en tu cuenta del panel de CEIUM" },
  "2fa_disabled": { subject: "Se desactivó la verificación en dos pasos", what: "se desactivó la verificación en dos pasos de tu cuenta del panel de CEIUM" },
  recovery_used: { subject: "Se usó un código de recuperación", what: "se inició sesión en tu cuenta del panel de CEIUM con un código de recuperación" },
  recovery_regenerated: { subject: "Generaste nuevos códigos de recuperación", what: "se generaron nuevos códigos de recuperación para tu cuenta del panel de CEIUM (los anteriores ya no sirven)" },
  password_changed: { subject: "Cambiaste la contraseña del panel", what: "se cambió la contraseña de tu cuenta del panel de CEIUM" },
  "2fa_reset": { subject: "Se quitó la verificación en dos pasos de tu cuenta", what: "se quitó la verificación en dos pasos de tu cuenta del panel de CEIUM. La próxima vez que entres podrás configurarla de nuevo" },
  role_changed: { subject: "Cambió tu rol en el panel de CEIUM", what: (v) => `tu rol en el panel de CEIUM ahora es «${v.role ?? ""}»` },
};

/** Aviso al propio usuario del panel cuando cambia algo de la seguridad de su cuenta. */
export function adminSecurityNotice(v: AdminSecurityView): RenderedEmail {
  const c = SECURITY_COPY[v.event];
  const what = typeof c.what === "function" ? c.what(v) : c.what;
  const rows: [string, string][] = [
    ["Fecha", formatDateTime(v.at)],
    ...(v.by ? [["Hecho por", v.by] as [string, string]] : []),
    ...(v.ip ? [["Desde la IP", v.ip] as [string, string]] : []),
    ...(v.device ? [["Navegador", v.device] as [string, string]] : []),
  ];
  const left = v.event === "recovery_used" && v.recoveryLeft != null ? `Te ${v.recoveryLeft === 1 ? "queda 1 código" : `quedan ${v.recoveryLeft} códigos`} de recuperación.` : "";
  const intro = `Hola, ${esc(v.name)}, ${esc(what)}.`;
  const body =
    p(intro) +
    (left ? p(esc(left)) : "") +
    kv(rows, { boxed: true }) +
    notice(`${strong("¿No fuiste tú?")} Cambia tu contraseña de inmediato desde Mi cuenta y avisa al administrador del panel.`, "warn") +
    button(v.accountUrl, "Ir a Mi cuenta");
  const html = layout({ title: c.subject, preheader: `${c.subject}.`, tag: "Seguridad", body });
  const text = `${stripTags(intro)}\n${left ? `${left}\n` : ""}\n${rows.map(([k, x]) => `${k}: ${x}`).join("\n")}\n\n¿No fuiste tú? Cambia tu contraseña de inmediato desde Mi cuenta (${v.accountUrl}) y avisa al administrador del panel.`;
  return { subject: c.subject, html, text };
}

export interface AdminAccessView {
  name: string;
  kind: "invite" | "reset";
  /** Enlace con el token (o TEMP_PASSWORD_PLACEHOLDER en su lugar: el token no se guarda). */
  link: string;
  expiresAt: Date;
  /** Quién invita o envía el enlace. */
  by: string;
  role: string;
}

/** Invitación al panel (crear la contraseña) o enlace para restablecerla. */
export function adminAccessLink(v: AdminAccessView): RenderedEmail {
  const invite = v.kind === "invite";
  const subject = invite ? "Te invitaron al panel de CEIUM" : "Restablece tu contraseña del panel de CEIUM";
  const intro = invite
    ? `Hola, ${esc(v.name)}: ${esc(v.by)} te dio acceso al panel de CEIUM como ${strong(esc(v.role))}. Para entrar, crea tu contraseña con este enlace.`
    : `Hola, ${esc(v.name)}: ${esc(v.by)} te envió un enlace para crear una contraseña nueva para el panel de CEIUM. Tu contraseña actual sigue funcionando hasta que la cambies.`;
  const when = `El enlace vence el ${formatDateTime(v.expiresAt)} y sirve una sola vez.`;
  const body =
    p(intro) +
    button(v.link, invite ? "Crear mi contraseña" : "Crear contraseña nueva") +
    p(esc(when)) +
    notice(`${strong("¿No esperabas este correo?")} Ignóralo: sin el enlace nadie puede ${invite ? "activar la cuenta" : "cambiar tu contraseña"}. No lo reenvíes a nadie.`, "info");
  const html = layout({ title: subject, preheader: when, tag: "Panel", body });
  const text = `${stripTags(intro)}\n\n${invite ? "Crear mi contraseña" : "Crear contraseña nueva"}: ${v.link}\n\n${when}\n\n¿No esperabas este correo? Ignóralo: sin el enlace nadie puede ${invite ? "activar la cuenta" : "cambiar tu contraseña"}. No lo reenvíes a nadie.`;
  return { subject, html, text };
}
