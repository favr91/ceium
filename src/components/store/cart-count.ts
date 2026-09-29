// Nº de programas en el carrito para la burbuja del header. El carrito vive en la cookie httpOnly de
// src/server/cart.ts (una línea por programa, cantidad 1), así que el conteo se lee en el servidor:
// el layout lo pasa al header y el header lo vuelve a pedir (server action) al cambiar de página.
// Cuenta solo las líneas cuyo programa sigue existiendo, igual que la página del carrito.
// Para refrescarlo al instante sin navegar: window.dispatchEvent(new CustomEvent("ceium:cart-count", { detail: { count } })).
import { prisma } from "@/server/db";
import { CART_COOKIE, dropMissingProducts, parseCartCookie } from "@/server/cart";

export async function cartCountFromCookie(raw: string | undefined | null): Promise<number> {
  return (await dropMissingProducts(prisma, parseCartCookie(raw))).length;
}
export { CART_COOKIE };
