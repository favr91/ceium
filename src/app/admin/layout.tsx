import type { Metadata } from "next";

export const metadata: Metadata = { title: "Panel", robots: { index: false, follow: false } };

// Layout del panel admin (auth + navegación se construyen aquí).
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
