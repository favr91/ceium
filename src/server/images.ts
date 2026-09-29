// Optimización de las imágenes que se suben desde el panel. Sea cual sea lo que suba el equipo (una foto del
// teléfono de 12 MB, un PNG enorme), se guarda:
//  - orientada según la cámara y sin metadatos (EXIF, ubicación GPS, modelo del teléfono);
//  - en WebP, en los anchos de IMAGE_TIERS que no superen el original (la tienda pide el que necesita,
//    ver sizedImage), sin agrandar nunca la imagen;
//  - más un JPG de 1200 px con fondo blanco para la vista previa al compartir el enlace (WhatsApp, Facebook).
import sharp from "sharp";
import { IMAGE_TIERS } from "@/components/store/image-url";
import { DomainError } from "@/server/errors";

/** Tope de píxeles de entrada (una foto de 200 MP ya es de cámara profesional; evita agotar la memoria). */
const MAX_INPUT_PIXELS = 200_000_000;
const WEBP = { quality: 82, effort: 4, smartSubsample: true } as const;

export interface OptimizedImage {
  /** WebP por ancho, de menor a mayor; el último es la imagen principal. */
  variants: { tier: number; data: Buffer }[];
  /** JPG para compartir (máx. 1200 px). */
  share: Buffer;
  /** Tamaño real de la variante más grande. */
  width: number;
  height: number;
}

/**
 * Anchos a generar para un original de `width` px: todos los menores y el primero que lo cubre (con el tamaño
 * del original). Así sizedImage puede pedir cualquier ancho hasta el de la URL guardada.
 */
export function tiersFor(width: number): number[] {
  const below = IMAGE_TIERS.filter((t) => t < width);
  const cover = IMAGE_TIERS.find((t) => t >= width);
  return cover ? [...below, cover] : [...below];
}

function unreadable(e: unknown): never {
  const msg = String((e as Error)?.message ?? e);
  if (/pixel limit/i.test(msg)) throw new DomainError("VALIDATION", "La imagen es demasiado grande (más de 200 megapíxeles).");
  throw new DomainError("VALIDATION", "No pudimos leer la imagen: el archivo está dañado o no es una imagen válida.");
}

export async function optimizeImage(bytes: Uint8Array): Promise<OptimizedImage> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata().catch(unreadable);
  const animated = (meta.pages ?? 1) > 1;
  const rotated = (meta.orientation ?? 1) >= 5; // EXIF 5–8: la foto está girada 90°
  const srcWidth = (rotated ? meta.height : meta.width) ?? 0;
  if (!srcWidth) unreadable(new Error("sin tamaño"));
  const top = IMAGE_TIERS[IMAGE_TIERS.length - 1];

  try {
    // Se decodifica una sola vez: la variante más grande en píxeles crudos y de ahí las demás (una foto de
    // 48 MP ocupa ~200 MB decodificada; así no se decodifica una vez por cada ancho).
    const variants: OptimizedImage["variants"] = [];
    let width = 0;
    let height = 0;
    if (animated) {
      // GIF/WebP animado: se conserva la animación (en WebP animado). Poco común; se procesa desde el original.
      for (const tier of tiersFor(srcWidth)) {
        const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: true })
          .rotate()
          .resize({ width: tier, withoutEnlargement: true })
          .webp(WEBP)
          .toBuffer({ resolveWithObject: true });
        variants.push({ tier, data });
        width = info.width;
        height = info.pageHeight ?? info.height;
      }
    } else {
      const master = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: top, withoutEnlargement: true })
        .toColourspace("srgb")
        .raw({ depth: "uchar" })
        .toBuffer({ resolveWithObject: true });
      const raw = { raw: { width: master.info.width, height: master.info.height, channels: master.info.channels } };
      width = master.info.width;
      height = master.info.height;
      for (const tier of tiersFor(srcWidth)) {
        const data = await sharp(master.data, raw).resize({ width: Math.min(tier, width), withoutEnlargement: true }).webp(WEBP).toBuffer();
        variants.push({ tier, data });
      }
    }
    // Vista previa al compartir: primer cuadro, sin transparencia (fondo blanco), JPG progresivo.
    const share = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return { variants, share, width, height };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    unreadable(e);
  }
}
