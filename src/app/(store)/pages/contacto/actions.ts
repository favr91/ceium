"use server";
// Formulario de /pages/contacto: valida en el servidor y envía el mensaje al buzón de CEIUM (correos de la
// Setting `store.contact`) por la bandeja de correo (EmailOutbox + transporte configurado). Como el formulario
// de Shopify, pide nombre, correo y mensaje (apellido opcional). Protecciones: campo trampa para bots,
// deduplicación del mismo mensaje y límite de envíos por IP.
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { contactInbox } from "@/components/store/pages/pages-data";
import { esc } from "@/server/email/templates";
import { services } from "@/server/services";
import { clientIp } from "@/server/client-ip";
import { hit } from "@/server/rate-limit";

export type ContactFormState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; fields?: Partial<Record<"nombre" | "apellido" | "email" | "mensaje", string>>; values?: Record<string, string> };

const schema = z.object({
  nombre: z.string().trim().min(1, "Ingresa tu nombre.").max(120, "El nombre es demasiado largo."),
  apellido: z.string().trim().max(120, "El apellido es demasiado largo."),
  email: z.string().trim().min(1, "Ingresa tu correo electrónico.").max(200).email("Ingresa un correo electrónico válido."),
  mensaje: z.string().trim().min(1, "Escribe tu mensaje.").max(5000, "El mensaje no puede superar los 5000 caracteres."),
});

const WINDOW_MS = 10 * 60 * 1000;
/** Por remitente (IP + correo) y, más holgado, por IP (varias personas pueden compartir la IP de una clínica). */
const MAX_PER_SENDER = 5;
const MAX_PER_IP = 30;
// Límite en memoria compartido (limpia claves viejas; ver server/rate-limit.ts).
const throttled = (key: string | null, max: number, now: number) => !hit(key ? `contact:${key}` : null, max, WINDOW_MS, now).ok;

export async function sendContactMessage(_prev: ContactFormState, formData: FormData): Promise<ContactFormState> {
  const raw = {
    nombre: String(formData.get("nombre") ?? ""),
    apellido: String(formData.get("apellido") ?? ""),
    email: String(formData.get("email") ?? ""),
    mensaje: String(formData.get("mensaje") ?? ""),
  };
  const ok: ContactFormState = { status: "ok", message: String(formData.get("success") ?? "") || "¡Gracias por escribirnos! Te responderemos lo antes posible." };

  // Campo trampa (invisible para personas): si viene lleno, se responde como si todo saliera bien.
  if (String(formData.get("website") ?? "").trim()) return ok;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Partial<Record<keyof typeof raw, string>> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path[0] as keyof typeof raw;
      fields[k] ??= issue.message;
    }
    return { status: "error", message: "Revisa los campos marcados.", fields, values: raw };
  }
  const data = parsed.data;

  const h = await headers();
  // La IP que agrega nuestro proxy (el primer valor de X-Forwarded-For lo escribe el cliente y se puede inventar).
  const ip = clientIp(h);
  const now = Date.now();
  // Sin IP conocida (sin proxy) cuenta solo por remitente: no se mezcla a todos los visitantes en un mismo límite.
  if (throttled(ip ? `ip:${ip}` : null, MAX_PER_IP, now) || throttled(`from:${ip ?? "?"}:${data.email.toLowerCase()}`, MAX_PER_SENDER, now)) {
    return { status: "error", message: "Enviaste varios mensajes seguidos. Espera unos minutos e inténtalo de nuevo.", values: raw };
  }

  const inbox = await contactInbox();
  if (!inbox.length) {
    return { status: "error", message: "No pudimos enviar tu mensaje en este momento. Escríbenos por WhatsApp o a nuestros teléfonos.", values: raw };
  }

  const fullName = [data.nombre, data.apellido].filter(Boolean).join(" ");
  const subject = `Nuevo mensaje de contacto de ${fullName}`;
  const text = `Nuevo mensaje desde el formulario de contacto de la tienda.\n\nNombre: ${data.nombre}\nApellido: ${data.apellido || "—"}\nCorreo electrónico: ${data.email}\n\nMensaje:\n${data.mensaje}\n`;
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#667880;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;color:#001e2b">${v}</td></tr>`;
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f1f1f1;font-family:Inter,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f1f1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #eeeeee;border-radius:20px;padding:32px">
<tr><td style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#09b0b0;padding-bottom:8px">Formulario de contacto</td></tr>
<tr><td style="font-size:24px;line-height:30px;font-weight:700;color:#001e2b;padding-bottom:20px">${esc(subject)}</td></tr>
<tr><td><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:15px;line-height:21px">
${row("Nombre", esc(data.nombre))}${row("Apellido", esc(data.apellido || "—"))}${row("Correo electrónico", `<a href="mailto:${esc(data.email)}" style="color:#09b0b0">${esc(data.email)}</a>`)}
</table></td></tr>
<tr><td style="padding-top:20px;font-size:15px;line-height:21px;color:#001e2b;white-space:pre-wrap">${esc(data.mensaje)}</td></tr>
<tr><td style="padding-top:24px"><a href="mailto:${esc(data.email)}?subject=${encodeURIComponent("Re: tu mensaje a CEIUM")}" style="display:inline-block;background:#09b0b0;color:#ffffff;text-decoration:none;font-weight:500;font-size:14px;padding:14px 22px;border-radius:100px">Responder a ${esc(data.nombre)}</a></td></tr>
</table></td></tr></table></body></html>`;

  const dedupeKey = `contact:${createHash("sha256").update(`${data.email.toLowerCase()}\n${data.mensaje}`).digest("hex").slice(0, 40)}`;
  try {
    await services().email.sendEmail({
      template: "contact_message",
      to: inbox.join(", "),
      rendered: { subject, html, text },
      dedupeKey,
      actor: { type: "CUSTOMER" },
    });
  } catch (e) {
    console.error("[contacto] no se pudo registrar el mensaje", e);
    return { status: "error", message: "No pudimos enviar tu mensaje en este momento. Inténtalo de nuevo en unos minutos.", values: raw };
  }
  // Un fallo del transporte deja el correo en la bandeja como FAILED y el job lo reintenta: para el médico,
  // el mensaje quedó recibido.
  return ok;
}
