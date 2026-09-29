// x2 (crítico 12): si Moodle no deja crear la cuenta y la tienda no encuentra la que ya existe, el pedido pagado queda
// con un ATTENTION que dice EXACTAMENTE qué hacer, y el staff puede «Vincular cuenta de Moodle» desde la ficha del
// cliente: se vincula (auditado, con evento en el pedido) y la matrícula se completa en el acto.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { adminVerifyPayment, recordManualPayment, storeProofFile } from "@/server/payments";
import { linkMoodleAccount } from "@/server/enrollment";
import { MoodleError } from "@/server/moodle";
import { buyer, setupContext, type TestContext, TINY_JPEG } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("x2-critic-12-moodle-link");
});
afterEach(async () => {
  await ctx.dispose();
});

let n = 0;
async function paidOrderBlockedByMoodle() {
  const who = buyer(++n);
  // Cuenta creada a mano en Moodle con el correo escrito de otra forma, invisible para la búsqueda.
  const legacyId = 7000 + n;
  ctx.moodle.users.set(`legacy-${n}`, { id: legacyId, email: who.email.replace(/^./, (c) => c.toUpperCase()).replace(/@(.)/, (_m, c: string) => "@" + c.toUpperCase()), firstname: "Ana", lastname: "López" });
  const real = ctx.moodle.findOrCreateUser.bind(ctx.moodle);
  ctx.moodle.findOrCreateUser = async (email, names, hooks) => {
    if (email.toLowerCase() === who.email.toLowerCase()) {
      await hooks?.beforeCreate?.();
      throw new MoodleError({ kind: "validation", wsfunction: "core_user_create_users", message: `Moodle no aceptó crear la cuenta de ${email} y no se encontró ninguna cuenta con ese correo (invalidparameter: Invalid parameter value detected)` });
    }
    return real(email, names, hooks);
  };
  const o = await createCheckout(ctx.d, { customer: who, items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAGO_MOVIL" });
  const proof = await storeProofFile(ctx.d, o.id, "captura.jpg", TINY_JPEG);
  const p = await recordManualPayment(ctx.d, { orderId: o.id, method: "PAGO_MOVIL", reference: `0134${n}55501`, bank: "Banesco", amountCents: 1_800_000, currency: "VES", exchangeRate: 100, proofFile: proof });
  await adminVerifyPayment(ctx.d, ctx.fx.admin, { paymentId: p.id, decision: "approve" });
  return { o, who, legacyId };
}
const orderOf = (id: string) => ctx.db.order.findUniqueOrThrow({ where: { id } });

describe("cuenta de Moodle existente que la tienda no encuentra", () => {
  it("pedido PAID sin matrícula + ATTENTION que explica la causa y el arreglo exacto (sin reintentos inútiles)", async () => {
    const { o, who } = await paidOrderBlockedByMoodle();
    expect((await orderOf(o.id)).status).toBe("PAID");
    const enr = await ctx.db.enrollment.findMany({ where: { orderId: o.id } });
    expect(enr.map((e) => [e.status, e.nextAttemptAt])).toEqual([["FAILED", null]]);
    const att = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: "ATTENTION" } });
    expect(att).toHaveLength(1);
    expect(att[0].note).toContain(`no dejó crear la cuenta de ${who.email.toLowerCase()}`);
    expect(att[0].note).toMatch(/otras mayúsculas/);
    expect(att[0].note).toMatch(/core_user_get_users/);
    expect(att[0].note).toContain("«Vincular cuenta de Moodle» en la ficha del cliente");
    expect(att[0].note).toContain("«Rematricular»");
  });

  it("«Vincular cuenta de Moodle» por correo con otras mayúsculas: vincula, audita, matricula en el acto y envía el acceso sin contraseña", async () => {
    const { o, who, legacyId } = await paidOrderBlockedByMoodle();
    const customer = await ctx.db.customer.findFirstOrThrow({ where: { email: who.email.toLowerCase() } });
    const r = await linkMoodleAccount(ctx.d, ctx.fx.admin, customer.id, who.email.toUpperCase());
    expect([r.moodleUserId, r.orders.map((x) => x.status)]).toEqual([legacyId, ["ENROLLED"]]);
    expect((await orderOf(o.id)).status).toBe("ENROLLED");
    expect((await ctx.db.customer.findUniqueOrThrow({ where: { id: customer.id } })).moodleUserId).toBe(legacyId);
    expect([...(ctx.moodle.enrolments.get(legacyId) ?? [])]).toHaveLength(1);
    const audit = await ctx.db.auditLog.findMany({ where: { entityId: customer.id, action: "customer.moodle_link" } });
    expect(audit.map((a) => [a.actorId, a.actorType])).toEqual([[ctx.fx.adminId, "ADMIN"]]);
    const ev = await ctx.db.orderEvent.findMany({ where: { orderId: o.id, type: { in: ["MOODLE_USER", "ENROLLMENT"] } }, orderBy: { createdAt: "asc" } });
    expect(ev.map((e) => e.type)).toEqual(["MOODLE_USER", "ENROLLMENT"]);
    expect(ev[0].note).toMatch(/vinculada a mano/);
    const access = await ctx.db.emailOutbox.findMany({ where: { orderId: o.id, template: "platform_access" } });
    expect(access).toHaveLength(1);
    expect(access[0].secretRef).toBeNull();
    expect((await ctx.db.seatReservation.findFirstOrThrow({ where: { orderItem: { orderId: o.id } } })).status).toBe("CONFIRMED");
  });

  it("rechaza: cuenta inexistente, cliente ya vinculado y cuenta de otro cliente", async () => {
    const { who, legacyId } = await paidOrderBlockedByMoodle();
    const customer = await ctx.db.customer.findFirstOrThrow({ where: { email: who.email.toLowerCase() } });
    await expect(linkMoodleAccount(ctx.d, ctx.fx.admin, customer.id, "nadie@example.com")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(linkMoodleAccount(ctx.d, ctx.fx.admin, customer.id, "  ")).rejects.toMatchObject({ code: "VALIDATION" });
    // Otro cliente ya usa esa cuenta.
    const other = await ctx.db.customer.create({ data: { email: `otro${n}@example.com`, firstName: "O", lastName: "T", moodleUserId: legacyId, moodleUsername: "otro" } });
    await expect(linkMoodleAccount(ctx.d, ctx.fx.admin, customer.id, String(legacyId))).rejects.toMatchObject({ code: "CONFLICT" });
    await ctx.db.customer.delete({ where: { id: other.id } });
    await linkMoodleAccount(ctx.d, ctx.fx.admin, customer.id, String(legacyId));
    await expect(linkMoodleAccount(ctx.d, ctx.fx.admin, customer.id, String(legacyId))).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
