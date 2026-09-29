import type { NextConfig } from "next";

// Cabeceras de seguridad para todas las respuestas (el panel no se puede incrustar en otro sitio: evita que una
// página ajena lo muestre en un iframe invisible y le haga pulsar «Aprobar pago» o «Reembolsar»).
const https = process.env.NODE_ENV === "production" && (process.env.APP_URL ?? "").startsWith("https://");
const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()" },
  // Solo con https real: obliga al navegador a no volver a usar http (protege las cookies del pedido y del panel).
  ...(https ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // El enlace del pedido es su única credencial: que no viaje como Referer a otros sitios (imágenes, PayPal…).
      // «same-origin» y no «no-referrer»: con este último el navegador manda `Origin: null` en los POST y Next rechaza
      // las Server Actions de la página (protección CSRF).
      { source: "/pedido/:path*", headers: [{ key: "Referrer-Policy", value: "same-origin" }] },
      { source: "/checkout/:path*", headers: [{ key: "Referrer-Policy", value: "same-origin" }] },
    ];
  },
  // Cada carril del gauntlet (tienda, compra, panel, e2e) corre su propio `next dev` en paralelo
  // sobre el mismo árbol; cada uno necesita su propio directorio de build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // /pedido/[token] registra el pago manual con su comprobante por Server Action (reportManualPayment). Se
    // anuncian 10 MB (PROOF_MAX_BYTES; una foto de teléfono del pago móvil pesa 1–3 MB): el límite por defecto
    // de 1 MB la rechazaría con 413. 11 MB deja margen para los bytes del multipart y los demás campos.
    serverActions: { bodySizeLimit: "11mb" },
  },
};

export default nextConfig;
