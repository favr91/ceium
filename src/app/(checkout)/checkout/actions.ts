"use server";
// Acción del checkout: valida los datos del médico, crea el pedido (reserva el cupo de cada programa
// semipresencial) y sigue con el método elegido:
//   - PayPal → crea la orden PayPal por el primer pago y redirige a PayPal (la reserva dura el TTL de PayPal);
//   - manual (pago móvil, transferencia, Zelle, efectivo) → vuelve a /checkout, que muestra la reserva con su
//     cuenta regresiva y los datos para pagar.
// Si el médico vuelve atrás o envía dos veces con el mismo carrito, se reutiliza el pedido en curso.
import { cookies, headers } from "next/headers";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { PaymentMethod } from "@/generated/prisma/client";
import { cartCheckoutItems, resolveCart } from "@/server/cart";
import { prisma } from "@/server/db";
import { clientIp, ipKey } from "@/server/client-ip";
import { isDomainError } from "@/server/errors";
import { record, tooMany } from "@/server/rate-limit";
import { configFromEnv } from "@/server/deps";
import { services } from "@/server/services";
import { FIELD_ORDER, normalizeCedula, normalizePhone, specialtyOf, validateCheckout, type CheckoutField, type CheckoutValues } from "@/components/checkout/checkout-fields";
import { CHECKOUT_COOKIE, CHECKOUT_COOKIE_OPTIONS, cartSignature, encodePendingCookie, findPendingOrder, paymentMethods, readCheckoutCookies } from "./data";

export type PlaceOrderState = { formError?: string; fieldErrors?: Partial<Record<CheckoutField, string>>; at?: number } | null;

function values(fd: FormData): CheckoutValues {
  const out = {} as CheckoutValues;
  for (const k of FIELD_ORDER) {
    const v = fd.get(k);
    out[k] = typeof v === "string" ? v.slice(0, 200) : "";
  }
  if (!out.country) out.country = "VE";
  return out;
}

/** PayPal desde el checkout: «Cancelar y volver» regresa al checkout (pedido en curso, cupo reservado), no a /pedido. */
function checkoutPaypalUrls() {
  return { cancelUrl: `${configFromEnv().appUrl}/checkout?paypal=cancelado` };
}

const fail = (formError: string, fieldErrors?: Partial<Record<CheckoutField, string>>): PlaceOrderState => ({ formError, fieldErrors, at: Date.now() });

// Pedidos nuevos por conexión: cada uno aparta cupos, así que un script no puede acaparar las cohortes.
const ORDERS_PER_IP = 10;
const ORDERS_WINDOW_MS = 60 * 60_000;

export async function placeOrder(_prev: PlaceOrderState, fd: FormData): Promise<PlaceOrderState> {
  const v = values(fd);
  const { lines, pendingRef } = await readCheckoutCookies();
  if (!lines.length) return fail("Tu carrito está vacío. Agrega un programa para continuar.");

  const methods = await paymentMethods();
  const fieldErrors = validateCheckout(v, methods.map((m) => m.method));
  if (Object.keys(fieldErrors).length) return fail("Revisa los campos marcados.", fieldErrors);
  const method = v.method as PaymentMethod;

  const cart = await resolveCart({ db: prisma, now: () => new Date() }, lines);
  if (cart.blocked) {
    const bad = cart.lines.find((l) => l.error);
    return fail(`${bad?.title ?? "Un programa"}: ${bad?.error ?? "no se puede comprar tal como está."} Vuelve al carrito para corregirlo.`);
  }

  const s = services();
  const email = v.email.trim().toLowerCase();
  let order: { id: string; token: string };
  try {
    const existing = await findPendingOrder(lines, pendingRef);
    if (existing && existing.customer.email === email) {
      order = existing;
    } else {
      const key = ipKey("checkout", clientIp(await headers()));
      if (tooMany(key, ORDERS_PER_IP, ORDERS_WINDOW_MS)) return fail("Se crearon demasiados pedidos desde esta conexión. Espera un rato o escríbenos por WhatsApp.");
      record(key);
      order = await s.orders.createCheckout({
        customer: {
          email,
          firstName: v.firstName.trim(),
          lastName: v.lastName.trim(),
          cedula: normalizeCedula(v.cedula, v.country),
          phone: normalizePhone(v.phone),
          specialty: specialtyOf(v),
          city: v.city.trim() || null,
          country: v.country === "OTHER" ? null : v.country,
        },
        items: cartCheckoutItems(lines),
        paymentMethod: method,
        // Doble clic / reintento antes de que exista la cookie del pedido en curso: mismo pedido, un solo cupo.
        reusePendingTwin: true,
      });
    }
  } catch (e) {
    if (!isDomainError(e)) {
      console.error("[checkout]", e);
      return fail("No pudimos crear tu pedido. Intenta de nuevo en unos segundos.");
    }
    const field = typeof e.details?.field === "string" ? (e.details.field as CheckoutField) : null;
    if (field && FIELD_ORDER.includes(field)) return fail("Revisa los campos marcados.", { [field]: e.message });
    return fail(e.code === "SOLD_OUT" ? `Sin cupo. ${e.message} Vuelve al carrito para elegir otra cohorte.` : e.message);
  }

  (await cookies()).set(CHECKOUT_COOKIE, encodePendingCookie(order.token, cartSignature(lines)), CHECKOUT_COOKIE_OPTIONS);

  if (method !== "PAYPAL") redirect("/checkout?pedido=creado");

  let approveUrl: string;
  try {
    approveUrl = (await s.payments.startPaypalPayment(order.id, checkoutPaypalUrls())).approveUrl;
  } catch (e) {
    if (!isDomainError(e)) console.error("[checkout/paypal]", e);
    refresh(); // el pedido ya existe: la página muestra la reserva y deja reintentar
    return fail(isDomainError(e) ? e.message : "No pudimos conectar con PayPal. Tu cupo sigue reservado: intenta de nuevo.");
  }
  redirect(approveUrl);
}

/** Pedido en curso (reserva viva): «Pagar con PayPal». El pedido sale de la cookie, nunca del formulario. */
export async function payPendingWithPaypal(): Promise<PlaceOrderState> {
  const { lines, pendingRef } = await readCheckoutCookies();
  const order = await findPendingOrder(lines, pendingRef);
  if (!order) {
    refresh();
    return fail("Tu reserva ya no está vigente. Revisa tus datos y vuelve a confirmar el pedido.");
  }
  let approveUrl: string;
  try {
    approveUrl = (await services().payments.startPaypalPayment(order.id, checkoutPaypalUrls())).approveUrl;
  } catch (e) {
    if (!isDomainError(e)) console.error("[checkout/paypal]", e);
    return fail(isDomainError(e) ? e.message : "No pudimos conectar con PayPal. Tu cupo sigue reservado: intenta de nuevo.");
  }
  redirect(approveUrl);
}
