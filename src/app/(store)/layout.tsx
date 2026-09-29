// Layout de la tienda pública: barra de anuncio, header (menú, búsqueda, carrito), pie y WhatsApp,
// réplica del tema Dawn de ceium.net. Todo el contenido (menú, teléfonos, sedes, WhatsApp) sale de la BD.
import localFont from "next/font/local";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { AnnouncementBar } from "@/components/store/AnnouncementBar";
import { getStoreChrome } from "@/components/store/chrome-data";
import { CART_COOKIE, cartCountFromCookie } from "@/components/store/cart-count";
import { StoreFooter } from "@/components/store/StoreFooter";
import { StoreHeader } from "@/components/store/StoreHeader";
import { WhatsAppButton } from "@/components/store/WhatsAppButton";
import "./store.css";

const inter = localFont({
  src: "./fonts/inter-latin-var.woff2",
  weight: "400 700",
  display: "swap",
  variable: "--font-inter",
  fallback: ["system-ui", "sans-serif"],
});

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  await connection(); // menú, contacto y sedes se leen de la BD en cada request
  const [chrome, jar] = await Promise.all([getStoreChrome(), cookies()]);
  const cartCount = await cartCountFromCookie(jar.get(CART_COOKIE)?.value);
  return (
    <div className={`store-root ${inter.variable}`}>
      <a className="skip-to-content-link visually-hidden" href="#MainContent">
        Ir directamente al contenido
      </a>
      <AnnouncementBar text={chrome.announcement.text} url={chrome.announcement.url} />
      <StoreHeader menu={chrome.menu} campusUrl={chrome.campusUrl} social={chrome.social} cartCount={cartCount} />
      <main id="MainContent" className="content-for-layout" tabIndex={-1}>
        {children}
      </main>
      <StoreFooter chrome={chrome} />
      {chrome.whatsappUrl ? <WhatsAppButton href={chrome.whatsappUrl} /> : null}
    </div>
  );
}
