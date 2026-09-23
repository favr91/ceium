import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CEIUM", template: "%s – CEIUM" },
  description: "Centro de Estudios e Investigación en Ultrasonido Médico — cursos y diplomados avalados por la UCLA.",
};

// Layout raíz mínimo. La tienda usa (store)/layout.tsx y el panel admin/layout.tsx.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-VE">
      <body>{children}</body>
    </html>
  );
}
