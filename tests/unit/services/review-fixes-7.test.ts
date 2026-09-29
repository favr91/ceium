// Ronda 7: la lista de cursos del diplomado se congela por compra (OrderItemCourse) y los datos de pago
// manual / tasa Bs/USD de ejemplo nunca llegan a un comprador.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout, listPaymentOptions, manualMethodUnavailableReason } from "@/server/orders";
import { capturePaypalReturn, recordManualPayment, startPaypalPayment } from "@/server/payments";
import { checkDiplomaCompletion, verifyCertificate } from "@/server/certificates";
import { enrollOrder } from "@/server/enrollment";
import { deleteProduct, setDiplomaCourses } from "@/server/catalog";
import { getSettingsWarnings, updateSetting } from "@/server/admin-settings";
import { SETTING_KEYS, type ManualMethodConfig } from "@/server/settings";
import type { SessionUser } from "@/server/auth";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let admin: SessionUser;
beforeEach(async () => {
  ctx = await setupContext("review-fixes-7");
  admin = { id: ctx.fx.adminId, email: "admin@ceium.net", name: "Admin", role: "ADMIN" };
});
afterEach(async () => {
  await ctx.dispose();
});

async function buyDiplomaFull(n?: number) {
  const o = await createCheckout(ctx.d, { customer: buyer(n), items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  return { order: o, customer: c, moodleUserId: c.moodleUserId! };
}

async function extraCourse(moodleCourseId = 310) {
  return ctx.db.product.create({ data: { type: "COURSE", category: "UNIVERSITY_COURSE", slug: `extra-${moodleCourseId}`, title: `Curso extra ${moodleCourseId}`, moodleCourseId } });
}

describe("lista de cursos congelada por compra", () => {
  it("el pedido guarda los cursos del diplomado en su orden al comprar", async () => {
    const { order } = await buyDiplomaFull();
    const item = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: order.id }, include: { courses: { orderBy: { position: "asc" } } } });
    expect(item.courses.map((c) => c.courseId)).toEqual(ctx.fx.diplomaCourses);
  });

  it("agregar un 10.º curso después de la compra NO bloquea el certificado de quien compró 9 (ni lo matricula en el nuevo)", async () => {
    const { customer, moodleUserId, order } = await buyDiplomaFull();
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(moodleUserId, id);
    const extra = await extraCourse();
    const r = await setDiplomaCourses(ctx.d, admin, ctx.fx.diploma, [...ctx.fx.diplomaCourses, extra.id]);
    expect(r.livePurchases).toBe(1);

    // Re-matricular el pedido no agrega el curso nuevo: el cliente compró 9.
    await enrollOrder(ctx.d, order.id, { force: true });
    expect(await ctx.db.enrollment.count({ where: { customerId: customer.id, moodleCourseId: 310 } })).toBe(0);

    const res = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(res).toMatchObject({ issued: true, total: 9, completed: 9, pendingCourseIds: [] });
    const v = await verifyCertificate(ctx.d, res.code!);
    expect(v!.courses).toHaveLength(9);
    expect(v!.courses).not.toContain("Curso extra 310");
    const cert = await ctx.db.certificate.findUniqueOrThrow({ where: { code: res.code! } });
    expect(fs.existsSync(cert.pdfPath!)).toBe(true);

    // Una compra NUEVA sí lleva los 10 cursos.
    const { order: o2 } = await buyDiplomaFull(9_002); // otro cliente: el mismo comprando dos veces el diploma ya no se cobra (x2 critic 24)
    const item2 = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: o2.id }, include: { courses: true } });
    expect(item2.courses).toHaveLength(10);
    const c2 = await ctx.db.customer.findUniqueOrThrow({ where: { id: o2.customerId } });
    expect(await ctx.db.enrollment.count({ where: { customerId: c2.id, status: "ENROLLED" } })).toBe(10);
  });

  it("quitar un curso después de la compra no certifica un programa distinto del comprado", async () => {
    const { customer, moodleUserId } = await buyDiplomaFull();
    for (const id of ctx.fx.diplomaMoodleIds.slice(0, 8)) ctx.moodle.markCompleted(moodleUserId, id);
    const removed = ctx.fx.diplomaCourses[8];
    await setDiplomaCourses(ctx.d, admin, ctx.fx.diploma, ctx.fx.diplomaCourses.slice(0, 8));

    const r8 = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r8).toMatchObject({ issued: false, total: 9, completed: 8, pendingCourseIds: [309] });
    expect(await ctx.db.certificate.count()).toBe(0);

    // El curso quitado sigue en una compra: no se puede borrar del catálogo.
    await expect(deleteProduct(ctx.d, admin, removed)).rejects.toMatchObject({ code: "CONFLICT" });

    ctx.moodle.markCompleted(moodleUserId, 309);
    const r9 = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r9).toMatchObject({ issued: true, total: 9, completed: 9 });
    expect((await verifyCertificate(ctx.d, r9.code!))!.courses).toContain("Curso 9 del Diplomado");
  });

  it("pedidos anteriores sin lista congelada se congelan con la lista anterior al editar el diplomado", async () => {
    const { order, customer, moodleUserId } = await buyDiplomaFull();
    await ctx.db.orderItemCourse.deleteMany({}); // simula un pedido previo a la congelación
    const extra = await extraCourse();
    await setDiplomaCourses(ctx.d, admin, ctx.fx.diploma, [...ctx.fx.diplomaCourses, extra.id]);
    const item = await ctx.db.orderItem.findFirstOrThrow({ where: { orderId: order.id }, include: { courses: { orderBy: { position: "asc" } } } });
    expect(item.courses.map((c) => c.courseId)).toEqual(ctx.fx.diplomaCourses);
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(moodleUserId, id);
    expect(await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma)).toMatchObject({ issued: true, total: 9 });
  });
});

describe("datos de pago manual y tasa Bs/USD de ejemplo", () => {
  const todoMethods = (): ManualMethodConfig[] => [
    { method: "PAGO_MOVIL", enabled: true, label: "Pago móvil", currency: "VES", details: { banco: "TODO: banco (código)", telefono: "TODO: 04xx-xxxxxxx" }, instructions: "Paga y registra la referencia." },
  ];

  it("el panel no deja habilitar un método con datos de ejemplo (sí guardarlo deshabilitado)", async () => {
    await expect(updateSetting(ctx.d, admin, SETTING_KEYS.manualMethods, todoMethods())).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateSetting(ctx.d, admin, SETTING_KEYS.manualMethods, [{ ...todoMethods()[0], details: { banco: "Banesco (0134)", telefono: "" } }])).rejects.toMatchObject({ code: "VALIDATION" });
    await updateSetting(ctx.d, admin, SETTING_KEYS.manualMethods, [{ ...todoMethods()[0], enabled: false }]);
    await expect(updateSetting(ctx.d, admin, SETTING_KEYS.exchangeRate, { vesPerUsd: 100, source: "TODO: actualizar" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("un método habilitado con datos de ejemplo (p. ej. desde el seed) no se ofrece ni se acepta en el checkout", async () => {
    await ctx.db.setting.update({ where: { key: SETTING_KEYS.manualMethods }, data: { value: todoMethods() as never } });
    expect((await listPaymentOptions(ctx.d)).map((o) => o.method)).toEqual(["PAYPAL"]);
    await expect(
      createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await ctx.db.emailOutbox.count()).toBe(0);
    const warnings = await getSettingsWarnings(ctx.d, admin);
    expect(warnings.some((w) => w.key === SETTING_KEYS.manualMethods && w.severity === "error")).toBe(true);
  });

  it("tasa de ejemplo: los métodos en Bs. se retiran; tasa vieja: se ofrecen pero el panel avisa", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
    expect(o.id).toBeTruthy();
    const stale = new Date(ctx.clock.now().getTime() - 72 * 3_600_000).toISOString();
    await ctx.db.setting.update({ where: { key: SETTING_KEYS.exchangeRate }, data: { value: { vesPerUsd: 100, source: "BCV", updatedAt: stale } } });
    expect((await listPaymentOptions(ctx.d)).map((o) => o.method)).toEqual(["PAYPAL", "PAGO_MOVIL", "TRANSFERENCIA"]);
    const w = await getSettingsWarnings(ctx.d, admin);
    expect(w).toEqual([expect.objectContaining({ key: SETTING_KEYS.exchangeRate, severity: "warning" })]);

    await ctx.db.setting.update({ where: { key: SETTING_KEYS.exchangeRate }, data: { value: { vesPerUsd: 100, source: "TODO: actualizar con la tasa oficial BCV", updatedAt: ctx.clock.now().toISOString() } } });
    expect((await listPaymentOptions(ctx.d)).map((o) => o.method)).toEqual(["PAYPAL"]);
    await expect(
      createCheckout(ctx.d, { customer: buyer(3), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "TRANSFERENCIA" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await getSettingsWarnings(ctx.d, admin)).some((x) => x.severity === "error")).toBe(true);
  });

  it("el cliente no puede registrar un pago con un método cuyos datos quedaron de ejemplo", async () => {
    const o = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
    await ctx.db.setting.update({ where: { key: SETTING_KEYS.manualMethods }, data: { value: todoMethods() as never } });
    await expect(recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: "123456", amountCents: 1_000_000, currency: "VES" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("pago móvil activado con la tasa de ejemplo del seed (y además vieja)", () => {
  it("solo la tasa de ejemplo bloquea; la antigüedad es un aviso; el panel muestra el mismo motivo que usa el checkout", async () => {
    const old = new Date(ctx.clock.now().getTime() - 113 * 3_600_000).toISOString();
    await ctx.db.setting.update({ where: { key: SETTING_KEYS.exchangeRate }, data: { value: { vesPerUsd: 100, source: "TODO: actualizar con la tasa oficial BCV", updatedAt: old } } });
    expect((await listPaymentOptions(ctx.d)).map((o) => o.method)).toEqual(["PAYPAL"]);

    const w = await getSettingsWarnings(ctx.d, admin);
    expect(w.filter((x) => x.severity === "error").map((x) => x.message)).toEqual([expect.stringMatching(/es de ejemplo.*no se ofrecen en la tienda/)]);
    expect(w.filter((x) => x.severity === "warning").map((x) => x.message)).toEqual([expect.stringMatching(/113 h sin actualizarse\. Se sigue usando/)]);

    const methods = (await ctx.db.setting.findUniqueOrThrow({ where: { key: SETTING_KEYS.manualMethods } })).value as unknown as ManualMethodConfig[];
    const pm = methods.find((m) => m.method === "PAGO_MOVIL")!;
    const why = await manualMethodUnavailableReason(ctx.d, pm);
    expect(why).toMatch(/es de ejemplo/);
    expect(why).not.toMatch(/sin actualizarse/);

    // Con la tasa real (aunque siga vieja) vuelve a ofrecerse.
    await ctx.db.setting.update({ where: { key: SETTING_KEYS.exchangeRate }, data: { value: { vesPerUsd: 187.25, source: "BCV", updatedAt: old } } });
    expect(await manualMethodUnavailableReason(ctx.d, pm)).toBeNull();
    expect((await listPaymentOptions(ctx.d)).map((o) => o.method)).toContain("PAGO_MOVIL");
  });
});
