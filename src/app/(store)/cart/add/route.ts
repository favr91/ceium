// GET /cart/add?product=<slug|id>&modality=SEMIPRESENCIAL&sede=<slug|id>&cohort=<id>&plan=FULL
// Enlace directo «agregar al carrito» (como /cart/add de Shopify): útil para enlaces en correos, WhatsApp y
// pruebas. Agrega el programa y redirige a /cart (con ?error=… si no se pudo).
import { NextResponse, type NextRequest } from "next/server";
import { addCartLine, type CartLineInput } from "@/server/cart";
import { prisma } from "@/server/db";
import { isDomainError } from "@/server/errors";
import { readCartLines, writeCartLines } from "../data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const productRef = q.get("product") ?? q.get("productId") ?? "";
  const sedeRef = q.get("sede") ?? q.get("sedeId");
  const target = new URL("/cart", req.nextUrl);
  try {
    const product = productRef ? await prisma.product.findFirst({ where: { OR: [{ id: productRef }, { slug: productRef }] }, select: { id: true } }) : null;
    const sede = sedeRef ? await prisma.sede.findFirst({ where: { OR: [{ id: sedeRef }, { slug: sedeRef }] }, select: { id: true } }) : null;
    const input: CartLineInput = {
      productId: product?.id ?? "",
      modality: (q.get("modality") ?? "").toUpperCase() as CartLineInput["modality"],
      sedeId: sede?.id ?? null,
      cohortId: q.get("cohort") ?? q.get("cohortId"),
      choiceId: q.get("choice") ?? q.get("choiceId"),
      planKind: (q.get("plan") ?? q.get("planKind") ?? "FULL").toUpperCase() as CartLineInput["planKind"],
    };
    await writeCartLines(await addCartLine(prisma, await readCartLines(), input));
  } catch (e) {
    if (!isDomainError(e)) console.error("[cart/add]", e);
    target.searchParams.set("error", isDomainError(e) ? e.message : "No pudimos agregar el programa al carrito.");
  }
  return NextResponse.redirect(target, 303);
}
