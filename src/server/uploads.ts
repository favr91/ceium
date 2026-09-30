// Carpeta de imágenes subidas desde el panel (servidas por app/uploads/[...path]/route.ts): galería de los
// programas y fotos del personal. Tipo por la firma del archivo, optimización en varios anchos
// (server/images.ts) y borrado de todos sus archivos.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Deps } from "@/server/deps";
import { DomainError } from "@/server/errors";
import { optimizeImage } from "@/server/images";
import { IMAGE_TIERS } from "@/components/store/image-url";

export const UPLOAD_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

/** Ruta absoluta dentro de la carpeta de subidas, o null si sale de ella, es oculta o no es una imagen. */
export function resolveUpload(root: string, parts: string[]): string | null {
  if (!parts.length || parts.some((p) => !p || p.startsWith(".") || p.includes("\0") || p.includes("/") || p.includes("\\"))) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (!abs.startsWith(base + path.sep)) return null;
  return UPLOAD_TYPES[path.extname(abs).toLowerCase()] ? abs : null;
}

export const UPLOADS_URL = "/uploads/";
/** Tope por archivo (el panel sube de a uno y reduce las fotos grandes en el navegador antes de enviarlas). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const IMAGE_TYPES: Record<string, { ext: string; sniff: (b: Uint8Array) => boolean }> = {
  jpg: { ext: ".jpg", sniff: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { ext: ".png", sniff: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  webp: { ext: ".webp", sniff: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  gif: { ext: ".gif", sniff: (b) => ascii(b, 0, 4) === "GIF8" },
  avif: { ext: ".avif", sniff: (b) => ascii(b, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 12)) },
};

/** Detecta el tipo por la firma del archivo (no por el nombre): nada que no sea imagen llega a public/. */
export function sniffImage(bytes: Uint8Array): string {
  for (const t of Object.values(IMAGE_TYPES)) if (t.sniff(bytes)) return t.ext;
  throw new DomainError("VALIDATION", "La imagen debe ser JPG, PNG, WEBP, GIF o AVIF.");
}

function uploadPathFor(d: Deps, url: string): string | null {
  if (!url.startsWith(UPLOADS_URL)) return null;
  const root = path.resolve(d.config.publicUploadsDir);
  const abs = path.resolve(root, url.slice(UPLOADS_URL.length));
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** Archivos de una imagen subida: la URL guardada y, si es optimizada (`…-w<ancho>.webp`), todos sus anchos y el JPG. */
function uploadedFiles(d: Deps, url: string): string[] {
  const abs = uploadPathFor(d, url);
  if (!abs) return [];
  const m = /^(.+)-w\d+\.webp$/.exec(abs);
  return m ? [...IMAGE_TIERS.map((t) => `${m[1]}-w${t}.webp`), `${m[1]}-og.jpg`] : [abs];
}

/** Nombre de archivo descriptivo (ayuda a Google Imágenes): el texto en minúsculas y con guiones, cortado en un guion. */
export function fileStem(s: string): string {
  const slug = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const cut = slug.length > 60 ? slug.slice(0, 60).replace(/-[^-]*$/, "") : slug;
  return cut || "imagen";
}

export interface StoredImage {
  /** URL guardable: la variante más ancha (sizedImage elige la que haga falta). */
  url: string;
  width: number;
  height: number;
  /** Rutas escritas, para deshacer si el cambio que la usa no llega a guardarse. */
  files: string[];
}

/** Optimiza y guarda la imagen en <uploads>/<dir>/<nombre>-<hex>-w<ancho>.webp (un archivo por ancho) + -og.jpg. */
export async function storeOptimizedImage(d: Deps, dir: string, name: string, bytes: Uint8Array): Promise<StoredImage> {
  if (!bytes?.byteLength) throw new DomainError("VALIDATION", "El archivo está vacío.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new DomainError("VALIDATION", "La imagen no puede superar 10 MB.");
  sniffImage(bytes); // solo imágenes (por su firma, no por el nombre)
  const img = await optimizeImage(bytes);
  const stem = `${fileStem(name)}-${crypto.randomBytes(4).toString("hex")}`;
  const abs = path.resolve(d.config.publicUploadsDir, dir);
  await fs.mkdir(abs, { recursive: true });
  const files: string[] = [];
  try {
    for (const v of img.variants) {
      files.push(path.join(abs, `${stem}-w${v.tier}.webp`));
      await fs.writeFile(files[files.length - 1], v.data);
    }
    files.push(path.join(abs, `${stem}-og.jpg`));
    await fs.writeFile(files[files.length - 1], img.share);
  } catch (e) {
    await removeFiles(files);
    throw e;
  }
  return { url: `${UPLOADS_URL}${dir}/${stem}-w${img.variants[img.variants.length - 1].tier}.webp`, width: img.width, height: img.height, files };
}

export async function removeFiles(files: string[]) {
  for (const f of files) await fs.rm(f, { force: true }).catch(() => {});
}

/** Borra los archivos de una imagen subida, solo si está dentro de <uploads>/<dir>/. */
export async function removeUploadedImage(d: Deps, url: string, dir: string) {
  if (!url.startsWith(`${UPLOADS_URL}${dir}/`)) return;
  for (const abs of uploadedFiles(d, url)) {
    try {
      await fs.rm(abs, { force: true });
    } catch (e) {
      d.log.warn(`[uploads] no se pudo borrar ${abs}`, e);
    }
  }
}
