// Campos del checkout que se validan igual en el navegador (mensajes en línea al enviar) y en el servidor
// (server action). Sin dependencias de servidor: lo importan el formulario (cliente) y la acción.

export type CheckoutField = "email" | "phone" | "country" | "firstName" | "lastName" | "cedula" | "city" | "specialty" | "specialtyOther" | "method";

export type CheckoutValues = Record<CheckoutField, string>;

/** Especialidades para el certificado y las estadísticas del panel. «Otra» abre un campo libre. */
export const SPECIALTIES = [
  "Medicina general",
  "Medicina familiar",
  "Medicina interna",
  "Ginecología y obstetricia",
  "Medicina materno-fetal",
  "Radiología e imágenes",
  "Pediatría",
  "Cardiología",
  "Cirugía general",
  "Emergenciología",
  "Medicina crítica",
  "Gastroenterología",
  "Urología",
  "Traumatología",
  "Médico residente de postgrado",
] as const;
export const OTHER_SPECIALTY = "Otra";

export const COUNTRIES: readonly { code: string; name: string }[] = [
  { code: "VE", name: "Venezuela" },
  { code: "CO", name: "Colombia" },
  { code: "EC", name: "Ecuador" },
  { code: "PE", name: "Perú" },
  { code: "CL", name: "Chile" },
  { code: "AR", name: "Argentina" },
  { code: "MX", name: "México" },
  { code: "PA", name: "Panamá" },
  { code: "DO", name: "República Dominicana" },
  { code: "ES", name: "España" },
  { code: "US", name: "Estados Unidos" },
  { code: "OTHER", name: "Otro país" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** «v12.345.678», «V-12345678», «12345678» → «V-12345678». Fuera de Venezuela: el documento tal cual. */
export function normalizeCedula(raw: string, country: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[\s.]/g, "");
  const ve = /^([VEJPG])?-?(\d{5,9})$/.exec(s);
  if (ve) return `${ve[1] ?? "V"}-${ve[2]}`;
  if (country !== "VE" && /^[A-Z0-9-]{5,20}$/.test(s)) return s;
  return null;
}

/** «04141234567» → «0414-1234567»; «+58 414 1234567» → «+58 414-1234567»; otros: dígitos con + opcional. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (/^0\d{10}$/.test(digits)) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  if (/^58\d{10}$/.test(digits)) return `+58 ${digits.slice(2, 5)}-${digits.slice(5)}`;
  if (digits.length >= 8 && digits.length <= 15) return (trimmed.startsWith("+") ? "+" : "") + digits;
  return null;
}

export function specialtyOf(v: Pick<CheckoutValues, "specialty" | "specialtyOther">): string {
  return v.specialty === OTHER_SPECIALTY ? v.specialtyOther.trim() : v.specialty.trim();
}

/** Errores por campo (mismos textos en cliente y servidor). `methods` = métodos ofrecidos ahora. */
export function validateCheckout(v: CheckoutValues, methods: readonly string[]): Partial<Record<CheckoutField, string>> {
  const e: Partial<Record<CheckoutField, string>> = {};
  if (!v.email.trim()) e.email = "Ingresa tu correo electrónico.";
  else if (!EMAIL_RE.test(v.email.trim())) e.email = "Ingresa un correo electrónico válido, p. ej. nombre@correo.com.";
  if (!v.phone.trim()) e.phone = "Ingresa tu teléfono.";
  else if (!normalizePhone(v.phone)) e.phone = "Ingresa un teléfono válido, p. ej. 0414-1234567.";
  if (!COUNTRIES.some((c) => c.code === v.country)) e.country = "Selecciona tu país.";
  if (!v.firstName.trim()) e.firstName = "Ingresa tu nombre.";
  else if (v.firstName.trim().length > 60) e.firstName = "El nombre es demasiado largo.";
  if (!v.lastName.trim()) e.lastName = "Ingresa tus apellidos.";
  else if (v.lastName.trim().length > 60) e.lastName = "Los apellidos son demasiado largos.";
  if (!v.cedula.trim()) e.cedula = "Ingresa tu cédula de identidad.";
  else if (!normalizeCedula(v.cedula, v.country)) e.cedula = v.country === "VE" ? "Ingresa una cédula válida, p. ej. V-12345678." : "Ingresa un documento de identidad válido.";
  if (v.city.trim().length > 80) e.city = "La ciudad es demasiado larga.";
  if (!v.specialty.trim()) e.specialty = "Selecciona tu especialidad.";
  else if (v.specialty === OTHER_SPECIALTY && !v.specialtyOther.trim()) e.specialtyOther = "Escribe tu especialidad.";
  else if (specialtyOf(v).length > 80) e.specialtyOther = "La especialidad es demasiado larga.";
  if (!methods.includes(v.method)) e.method = "Selecciona un método de pago.";
  return e;
}

export const FIELD_ORDER: readonly CheckoutField[] = ["email", "phone", "country", "firstName", "lastName", "cedula", "city", "specialty", "specialtyOther", "method"];
