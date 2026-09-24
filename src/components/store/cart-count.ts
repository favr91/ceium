// Nº de programas en el carrito para la burbuja del header. El carrito vive en la cookie httpOnly de
// src/server/cart.ts (una línea por programa, cantidad 1), así que el conteo se lee en el servidor:
// el layout lo pasa al header y el header lo vuelve a pedir (server action) al cambiar de página.
// Para refrescarlo al instante sin navegar: window.dispatchEvent(new CustomEvent("ceium:cart-count", { detail: { count } })).
import { CART_COOKIE, parseCartCookie } from "@/server/cart";


export function cartCountFromCookie(raw: string | undefined | null): number {
  return parseCartCookie(raw).length;
}
export { CART_COOKIE };
