// Compra por HTTP a través de la tienda REAL, sin atajos: /cart/add (la misma ruta que usa la ficha) → /checkout
// (la página renderizada) → envío del formulario del checkout tal como lo hace un navegador sin JavaScript
// (formulario multipart con los campos ocultos del server action que la página misma trae: $ACTION_REF_1,
// $ACTION_1:0, $ACTION_1:1, $ACTION_KEY). Cada comprador es un APIRequestContext con sus propias cookies
// (carrito y pedido en curso), así que 40 compradores = 40 sesiones de navegador independientes.
import { expect, type APIRequestContext } from "@playwright/test";

export type CheckoutMethod = "PAYPAL" | "PAGO_MOVIL" | "TRANSFERENCIA" | "ZELLE" | "EFECTIVO";

export interface DoctorForm {
  email: string;
  firstName: string;
  lastName: string;
  cedula?: string;
  phone?: string;
  city?: string;
  specialty?: string;
  method: CheckoutMethod;
}

export type CheckoutOutcome =
  /** Pedido creado: PayPal → redirección a la aprobación de PayPal; manual → /checkout?pedido=creado. */
  | { ok: true; status: number; location: string; paypalOrderId: string | null }
  /** Rechazado: la página del checkout se vuelve a mostrar con el aviso (role="alert"). */
  | { ok: false; status: number; error: string };

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Carrito con el programa pedido, por la ruta pública de la tienda. Falla si la tienda no lo deja agregar. */
export async function addToCart(ctx: APIRequestContext, query: Record<string, string>) {
  const r = await ctx.get(`/cart/add?${new URLSearchParams(query)}`, { maxRedirects: 0 });
  expect(r.status(), "la tienda redirige al carrito").toBe(303);
  const loc = new URL(r.headers()["location"], "http://x");
  return { location: loc.pathname + loc.search, error: loc.searchParams.get("error") };
}

/** Campos ocultos del server action del formulario del checkout, leídos de la página renderizada. */
export async function checkoutFormFields(ctx: APIRequestContext): Promise<Record<string, string>> {
  const r = await ctx.get("/checkout");
  expect(r.status()).toBe(200);
  const html = await r.text();
  const start = html.indexOf('class="co-form"');
  expect(start, "la página del checkout trae el formulario").toBeGreaterThan(0);
  const form = html.slice(html.lastIndexOf("<form", start), html.indexOf("</form>", start));
  const fields: Record<string, string> = {};
  for (const m of form.matchAll(/<input type="hidden" name="(\$ACTION[^"]*)"(?: value="([^"]*)")?\/?>/g)) fields[decode(m[1])] = decode(m[2] ?? "");
  expect(Object.keys(fields), "campos del server action").toEqual(expect.arrayContaining(["$ACTION_REF_1", "$ACTION_1:0", "$ACTION_KEY"]));
  return fields;
}

/** Envía el formulario del checkout (como un navegador sin JS) y clasifica la respuesta. */
export async function submitCheckout(ctx: APIRequestContext, fields: Record<string, string>, doc: DoctorForm): Promise<CheckoutOutcome> {
  const r = await ctx.post("/checkout", {
    maxRedirects: 0,
    timeout: 120_000,
    multipart: {
      ...fields,
      email: doc.email,
      phone: doc.phone ?? "0414-1234567",
      country: "VE",
      firstName: doc.firstName,
      lastName: doc.lastName,
      cedula: doc.cedula ?? "V-14567890",
      city: doc.city ?? "Barquisimeto",
      specialty: doc.specialty ?? "Medicina general",
      specialtyOther: "",
      method: doc.method,
    },
  });
  const status = r.status();
  if (status >= 300 && status < 400) {
    const location = r.headers()["location"] ?? "";
    const paypalOrderId = /\/checkoutnow\?/.test(location) ? new URL(location).searchParams.get("token") : null;
    return { ok: true, status, location, paypalOrderId };
  }
  const html = await r.text();
  const alert = html.match(/<div class="co-banner" role="alert"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/);
  return { ok: false, status, error: alert ? decode(alert[1].replace(/<!-- -->/g, "")) : `(sin aviso; HTTP ${status})` };
}
