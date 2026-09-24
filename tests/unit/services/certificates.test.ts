import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, startPaypalPayment } from "@/server/payments";
import { checkDiplomaCompletion, generateCertificateCode, runCertificateSweep, verifyCertificate } from "@/server/certificates";
import { runJobs } from "@/server/jobs";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("certificates");
});
afterEach(async () => {
  await ctx.dispose();
});

async function enrolledInDiploma() {
  const o = await createCheckout(ctx.d, { customer: { ...buyer(), firstName: "José Ángel", lastName: "Muñoz" }, items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  return { order: o, customer: c, moodleUserId: c.moodleUserId! };
}

describe("certificado de diplomado", () => {
  it("con 8/9 cursos completos NO se emite; con 9/9 SÍ (PDF + código verificable + correo)", async () => {
    const { customer, moodleUserId, order } = await enrolledInDiploma();
    for (const id of ctx.fx.diplomaMoodleIds.slice(0, 8)) ctx.moodle.markCompleted(moodleUserId, id);

    const r8 = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r8).toMatchObject({ issued: false, total: 9, completed: 8, pendingCourseIds: [309] });
    expect(await ctx.db.certificate.count()).toBe(0);
    expect(await ctx.db.emailOutbox.count({ where: { template: "certificate_issued" } })).toBe(0);
    // el job tampoco la emite
    expect((await runCertificateSweep(ctx.d)).issued).toBe(0);
    expect(await ctx.db.certificate.count()).toBe(0);

    ctx.moodle.markCompleted(moodleUserId, 309);
    const r9 = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r9).toMatchObject({ issued: true, alreadyIssued: false, total: 9, completed: 9, pendingCourseIds: [] });
    expect(r9.code).toMatch(/^CEIUM-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    // Las completadas se cachean para contar (el barrido solo consulta las pendientes: el 9), pero antes de
    // emitir se vuelven a confirmar con Moodle las 8 cacheadas: la caché nunca basta para certificar.
    const completionCalls = ctx.moodle.calls.filter((c) => c.fn === "getCompletion").map((c) => c.args[1]);
    expect(completionCalls.slice(-9)).toEqual([309, 301, 302, 303, 304, 305, 306, 307, 308]);

    const cert = await ctx.db.certificate.findUniqueOrThrow({ where: { code: r9.code! } });
    expect(cert.pdfPath).toBeTruthy();
    const pdf = await PDFDocument.load(fs.readFileSync(cert.pdfPath!));
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe(`Certificado ${cert.code}`);
    const mail = await ctx.db.emailOutbox.findFirstOrThrow({ where: { template: "certificate_issued" } });
    expect(mail.html).toContain(cert.code);
    expect(mail.html).toContain(`https://ceium.test/certificados/${cert.code}`);
    const eml = fs.readFileSync(mail.emlPath!, "utf8");
    expect(eml).toContain(`Certificado-${cert.code}.pdf`);
    expect(cert.emailedAt).not.toBeNull();
    expect(await ctx.db.orderEvent.count({ where: { orderId: order.id, type: "CERTIFICATE_ISSUED" } })).toBe(1);

    const v = await verifyCertificate(ctx.d, cert.code.toLowerCase());
    expect(v).toMatchObject({ holder: "José Ángel Muñoz", status: "ISSUED", diploma: expect.stringContaining("Diplomado") });
    expect(await verifyCertificate(ctx.d, "CEIUM-XXXXX-XXXXX")).toBeNull();

    // idempotente: nunca se emite dos veces
    const again = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(again).toMatchObject({ issued: true, alreadyIssued: true, code: cert.code });
    expect((await runCertificateSweep(ctx.d)).issued).toBe(0);
    expect(await ctx.db.certificate.count()).toBe(1);
  });

  it("el job (runJobs) barre a todos los inscritos y emite solo a quien completó", async () => {
    const a = await enrolledInDiploma();
    const b = await enrolledInDiploma();
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(a.moodleUserId, id);
    for (const id of ctx.fx.diplomaMoodleIds.slice(1)) ctx.moodle.markCompleted(b.moodleUserId, id);
    const out = (await runJobs(ctx.d, ["certificates"])) as { certificates: { checked: number; issued: number } };
    expect(out.certificates).toMatchObject({ checked: 2, issued: 1 });
    expect(await ctx.db.certificate.findMany({ select: { customerId: true } })).toEqual([{ customerId: a.customer.id }]);
  });

  it("sin inscripción vigente (reembolsado) o sin matrícula en un curso → no se emite", async () => {
    const { customer, moodleUserId, order } = await enrolledInDiploma();
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(moodleUserId, id);
    await ctx.db.enrollment.updateMany({ where: { orderId: order.id, moodleCourseId: 305 }, data: { status: "FAILED" } });
    expect((await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma)).issued).toBe(false);
    await ctx.db.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
    const r = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r.issued).toBe(false);
    expect(r.reason).toMatch(/inscripción vigente/);
  });

  it("códigos únicos", () => {
    const codes = new Set(Array.from({ length: 2000 }, generateCertificateCode));
    expect(codes.size).toBe(2000);
  });
});
