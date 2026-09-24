// Layout del checkout: como el checkout de Shopify de ceium.net, sin el menú ni el pie de la tienda
// (solo el logo, que vuelve a la tienda, y la bolsa, que vuelve al carrito) para que el médico se concentre en
// pagar. Misma tipografía (Inter) que la tienda.
import type { Metadata } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { BagIcon } from "@/components/checkout/icons";
import "@/components/checkout/checkout.css";

const inter = localFont({
  src: "../(store)/fonts/inter-latin-var.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--font-inter",
  fallback: ["system-ui", "sans-serif"],
});

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`co-root ${inter.variable}`}>
      <a className="co-skip" href="#co-main">
        Ir directamente al contenido
      </a>
      <header className="co-header">
        <div className="co-header-inner">
          <Link href="/" className="co-logo" aria-label="CEIUM: volver a la tienda">
            {/* eslint-disable-next-line @next/next/no-img-element -- logo SVG vectorial */}
            <img src="/store/logo-ceium.svg" alt="CEIUM" width={120} height={43} />
          </Link>
          <Link href="/cart" className="co-bag" aria-label="Volver al carrito">
            <BagIcon />
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
