// API JSON del carrito (para componentes cliente de la tienda y para pruebas).
//   GET    → carrito resuelto (líneas, opciones, montos, errores)
//   POST   { productId, modality, sedeId?, cohortId?, choiceId?, planKind } → agrega/reemplaza el programa
//   PATCH  { key, quantity } → 0 elimina; > 1 se rechaza (la inscripción es personal)
//   DELETE → vacía el carrito
import { addCartLine, MAX_QUANTITY, removeCartLine, type CartLineInput } from "@/server/cart";
import { prisma } from "@/server/db";
import { HTTP_STATUS, isDomainError } from "@/server/errors";
import { getCart, readCartLines, writeCartLines } from "@/app/(store)/cart/data";

export const dynamic = "force-dynamic";

function fail(e: unknown) {
  if (isDomainError(e)) return Response.json({ ok: false, error: e.message, code: e.code }, { status: HTTP_STATUS[e.code] });
  console.error("[api/cart]", e);
  return Response.json({ ok: false, error: "Error inesperado." }, { status: 500 });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return {};
  }
}

export async function GET() {
  return Response.json({ ok: true, cart: await getCart() });
}

export async function POST(req: Request) {
  try {
    const next = await addCartLine(prisma, await readCartLines(), (await body(req)) as unknown as CartLineInput);
    await writeCartLines(next);
    return Response.json({ ok: true, count: next.length });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  const b = await body(req);
  const lines = await readCartLines();
  const key = typeof b.key === "string" ? b.key : "";
  const quantity = Number(b.quantity);
  if (!lines.some((l) => l.key === key)) return Response.json({ ok: false, error: "Este programa ya no está en tu carrito." }, { status: 404 });
  if (!Number.isInteger(quantity) || quantity < 0) return Response.json({ ok: false, error: "Cantidad no válida." }, { status: 422 });
  if (quantity > MAX_QUANTITY) return Response.json({ ok: false, error: "La inscripción es personal: solo puedes agregar 1 por programa." }, { status: 422 });
  const next = quantity === 0 ? removeCartLine(lines, key) : lines;
  await writeCartLines(next);
  return Response.json({ ok: true, count: next.length });
}

export async function DELETE() {
  await writeCartLines([]);
  return Response.json({ ok: true, count: 0 });
}
