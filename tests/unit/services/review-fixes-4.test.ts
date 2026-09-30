// Cuarta revisión: finalización obsoleta entre ciclos de matrícula, cuenta Moodle de otro cliente, cierre de
// inscripciones del programa y servicios auditados del panel (cohortes, catálogo, configuración, usuarios).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckout } from "@/server/orders";
import { capturePaypalReturn, refundPayment, startPaypalPayment } from "@/server/payments";
import { checkDiplomaCompletion, runCertificateSweep } from "@/server/certificates";
import { enrollOrder } from "@/server/enrollment";
import { quote } from "@/server/quote";
import { createCohort, deleteCohort, updateCohort } from "@/server/cohorts";
import { setDiplomaCourses, updateProduct, upsertPlan, upsertPrice } from "@/server/catalog";
import { updateSetting } from "@/server/admin-settings";
import { createAdminUser, resetAdminPassword, updateAdminUser } from "@/server/admin-users";
import { listAuditLog } from "@/server/audit";
import { changePassword, type SessionUser } from "@/server/auth";
import { createServices } from "@/server/services";
import { SETTING_KEYS } from "@/server/settings";
import { buyer, setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
let admin: SessionUser;
let staff: SessionUser;
beforeEach(async () => {
  ctx = await setupContext("review4");
  admin = { id: ctx.fx.adminId, email: "admin@ceium.net", name: "Admin", role: "ADMIN" };
  staff = await ctx.db.adminUser.create({ data: { email: "staff@ceium.net", name: "Staff", role: "STAFF", passwordHash: "x" }, select: { id: true, email: true, name: true, role: true } });
});
afterEach(async () => {
  await ctx.dispose();
});

async function payDiploma(email: ReturnType<typeof buyer>, planKind: "FULL" | "HALF") {
  const o = await createCheckout(ctx.d, { customer: email, items: [{ productId: ctx.fx.diploma, modality: "ONLINE", planKind }], paymentMethod: "PAYPAL" });
  const s = await startPaypalPayment(ctx.d, o.id);
  ctx.paypal.approve(s.paypalOrderId);
  await capturePaypalReturn(ctx.d, s.paypalOrderId);
  return { order: o, paymentId: s.paymentId };
}

describe("certificado: la finalización no sobrevive a un nuevo ciclo de matrícula", () => {
  it("mitad → 9/9 cacheado (bloqueado por saldo) → reembolso → Moodle sin finalización → recompra → NO emite", async () => {
    const who = buyer();
    const first = await payDiploma(who, "HALF");
    const customer = await ctx.db.customer.findUniqueOrThrow({ where: { id: first.order.customerId } });
    const uid = customer.moodleUserId!;
    for (const id of ctx.fx.diplomaMoodleIds) ctx.moodle.markCompleted(uid, id);
    const blocked = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(blocked).toMatchObject({ issued: false, blockedByBalance: true, completed: 9 });
    expect(await ctx.db.enrollment.count({ where: { customerId: customer.id, completedAt: { not: null } } })).toBe(9);

    await refundPayment(ctx.d, ctx.fx.admin, { paymentId: first.paymentId, reason: "Retiro" });
    const rows = await ctx.db.enrollment.findMany({ where: { customerId: customer.id } });
    expect(rows.every((r) => r.status === "UNENROLLED" && r.completedAt === null && r.completionCheckedAt === null)).toBe(true);

    // Moodle ya no reporta ningún curso completado (curso reiniciado / matrícula nueva).
    ctx.moodle.completed.clear();
    await payDiploma(who, "FULL");
    const r = await checkDiplomaCompletion(ctx.d, customer.id, ctx.fx.diploma);
    expect(r.issued).toBe(false);
    expect(r.completed).toBe(0);
    expect(await ctx.db.certificate.count()).toBe(0);
    expect((await runCertificateSweep(ctx.d)).issued).toBe(0);
  });

  it("caché vigente pero Moodle deja de confirmar un curso → se reconsulta antes de emitir y NO emite", async () => {
    const { order } = await payDiploma(buyer(), "FULL");
    const c = await ctx.db.customer.findUniqueOrThrow({ where: { id: order.customerId } });
    for (const id of ctx.fx.diplomaMoodleIds.slice(0, 8)) ctx.moodle.markCompleted(c.moodleUserId!, id);
    expect((await checkDiplomaCompletion(ctx.d, c.id, ctx.fx.diploma)).completed).toBe(8);
    ctx.moodle.completed.delete(`${c.moodleUserId}:${ctx.fx.diplomaMoodleIds[0]}`);
    ctx.moodle.markCompleted(c.moodleUserId!, ctx.fx.diplomaMoodleIds[8]);
    const r = await checkDiplomaCompletion(ctx.d, c.id, ctx.fx.diploma);
    expect(r.issued).toBe(false);
    expect(r.pendingCourseIds).toContain(ctx.fx.diplomaMoodleIds[0]);
    expect(await ctx.db.certificate.count()).toBe(0);
    const row = await ctx.db.enrollment.findFirstOrThrow({ where: { customerId: c.id, moodleCourseId: ctx.fx.diplomaMoodleIds[0] } });
    expect(row.completedAt).toBeNull();
    // Con Moodle confirmando los 9, sí se emite.
    ctx.moodle.markCompleted(c.moodleUserId!, ctx.fx.diplomaMoodleIds[0]);
    expect((await checkDiplomaCompletion(ctx.d, c.id, ctx.fx.diploma)).issued).toBe(true);
  });
});

describe("matrícula: cuenta Moodle que ya es de otro cliente", () => {
  it("no matricula en la cuenta ajena: FAILED permanente sin reintentos ni error crudo de Prisma", async () => {
    const a = await payDiploma(buyer(), "FULL");
    const aCustomer = await ctx.db.customer.findUniqueOrThrow({ where: { id: a.order.customerId } });
    const enrolCalls = ctx.moodle.count("enrol");
    ctx.moodle.findOrCreateUser = async () => ({ id: aCustomer.moodleUserId!, created: false, username: "medico_x@gmail.com" });
    const b = await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" });
    const s = await startPaypalPayment(ctx.d, b.id);
    ctx.paypal.approve(s.paypalOrderId);
    await capturePaypalReturn(ctx.d, s.paypalOrderId);
    const rows = await ctx.db.enrollment.findMany({ where: { orderId: b.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "FAILED", attempts: 1, moodleUserId: null });
    expect(rows[0].lastError).toContain("ya está vinculada a otro cliente");
    expect(rows[0].lastError).not.toMatch(/Unique constraint|P2002/);
    expect(ctx.moodle.count("enrol")).toBe(enrolCalls);
    expect((await ctx.db.customer.findUniqueOrThrow({ where: { id: b.customerId } })).moodleUserId).toBeNull();
    expect(await ctx.db.orderEvent.count({ where: { orderId: b.id, type: "ATTENTION" } })).toBe(1);
    // reintentar (job) no vuelve a intentarlo
    expect((await enrollOrder(ctx.d, b.id)).status).not.toBe("ENROLLED");
  });
});

describe("Product.enrollmentDeadline se aplica al vender", () => {
  it("inclusivo hasta el fin del día; después quote() y createCheckout rechazan", async () => {
    const today = new Date(ctx.clock.now().getTime() - 6 * 3600_000); // hoy 00:00 aprox.
    await updateProduct(ctx.d, admin, ctx.fx.course, { enrollmentDeadline: today });
    await expect(quote(ctx.db, { productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }, ctx.clock.now())).resolves.toBeTruthy();
    ctx.clock.advance(24 * 3600_000);
    await expect(quote(ctx.db, { productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }, ctx.clock.now())).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }], paymentMethod: "PAYPAL" })).rejects.toThrow(/inscripciones .* cerradas/i);
  });
});

describe("cohortes desde el panel", () => {
  it("el cupo nunca queda por debajo de lo ocupado; cada cambio queda auditado", async () => {
    for (let i = 0; i < 2; i++) await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    await expect(updateCohort(ctx.d, admin, ctx.fx.courseCohort, { capacity: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ctx.db.cohort.findUniqueOrThrow({ where: { id: ctx.fx.courseCohort } })).capacity).toBe(3);
    await expect(updateCohort(ctx.d, admin, ctx.fx.courseCohort, { capacity: -1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateCohort(ctx.d, admin, ctx.fx.courseCohort, { status: "CANCELLED" })).rejects.toMatchObject({ code: "CONFLICT" });
    // contadores no editables
    await expect(updateCohort(ctx.d, admin, ctx.fx.courseCohort, { seatsHeld: 0 } as never)).rejects.toMatchObject({ code: "VALIDATION" });

    const after = await updateCohort(ctx.d, staff, ctx.fx.courseCohort, { capacity: 2, name: "Cohorte octubre 2026 (B)" }, "Aula más pequeña");
    expect(after.capacity).toBe(2);
    const log = await listAuditLog(ctx.d, { entityType: "Cohort", entityId: ctx.fx.courseCohort });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "cohort.update", actorId: staff.id, actorEmail: "staff@ceium.net", note: "Aula más pequeña" });
    expect((log[0].changes as { field: string }[]).map((c) => c.field).sort()).toEqual(["capacity", "name"]);
    // lleno: no se puede vender más
    await expect(createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" })).rejects.toMatchObject({ code: "SOLD_OUT" });
  });

  it("alta y baja auditadas; no se borra una cohorte con ventas", async () => {
    const c = await createCohort(ctx.d, admin, { productId: ctx.fx.course, sedeId: ctx.fx.sedes.ccs, name: "Cohorte Caracas", startDate: "2026-11-07", endDate: "2026-11-28", capacity: 10, status: "OPEN" });
    await expect(createCohort(ctx.d, admin, { productId: ctx.fx.course, sedeId: ctx.fx.sedes.ccs, name: "X", startDate: "2026-11-28", endDate: "2026-11-07", capacity: 10 })).rejects.toMatchObject({ code: "VALIDATION" });
    await deleteCohort(ctx.d, admin, c.id);
    await createCheckout(ctx.d, { customer: buyer(), items: [{ productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }], paymentMethod: "PAYPAL" });
    await expect(deleteCohort(ctx.d, admin, ctx.fx.courseCohort)).rejects.toMatchObject({ code: "CONFLICT" });
    const actions = (await listAuditLog(ctx.d, { entityType: "Cohort" })).map((l) => l.action);
    expect(actions).toEqual(["cohort.delete", "cohort.create"]);
  });
});

describe("catálogo desde el panel", () => {
  it("precios y planes validados y auditados; STAFF no puede tocar el catálogo", async () => {
    await expect(upsertPrice(ctx.d, staff, { productId: ctx.fx.course, modality: "ONLINE", priceCents: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(upsertPrice(ctx.d, admin, { productId: ctx.fx.course, modality: "ONLINE", sedeId: ctx.fx.sedes.bqto, priceCents: 1000 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(upsertPrice(ctx.d, admin, { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", priceCents: 1000 })).rejects.toMatchObject({ code: "VALIDATION" });
    const p = await upsertPrice(ctx.d, admin, { productId: ctx.fx.course, modality: "ONLINE", priceCents: 12000 });
    expect(p.priceCents).toBe(12000);
    expect((await quote(ctx.db, { productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }, ctx.clock.now())).totalCents).toBe(12000);
    const created = await upsertPrice(ctx.d, admin, { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", sedeId: ctx.fx.sedes.mcbo, priceCents: 19000 });
    const log = await listAuditLog(ctx.d, { entityType: "PriceEntry" });
    expect(log.map((l) => [l.action, l.entityId])).toEqual([
      ["price.create", created.id],
      ["price.update", p.id],
    ]);
    expect(log[1].changes).toEqual([{ field: "priceCents", from: 10000, to: 12000 }]);

    await expect(upsertPlan(ctx.d, admin, { productId: ctx.fx.course, kind: "MONTHLY", label: "Paga mes a mes" })).rejects.toMatchObject({ code: "VALIDATION" });
    const monthly = await upsertPlan(ctx.d, admin, { productId: ctx.fx.diploma, kind: "MONTHLY", label: "Paga mes a mes", installments: 3 });
    expect(monthly.installments).toBe(9); // una cuota por curso, siempre
    await setDiplomaCourses(ctx.d, admin, ctx.fx.diploma, ctx.fx.diplomaCourses.slice(0, 8));
    expect((await ctx.db.paymentPlan.findUniqueOrThrow({ where: { id: monthly.id } })).installments).toBe(8);
    expect((await listAuditLog(ctx.d, { entityType: "DiplomaCourse", entityId: ctx.fx.diploma }))).toHaveLength(1);
  });
});

describe("configuración y usuarios del panel", () => {
  it("datos bancarios, tasa BCV y TTL: validados por clave y auditados (antes/después)", async () => {
    await expect(updateSetting(ctx.d, staff, SETTING_KEYS.exchangeRate, { vesPerUsd: 120 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateSetting(ctx.d, admin, SETTING_KEYS.exchangeRate, { vesPerUsd: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateSetting(ctx.d, admin, SETTING_KEYS.orderNextNumber, { next: 1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateSetting(ctx.d, admin, SETTING_KEYS.reservationTtlPaypal, { minutes: "30" })).rejects.toMatchObject({ code: "VALIDATION" });
    await updateSetting(ctx.d, admin, SETTING_KEYS.exchangeRate, { vesPerUsd: 120.5, source: "BCV" });
    await updateSetting(ctx.d, admin, SETTING_KEYS.reservationTtlManual, { hours: 48 });
    const methods = (await ctx.db.setting.findUniqueOrThrow({ where: { key: SETTING_KEYS.manualMethods } })).value as { details: Record<string, string> }[];
    methods[0].details = { ...methods[0].details, telefono: "0412-5555555" };
    await updateSetting(ctx.d, admin, SETTING_KEYS.manualMethods, methods, "Nuevo teléfono de pago móvil");
    const log = await listAuditLog(ctx.d, { entityType: "Setting" });
    expect(log.map((l) => l.entityId)).toEqual([SETTING_KEYS.manualMethods, SETTING_KEYS.reservationTtlManual, SETTING_KEYS.exchangeRate]);
    expect(log[0]).toMatchObject({ actorId: admin.id, note: "Nuevo teléfono de pago móvil" });
    expect(JSON.stringify(log[0].before)).toContain("0414-0000000");
    expect(JSON.stringify(log[0].after)).toContain("0412-5555555");
    expect((log[2].after as { vesPerUsd: number; updatedAt: string }).vesPerUsd).toBe(120.5);
  });

  it("usuarios: alta, rol, desactivación y contraseñas auditados sin hash; siempre queda un ADMIN", async () => {
    await expect(updateAdminUser(ctx.d, admin, admin.id, { role: "STAFF" })).rejects.toMatchObject({ code: "CONFLICT" });
    const u = await createAdminUser(ctx.d, admin, { email: "Caja@CEIUM.net", name: "Caja", role: "STAFF", password: "clave-larga-123" });
    expect(u.email).toBe("caja@ceium.net");
    await expect(createAdminUser(ctx.d, staff, { email: "x@ceium.net", name: "X", role: "ADMIN", password: "clave-larga-123" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await updateAdminUser(ctx.d, admin, u.id, { active: false });
    await resetAdminPassword(ctx.d, admin, u.id, "otra-clave-larga-456");
    await changePassword(ctx.db, admin.id, "mi-clave-nueva-789");
    const log = await listAuditLog(ctx.d, { entityType: "AdminUser" });
    expect(log.map((l) => l.action)).toEqual(["admin_user.password_change", "admin_user.password_reset", "admin_user.update", "admin_user.create"]);
    expect(JSON.stringify(log)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("services() expone los servicios del panel", () => {
    const s = createServices(ctx.d);
    expect(typeof s.cohorts.updateCohort).toBe("function");
    expect(typeof s.catalog.upsertPrice).toBe("function");
    expect(typeof s.settings.updateSetting).toBe("function");
    expect(typeof s.adminUsers.createAdminUser).toBe("function");
    expect(typeof s.audit.list).toBe("function");
  });
});
