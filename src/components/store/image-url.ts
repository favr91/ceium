// URL de imagen al ancho que necesita cada <img> (tienda y panel; sin dependencias de servidor).
//  - Subidas desde el panel: se guardan en WebP en varios anchos (`…-w320.webp` … `…-w1600.webp`, ver
//    server/images.ts) y la URL guardada es la más grande; aquí se cambia por la más chica que alcanza.
//  - CDN de Shopify (imágenes importadas de ceium.net): se le pide el ancho con `?width=`.

/** Anchos que se generan al subir una imagen (px). */
export const IMAGE_TIERS = [320, 640, 960, 1280, 1600] as const;

const TIERED = /^(\/uploads\/.+)-w(\d+)\.webp$/;
const SHOPIFY_CDN = /^(https?:)?\/\/(cdn\.shopify\.com|ceium\.net\/cdn)\//;

/** URL de la imagen con el ancho justo para mostrarla a `width` px (ya contando pantallas retina si aplica). */
export function sizedImage(url: string, width: number): string {
  const m = TIERED.exec(url);
  if (m) {
    const largest = Number(m[2]);
    const tier = IMAGE_TIERS.find((t) => t >= width) ?? IMAGE_TIERS[IMAGE_TIERS.length - 1];
    return `${m[1]}-w${Math.min(tier, largest)}.webp`;
  }
  if (!SHOPIFY_CDN.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=${width}`;
}

/** Imagen para compartir el enlace (WhatsApp, Facebook): JPG de 1200 px, que todas las apps muestran. */
export function shareImage(url: string): string {
  const m = TIERED.exec(url);
  if (m) return `${m[1]}-og.jpg`;
  const abs = url.startsWith("//") ? `https:${url}` : url;
  return SHOPIFY_CDN.test(abs) ? `${abs}${abs.includes("?") ? "&" : "?"}width=1200` : abs;
}
