import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
