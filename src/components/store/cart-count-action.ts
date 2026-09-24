"use server";
import { cookies } from "next/headers";
import { CART_COOKIE, parseCartCookie } from "@/server/cart";

/** Nº de programas en el carrito (lo pide el header al navegar, porque el layout no se vuelve a renderizar). */
export async function readCartCount(): Promise<number> {
  return parseCartCookie((await cookies()).get(CART_COOKIE)?.value).length;
}
