import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cada carril del gauntlet (tienda, compra, panel, e2e) corre su propio `next dev` en paralelo
  // sobre el mismo árbol; cada uno necesita su propio directorio de build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
