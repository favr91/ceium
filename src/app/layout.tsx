import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Base de las URL absolutas que piden og:image y compañía (vista previa al compartir un enlace).
  metadataBase: new URL(process.env.APP_URL || "http://localhost:3000"),
  title: { default: "CEIUM", template: "%s – CEIUM" },
  description: "Centro de Enseñanza e Investigación de Ultrasonido en Medicina: cursos y diplomados avalados por la UCLA.",
};

// Layout raíz mínimo. La tienda usa (store)/layout.tsx y el panel admin/layout.tsx.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-VE">
      <body>{children}</body>
    </html>
  );
}
