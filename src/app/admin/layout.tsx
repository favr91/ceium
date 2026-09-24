import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "@/components/admin/admin.css";

const inter = Inter({ subsets: ["latin"], variable: "--adm-font", display: "swap" });

export const metadata: Metadata = { title: { default: "Panel", template: "%s · Panel CEIUM" }, robots: { index: false, follow: false } };

// Raíz del panel: tipografía y sistema visual (admin.css). La sesión y la navegación viven en (panel)/layout.tsx;
// /admin/login queda fuera de ese grupo.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className={`adm ${inter.variable}`}>{children}</div>;
}
