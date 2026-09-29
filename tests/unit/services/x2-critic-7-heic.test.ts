// x2 (crítico 7): comprobantes HEIC (foto de iPhone). Chrome/Firefox no los muestran y sharp no trae HEVC, así que
// el servidor no los acepta, ni por extensión ni renombrados a .jpg (se mira la caja `ftyp`). El checkout ya no
// lista HEIC en `accept`, para que Safari de iOS convierta la foto a JPEG antes de enviarla.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { storeProofFile } from "@/server/payments";
import { PROOF_ACCEPT, proofError } from "@/components/checkout/manual-payment-fields";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

const HEIC = fs.readFileSync(path.join(__dirname, "../../e2e/fixtures/x2/comprobante.heic"));
const ftyp = (major: string, ...compat: string[]) => {
  const size = 16 + 4 * compat.length;
  const b = Buffer.alloc(size + 8);
  b.writeUInt32BE(size, 0);
  b.write("ftyp", 4, "latin1");
  b.write(major, 8, "latin1");
  compat.forEach((c, i) => b.write(c, 16 + 4 * i, "latin1"));
  return new Uint8Array(b);
};

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-7-heic");
});
afterEach(async () => {
  await ctx.dispose();
});

async function order() {
  return createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
}

describe("comprobante HEIC", () => {
  it("rechaza .heic/.heif por extensión y no guarda nada", async () => {
    const o = await order();
    for (const name of ["IMG_0421.HEIC", "foto.heif"]) {
      await expect(storeProofFile(ctx.d, o.id, name, new Uint8Array(HEIC))).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/HEIC/) });
    }
    expect(fs.existsSync(path.resolve(ctx.d.config.privateFilesDir, "proofs", o.id))).toBe(false);
  });

  it("rechaza una foto HEIC renombrada a .jpg (mira el contenido)", async () => {
    const o = await order();
    await expect(storeProofFile(ctx.d, o.id, "captura.jpg", new Uint8Array(HEIC))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(storeProofFile(ctx.d, o.id, "captura.png", ftyp("mif1", "heic"))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("acepta JPEG/PNG/PDF reales y no confunde AVIF ni bytes cortos con HEIC", async () => {
    const o = await order();
    const jpegHeaderOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
    await expect(storeProofFile(ctx.d, o.id, "captura.jpg", TINY_JPEG)).resolves.toMatch(/\.jpg$/);
    await expect(storeProofFile(ctx.d, o.id, "recibo.pdf", new Uint8Array(Buffer.from("%PDF-1.4\n%…")))).resolves.toMatch(/\.pdf$/);
    // Se valida por contenido (y las fotos se vuelven a codificar): una cabecera sin imagen, un AVIF renombrado a
    // .webp o bytes sueltos no entran, pero tampoco se confunden con HEIC.
    for (const [name, bytes] of [["captura.jpg", jpegHeaderOnly], ["a.webp", ftyp("avif", "mif1", "miaf")], ["a.jpg", new Uint8Array([1, 2, 3])]] as const) {
      await expect(storeProofFile(ctx.d, o.id, name, bytes)).rejects.toMatchObject({ code: "VALIDATION", message: expect.not.stringMatching(/HEIC/) });
    }
  });

  it("el checkout no ofrece HEIC y explica qué enviar", () => {
    expect(PROOF_ACCEPT).not.toMatch(/hei[cf]/i);
    expect(proofError({ name: "IMG_0421.HEIC", size: 2_000_000 })).toMatch(/HEIC.*captura de pantalla/);
    expect(proofError({ name: "IMG_0421.jpg", size: 2_000_000 })).toBeUndefined();
  });
});
