import { prisma } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const products = await prisma.product.count();
  return Response.json({ ok: true, products });
}
