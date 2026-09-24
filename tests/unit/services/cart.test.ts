import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCartLine, parseCartCookie, removeCartLine, resolveCart, serializeCart, type CartLine } from "@/server/cart";
import { isDomainError } from "@/server/errors";
import { setupContext, type TestContext } from "./helpers/setup";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await setupContext("cart");
});
afterEach(async () => {
  await ctx.dispose();
});

const now = () => ctx.d.now();

describe("cart: cookie", () => {
  it("serializa y vuelve a leer; ignora basura, duplicados y campos inválidos", () => {
    const lines: CartLine[] = [
      { key: "a1", productId: "p1", modality: "SEMIPRESENCIAL", sedeId: "s1", cohortId: "c1", choiceId: null, planKind: "FULL" },
      { key: "b2", productId: "p2", modality: "ONLINE", sedeId: null, cohortId: null, choiceId: "ch", planKind: "MONTHLY" },
    ];
    expect(parseCartCookie(serializeCart(lines))).toEqual(lines);
    expect(parseCartCookie("%%%")).toEqual([]);
    expect(parseCartCookie(Buffer.from('{"x":1}').toString("base64url"))).toEqual([]);
    const dirty = Buffer.from(
      JSON.stringify([
        { k: "a", p: "p1", m: "O", pl: "FULL", s: "ignored-online" },
        { k: "b", p: "p1", m: "O", pl: "HALF" }, // duplicado del mismo programa
        { k: "c", p: "p2", m: "X", pl: "FULL" },
        { k: "d", p: "<script>", m: "O", pl: "FULL" },
      ]),
    ).toString("base64url");
    expect(parseCartCookie(dirty)).toEqual([{ key: "a", productId: "p1", modality: "ONLINE", sedeId: null, cohortId: null, choiceId: null, planKind: "FULL" }]);
  });
});

describe("cart: agregar y resolver contra la BD", () => {
  it("semipresencial sin cohorte → toma la próxima cohorte abierta con cupo; re-agregar reemplaza la línea", async () => {
    let lines = await addCartLine(ctx.db, [], { productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", sedeId: ctx.fx.sedes.bqto, planKind: "FULL" }, now());
    expect(lines[0].cohortId).toBe(ctx.fx.diplomaCohort);
    lines = await addCartLine(ctx.db, lines, { productId: ctx.fx.course, modality: "ONLINE", planKind: "FULL" }, now());
    expect(lines.map((l) => l.productId)).toEqual([ctx.fx.course, ctx.fx.diploma]);
    const key = lines[1].key;
    lines = await addCartLine(ctx.db, lines, { productId: ctx.fx.diploma, modality: "SEMIPRESENCIAL", sedeId: ctx.fx.sedes.bqto, planKind: "MONTHLY" }, now());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ key, planKind: "MONTHLY" });

    const cart = await resolveCart({ db: ctx.db, now }, lines);
    const dip = cart.lines.find((l) => l.productId === ctx.fx.diploma)!;
    expect(dip.options.map((o) => o.name)).toEqual(["Modalidad", "Sede", "Cohorte", "Forma de pago"]);
    expect(dip.priceCents).toBe(18000);
    expect(dip.programTotalCents).toBe(18000 * 9);
    expect(dip.planNote).toMatch(/8 cuotas mensuales de \$180\.00/);
    expect(cart.hasSplitPlans).toBe(true);
    expect(cart.blocked).toBe(false);
    expect(removeCartLine(lines, key)).toHaveLength(1);
  });

  it("cohorte llena: no se puede agregar, y una línea ya en el carrito queda bloqueada con aviso", async () => {
    const lines = await addCartLine(ctx.db, [], { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }, now());
    expect(lines[0].sedeId).toBe(ctx.fx.sedes.bqto);
    await ctx.db.cohort.update({ where: { id: ctx.fx.courseCohort }, data: { seatsConfirmed: 3 } });

    const cart = await resolveCart({ db: ctx.db, now }, lines);
    expect(cart.blocked).toBe(true);
    expect(cart.lines[0].error).toMatch(/no tiene cupos/);
    expect(cart.dueNowCents).toBe(0);

    const err = await addCartLine(ctx.db, [], { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", cohortId: ctx.fx.courseCohort, planKind: "FULL" }, now()).catch((e) => e);
    expect(isDomainError(err, "SOLD_OUT")).toBe(true);
  });

  it("los precios se leen al mostrar (un cambio en el panel se ve en el carrito) y quedan pocos cupos avisa", async () => {
    const lines = await addCartLine(ctx.db, [], { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", sedeId: ctx.fx.sedes.bqto, planKind: "FULL" }, now());
    const before = (await resolveCart({ db: ctx.db, now }, lines)).lines[0];
    expect(before.seatNote).toBe("¡Quedan 3 cupos!");
    await ctx.db.priceEntry.updateMany({ where: { productId: ctx.fx.course, modality: "SEMIPRESENCIAL" }, data: { priceCents: before.priceCents + 1000 } });
    const after = (await resolveCart({ db: ctx.db, now }, lines)).lines[0];
    expect(after.priceCents).toBe(before.priceCents + 1000);
  });

  it("combinación sin precio o plan inválido → error de dominio al agregar", async () => {
    const e1 = await addCartLine(ctx.db, [], { productId: ctx.fx.course, modality: "ONLINE", planKind: "MONTHLY" }, now()).catch((e) => e);
    expect(isDomainError(e1, "VALIDATION")).toBe(true);
    const e2 = await addCartLine(ctx.db, [], { productId: ctx.fx.course, modality: "SEMIPRESENCIAL", planKind: "FULL" }, now()).catch((e) => e);
    expect(e2.message).toBe("Selecciona una sede.");
  });
});
