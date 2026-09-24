// Campos del registro de un pago manual (pago móvil, transferencia, Zelle) en el checkout: referencia, banco de
// origen, monto, fecha y comprobante. Se validan igual en el navegador (mensajes en línea) y en el servidor
// (/api/checkout/comprobante). Sin dependencias de servidor.

export type ManualField = "reference" | "bank" | "amount" | "paidAt" | "proof";
export type ManualValues = Record<Exclude<ManualField, "proof">, string>;
export type ManualErrors = Partial<Record<ManualField, string>>;

export const MANUAL_FIELD_ORDER: readonly ManualField[] = ["reference", "bank", "amount", "paidAt", "proof"];

/** Bancos venezolanos (código SUDEBAN) para «Banco de origen» de pagos en bolívares. */
export const VE_BANKS: readonly string[] = [
  "Banco de Venezuela (0102)",
  "Banesco (0134)",
  "Mercantil (0105)",
  "BBVA Provincial (0108)",
  "Banco Nacional de Crédito, BNC (0191)",
  "Bancamiga (0172)",
  "Banco del Tesoro (0163)",
  "Bancaribe (0114)",
  "Banco Exterior (0115)",
  "Banplus (0174)",
  "Banco Plaza (0138)",
  "BFC Banco Fondo Común (0151)",
  "Venezolano de Crédito (0104)",
  "Banco Activo (0171)",
  "Banco Caroní (0128)",
  "Sofitasa (0137)",
  "100% Banco (0156)",
  "Banco Agrícola de Venezuela (0166)",
  "Bancrecer (0168)",
  "R4 Banco Microfinanciero (0169)",
  "Banco Digital de los Trabajadores (0175)",
  "Banfanb (0177)",
  "Del Sur (0157)",
];

// Sin HEIC/HEIF a propósito: Chrome y Firefox no pueden mostrarlo en el panel y el servidor no puede convertirlo.
// Al no listarlo, Safari de iOS convierte la foto a JPEG antes de enviarla.
export const PROOF_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf";
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;
const PROOF_EXT = /\.(jpe?g|png|webp|pdf)$/i;
export const PROOF_TYPE_ERROR = "El comprobante debe ser una imagen (JPG, PNG o WEBP) o un PDF.";
export const PROOF_HEIC_ERROR = "Las fotos HEIC del iPhone no se pueden revisar: envía una captura de pantalla (JPG o PNG) o un PDF.";

/** Fecha de hoy en Venezuela («2026-09-23»). */
export function todayCaracas(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** «33.564,60», «33564,60», «33564.60», «33.564» → céntimos (NaN si no es un número). */
export function parseAmountCents(raw: string): number {
  let s = raw.trim().replace(/[^\d.,]/g, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Monto para escribir/pegar en la app del banco: «33564,60» (sin separador de miles). */
export function plainAmount(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** Monto con formato venezolano: «33.564,60». */
export function formatAmount(cents: number): string {
  return (cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function normalizeReference(raw: string): string {
  return raw.replace(/[\s.]/g, "").toUpperCase();
}

export interface ProofInfo {
  name: string;
  size: number;
}

export function proofError(file: ProofInfo | null): string | undefined {
  if (!file || file.size === 0) return "Adjunta el comprobante del pago (captura o PDF).";
  if (/\.hei[cf]$/i.test(file.name)) return PROOF_HEIC_ERROR;
  if (!PROOF_EXT.test(file.name)) return PROOF_TYPE_ERROR;
  if (file.size > PROOF_MAX_BYTES) return "El comprobante no puede superar 10 MB.";
  return undefined;
}

/**
 * Errores por campo. `currency` = moneda del método (VES exige el banco de origen). `today` = fecha de hoy en
 * Venezuela (el pago no puede ser de una fecha futura ni de hace más de 60 días).
 */
export function validateManualPayment(v: ManualValues, file: ProofInfo | null, currency: "USD" | "VES", today: string): ManualErrors {
  const e: ManualErrors = {};
  const ref = normalizeReference(v.reference);
  if (!ref) e.reference = currency === "USD" ? "Ingresa el número de confirmación del pago." : "Ingresa el número de referencia del pago.";
  else if (!/^[A-Z0-9-]{4,30}$/.test(ref)) e.reference = "La referencia debe tener entre 4 y 30 dígitos o letras.";
  if (currency === "VES" && !v.bank.trim()) e.bank = "Selecciona el banco desde el que pagaste.";
  else if (v.bank.trim().length > 80) e.bank = "El nombre del banco es demasiado largo.";
  const cents = parseAmountCents(v.amount);
  if (!v.amount.trim()) e.amount = "Ingresa el monto que pagaste.";
  else if (!Number.isFinite(cents) || cents <= 0) e.amount = "Ingresa un monto válido, p. ej. 33.564,60.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.paidAt) || Number.isNaN(Date.parse(`${v.paidAt}T12:00:00Z`))) e.paidAt = "Ingresa la fecha del pago.";
  else if (v.paidAt > today) e.paidAt = "La fecha del pago no puede ser posterior a hoy.";
  else if (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${v.paidAt}T12:00:00Z`) > 60 * 86_400_000) e.paidAt = "La fecha es de hace más de 60 días. Revísala o escríbenos.";
  const pe = proofError(file);
  if (pe) e.proof = pe;
  return e;
}
