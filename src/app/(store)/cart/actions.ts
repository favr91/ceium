"use server";
// Acciones del carrito. La ficha de producto usa `addToCart` (o el formulario con `addToCartForm`); la página
// /cart usa `updateCartQuantity` y `removeFromCart`. El carrito es una cookie: no hay datos de otra persona que
// proteger, y todo se vuelve a validar contra la BD al mostrarlo y en el checkout.
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { addCartLine, MAX_QUANTITY, removeCartLine, type CartLineInput } from "@/server/cart";
import { prisma } from "@/server/db";
import { isDomainError } from "@/server/errors";
import { readCartLines, writeCartLines } from "./data";

export type CartActionResult = { ok: true; count: number } | { ok: false; error: string };

/** Agrega (o reemplaza, si ya está) un programa con su modalidad, sede, cohorte y forma de pago. */
export async function addToCart(input: CartLineInput): Promise<CartActionResult> {
  try {
    const next = await addCartLine(prisma, await readCartLines(), input);
    await writeCartLines(next);
    refresh();
    return { ok: true, count: next.length };
  } catch (e) {
    if (!isDomainError(e)) {
      console.error("[cart/add]", e);
      return { ok: false, error: "No pudimos agregar el programa al carrito. Intenta de nuevo." };
    }
    return { ok: false, error: e.message };
  }
}

function formInput(fd: FormData): CartLineInput {
  const get = (k: string) => {
    const v = fd.get(k);
    return typeof v === "string" && v !== "" ? v : null;
  };
  return {
    productId: get("productId") ?? "",
    modality: (get("modality") ?? "") as CartLineInput["modality"],
    sedeId: get("sedeId"),
    cohortId: get("cohortId"),
    choiceId: get("choiceId"),
    planKind: (get("planKind") ?? "") as CartLineInput["planKind"],
  };
}

/** Para `useActionState` en un formulario: campos productId, modality, sedeId, cohortId, choiceId, planKind. */
export async function addToCartForm(_prev: CartActionResult | null, fd: FormData): Promise<CartActionResult> {
  const res = await addToCart(formInput(fd));
  if (res.ok && fd.get("redirectTo") === "cart") redirect("/cart");
  return res;
}

/** Cantidad de una línea: 0 la elimina; una inscripción es personal, así que el máximo es 1. */
export async function updateCartQuantity(key: string, quantity: number): Promise<CartActionResult> {
  const lines = await readCartLines();
  if (!lines.some((l) => l.key === key)) {
    refresh();
    return { ok: false, error: "Este programa ya no está en tu carrito." };
  }
  if (!Number.isInteger(quantity) || quantity < 0) return { ok: false, error: "Cantidad no válida." };
  if (quantity > MAX_QUANTITY) {
    return { ok: false, error: "La inscripción es personal: solo puedes agregar 1 por programa. Para inscribir a otra persona, haz un pedido a su nombre." };
  }
  const next = quantity === 0 ? removeCartLine(lines, key) : lines;
  await writeCartLines(next);
  refresh();
  return { ok: true, count: next.length };
}

export async function removeFromCart(key: string): Promise<CartActionResult> {
  return updateCartQuantity(key, 0);
}
