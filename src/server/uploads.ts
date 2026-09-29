// Carpeta de imágenes subidas desde el panel (servidas por app/uploads/[...path]/route.ts).
import path from "node:path";

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
