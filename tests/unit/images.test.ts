// Optimización de imágenes subidas (server/images), URL al ancho justo (image-url) y ruta segura de /uploads.
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { IMAGE_TIERS, shareImage, sizedImage } from "@/components/store/image-url";
import { optimizeImage, tiersFor } from "@/server/images";
import { resolveUpload } from "@/server/uploads";

/** Foto «de teléfono»: JPG grande con ruido (no se comprime fácil), EXIF con giro de 90° y ubicación GPS. */
async function phonePhoto(width = 4000, height = 3000) {
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  return sharp(noise, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "Teléfono", Model: "X" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "10/1 4/1 0/1" } } })
    .toBuffer();
}

describe("optimizeImage", () => {
  it("anchos a generar: los menores al original y el primero que lo cubre", () => {
    expect(tiersFor(100)).toEqual([320]);
    expect(tiersFor(500)).toEqual([320, 640]);
    expect(tiersFor(1600)).toEqual([320, 640, 960, 1280, 1600]);
    expect(tiersFor(4000)).toEqual([...IMAGE_TIERS]);
  });

  it("foto pesada del teléfono: se gira, se reduce a WebP en cada ancho y pierde EXIF/GPS", async () => {
    const input = await phonePhoto();
    const out = await optimizeImage(input);
    expect(out.variants.map((v) => v.tier)).toEqual([...IMAGE_TIERS]);
    // EXIF 6 = girada 90°: la foto queda vertical (3000×4000 → 1600×2133).
    expect([out.width, out.height]).toEqual([1600, 2133]);
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.format).toBe("webp");
      expect(m.width).toBe(v.tier);
      expect(m.exif).toBeUndefined();
      expect(m.orientation).toBeUndefined();
    }
    const total = out.variants.reduce((n, v) => n + v.data.byteLength, 0);
    expect(total).toBeLessThan(input.byteLength / 2);
    const share = await sharp(out.share).metadata();
    expect(share.format).toBe("jpeg");
    expect(Math.max(share.width!, share.height!)).toBe(1200);
    expect(share.exif).toBeUndefined();
  });

  it("no agranda imágenes chicas y conserva la transparencia del PNG (el JPG para compartir va con fondo blanco)", async () => {
    const png = await sharp({ create: { width: 500, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const out = await optimizeImage(png);
    expect(out.variants.map((v) => v.tier)).toEqual([320, 640]);
    expect([out.width, out.height]).toEqual([500, 300]);
    const big = await sharp(out.variants[1].data).metadata();
    expect([big.width, big.hasAlpha]).toEqual([500, true]);
    const px = await sharp(out.share).raw().toBuffer();
    expect([px[0], px[1], px[2]]).toEqual([255, 255, 255]);
  });

  it("GIF animado: sigue animado en WebP", async () => {
    const frame = (c: string) => sharp({ create: { width: 400, height: 200, channels: 3, background: c } }).png().toBuffer();
    const gif = await sharp([await frame("#ff0000"), await frame("#0000ff")], { join: { animated: true } }).gif().toBuffer();
    const out = await optimizeImage(gif);
    const m = await sharp(out.variants[out.variants.length - 1].data, { animated: true }).metadata();
    expect(m.format).toBe("webp");
    expect(m.pages).toBe(2);
    expect([out.width, out.height]).toEqual([400, 200]);
  });

  it("archivo roto o que no es imagen: error de validación claro", async () => {
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    await expect(optimizeImage(broken)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("No pudimos leer la imagen") });
  });
});

describe("sizedImage / shareImage", () => {
  const up = "/uploads/products/p1/taller-abc123ef-w1600.webp";

  it("subidas optimizadas: el ancho más chico que alcanza, sin pasar del más grande que existe", () => {
    expect(sizedImage(up, 100)).toBe("/uploads/products/p1/taller-abc123ef-w320.webp");
    expect(sizedImage(up, 600)).toBe("/uploads/products/p1/taller-abc123ef-w640.webp");
    expect(sizedImage(up, 1100)).toBe("/uploads/products/p1/taller-abc123ef-w1280.webp");
    expect(sizedImage(up, 2048)).toBe("/uploads/products/p1/taller-abc123ef-w1600.webp");
    expect(sizedImage("/uploads/products/p1/logo-00ff00ff-w640.webp", 1100)).toBe("/uploads/products/p1/logo-00ff00ff-w640.webp");
    expect(shareImage(up)).toBe("/uploads/products/p1/taller-abc123ef-og.jpg");
  });

  it("CDN de Shopify con ?width=; otras URL sin tocar", () => {
    expect(sizedImage("//ceium.net/cdn/shop/files/a.jpg?v=1", 600)).toBe("//ceium.net/cdn/shop/files/a.jpg?v=1&width=600");
    expect(sizedImage("https://cdn.shopify.com/s/a.png", 320)).toBe("https://cdn.shopify.com/s/a.png?width=320");
    expect(shareImage("//ceium.net/cdn/shop/files/a.jpg?v=1")).toBe("https://ceium.net/cdn/shop/files/a.jpg?v=1&width=1200");
    expect(sizedImage("/uploads/products/p1/antigua.png", 600)).toBe("/uploads/products/p1/antigua.png");
    expect(sizedImage("https://ejemplo.com/a.jpg", 600)).toBe("https://ejemplo.com/a.jpg");
  });
});

describe("resolveUpload (ruta /uploads/…)", () => {
  const root = path.resolve("/srv/ceium/uploads");

  it("solo imágenes dentro de la carpeta de subidas", () => {
    expect(resolveUpload(root, ["products", "p1", "a-w320.webp"])).toBe(path.join(root, "products/p1/a-w320.webp"));
    expect(resolveUpload(root, ["products", "p1", "a-og.jpg"])).toBe(path.join(root, "products/p1/a-og.jpg"));
    expect(resolveUpload(root, ["..", "files", "comprobante.jpg"])).toBeNull();
    expect(resolveUpload(root, ["products", "..", "..", "var", "x.png"])).toBeNull();
    expect(resolveUpload(root, ["products", "a/../../x.png"])).toBeNull();
    expect(resolveUpload(root, [".env"])).toBeNull();
    expect(resolveUpload(root, ["products", "notas.txt"])).toBeNull();
    expect(resolveUpload(root, ["products", "x.svg"])).toBeNull();
    expect(resolveUpload(root, [])).toBeNull();
  });
});
