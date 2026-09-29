"use server";
import { cookies } from "next/headers";
import { cartCountFromCookie, CART_COOKIE } from "./cart-count";

/** Nº de programas en el carrito (lo pide el header al navegar, porque el layout no se vuelve a renderizar). */
export async function readCartCount(): Promise<number> {
  return cartCountFromCookie((await cookies()).get(CART_COOKIE)?.value);
}
