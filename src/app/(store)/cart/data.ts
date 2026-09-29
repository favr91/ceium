// Lectura del carrito desde la cookie (Server Components, server actions y route handlers).
// El header de la tienda puede usar `getCartCount()` para la burbuja del ícono del carrito.
import { cookies } from "next/headers";
import { prisma } from "@/server/db";
import { CART_COOKIE, CART_COOKIE_OPTIONS, dropMissingProducts, parseCartCookie, resolveCart, serializeCart, type CartLine, type ResolvedCart } from "@/server/cart";

/** Líneas del carrito cuyo programa sigue existiendo (ver dropMissingProducts). */
export async function readCartLines(): Promise<CartLine[]> {
  return dropMissingProducts(prisma, parseCartCookie((await cookies()).get(CART_COOKIE)?.value));
}

/** Cookie que el header de la tienda lee para la burbuja del carrito (contrato en components/store/cart-count.ts). */
const CART_COUNT_COOKIE = "ceium_cart_count";

/** Solo en server actions / route handlers (escribir cookies no se puede durante el render). */
export async function writeCartLines(lines: CartLine[]): Promise<void> {
  const store = await cookies();
  if (lines.length === 0) {
    store.delete(CART_COOKIE);
    store.delete(CART_COUNT_COOKIE);
  } else {
    store.set(CART_COOKIE, serializeCart(lines), CART_COOKIE_OPTIONS);
    store.set(CART_COUNT_COOKIE, String(lines.length), { ...CART_COOKIE_OPTIONS, httpOnly: false });
  }
}

export async function getCart(): Promise<ResolvedCart> {
  return resolveCart({ db: prisma, now: () => new Date() }, await readCartLines());
}

/** Nº de programas en el carrito (las mismas líneas que muestra la página del carrito). */
export async function getCartCount(): Promise<number> {
  return (await readCartLines()).length;
}
