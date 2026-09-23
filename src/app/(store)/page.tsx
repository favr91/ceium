import Link from "next/link";
import { connection } from "next/server";
import { prisma } from "@/server/db";
import { formatUSD } from "@/server/pricing";

// PLACEHOLDER: la home real (réplica de ceium.net) la construye otra pieza.
export default async function HomePage() {
  await connection(); // render dinámico: lee la BD en cada request
  const products = await prisma.product.findMany({
    where: { published: true },
    orderBy: [{ type: "desc" }, { position: "asc" }],
    include: { prices: { orderBy: { priceCents: "asc" }, take: 1 }, images: { take: 1, orderBy: { position: "asc" } } },
  });
  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "32px 16px" }}>
      <h1 style={{ color: "var(--ink)" }}>CEIUM</h1>
      <p>{products.length} programas en el catálogo.</p>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            <Link href={`/products/${p.slug}`}>{p.title}</Link>
            {p.prices[0] ? <> — desde {formatUSD(p.prices[0].priceCents)}</> : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
