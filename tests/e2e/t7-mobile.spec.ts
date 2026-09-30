import { expect, test, type Locator, type Page } from "@playwright/test";

// t7 — móvil (390 × 844) en home, colección de diplomados, ficha de diplomado, preguntas frecuentes y carrito.
// Medidas tomadas de ceium.net en vivo a 390 px (ref/t7-measure.mjs): pie Dawn en móvil, franja de datos, tarjeta de
// beneficios, carrusel de relacionados (ProductBox de 10 px), banda del certificado, pesos de fuente que realmente
// pinta la página de diplomados y la interletra del cromo sobre el carrito (plantilla Dawn).
//   E2E_LANE=tienda E2E_PORT=3101 npx playwright test tests/e2e/t7-mobile.spec.ts --project=mobile

const DIPLOMA = "/products/diplomado-universitario-avanzado-de-medicina-materno-fetal";
const PAGES = ["/", "/collections/diplomados", DIPLOMA, "/pages/preguntas-frecuentes", "/cart"];

test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "mobile", "pieza móvil (390 × 844)");
});

async function box(l: Locator) {
  const b = await l.boundingBox();
  if (!b) throw new Error("sin caja");
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.y + b.height) };
}
const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

async function open(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

test.describe("t7 móvil — todas las páginas", () => {
  for (const path of PAGES) {
    test(`${path}: sin desbordes horizontales y con el cromo completo a 390 px`, async ({ page }) => {
      await open(page, path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      // Anuncio a dos líneas, header de 77 px (hamburguesa · logo · búsqueda · carrito) y WhatsApp flotante.
      expect(await box(page.locator(".announcement-bar-section"))).toMatchObject({ y: 0, h: 51 });
      const header = await box(page.locator(".header-wrapper"));
      expect(header).toMatchObject({ y: 51, w: 390 });
      await expect(page.getByRole("contentinfo")).toBeVisible();
      // Nada del contenido principal se sale de la columna de 390 px (los carriles de los carruseles recortan).
      const offenders = await page.evaluate(() =>
        [...document.querySelectorAll("#MainContent *")]
          .filter((e) => !e.closest(".home-carousel__track, .pp-media__track, .home-hero, [aria-hidden='true'], dialog"))
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && getComputedStyle(e).position !== "fixed" && (r.left < -1 || r.right > window.innerWidth + 1);
          })
          .map((e) => `${e.tagName}.${e.className}`)
          .slice(0, 5),
      );
      expect(offenders).toEqual([]);
    });
  }

  test("pie Dawn en móvil: 30 px bajo cada título, 15 px sobre el copyright y enlace de políticas de 6 px", async ({ page }) => {
    await open(page, "/pages/preguntas-frecuentes");
    const footer = page.getByRole("contentinfo");
    const headings = footer.locator(".footer-block__heading");
    await expect(headings).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const h = await box(headings.nth(i));
      const firstLink = footer.locator(".footer-block__details-content").nth(i).locator(".list-menu__item--link").first();
      expect(await css(firstLink, "padding-top")).toBe("10px");
      expect((await box(firstLink)).y - h.bottom).toBe(20);
    }
    // Teléfonos → Sedes: 171 px entre títulos, como ceium.net.
    expect((await box(headings.nth(1))).y - (await box(headings.nth(0))).y).toBe(171);
    const copyright = footer.locator(".footer__copyright");
    expect(await css(copyright, "margin-top")).toBe("15px");
    expect(await css(copyright, "letter-spacing")).toMatch(/^(normal|0px)$/);
    const policy = footer.locator(".policies li a").first();
    expect(await css(policy, "padding-top")).toBe("6px");
    expect((await box(footer.locator(".footer__content-bottom"))).h).toBe(47);
  });

  test("carrito (plantilla Dawn): el cromo lleva la interletra del tema; las páginas PageFly no", async ({ page }) => {
    await open(page, "/cart");
    expect(await css(page.locator(".announcement-bar__message"), "letter-spacing")).toBe("1px");
    expect(await css(page.locator(".footer-block__heading").first(), "letter-spacing")).toBe("0.6px");
    expect(await css(page.locator(".footer .list-menu__item--link").first(), "letter-spacing")).toBe("0.6px");
    expect(await css(page.locator(".footer__copyright"), "letter-spacing")).toBe("0.7px");
    await open(page, "/");
    expect(await css(page.locator(".announcement-bar__message"), "letter-spacing")).toBe("normal");
    expect(await css(page.locator(".footer-block__heading").first(), "letter-spacing")).toBe("normal");
  });

  test("colección de diplomados: 12 px título → texto y los pesos que pinta ceium.net (solo carga Inter 400/700)", async ({ page }) => {
    await open(page, "/collections/diplomados");
    const title = await box(page.locator(".coll-diplomas__title"));
    const text = await box(page.locator(".coll-diplomas__text"));
    expect(text.y - title.bottom).toBe(12);
    expect(title.y).toBe(177);
    const first = page.locator(".coll-diploma").first();
    expect((await box(first)).y).toBe(343);
    expect(await css(first.locator(".coll-diploma__badge"), "font-weight")).toBe("400");
    expect(await css(first.locator(".coll-diploma__note"), "font-weight")).toBe("700");
    expect(await css(first.locator(".coll-btn--lg"), "font-weight")).toBe("700");
  });

  test("ficha de diplomado: franja de datos, beneficios, relacionados y certificado al píxel de 390 px", async ({ page }) => {
    await open(page, DIPLOMA);
    // Radios de opciones: 12 px entre valores en las dos direcciones.
    expect(await css(page.locator(".pp-opt__values").first(), "column-gap")).toBe("12px");

    // Franja de datos: celdas de 16 px arriba/abajo que comparten borde (paso de 88 px con 2 líneas de texto).
    const cells = page.locator(".pp-info__item");
    await expect(cells).toHaveCount(4);
    const c0 = await box(cells.nth(0));
    const c1 = await box(cells.nth(1));
    expect(c0.h).toBe(89);
    expect(c1.y - c0.y).toBe(88);
    expect((await box(cells.nth(0).locator(".pp-info__title"))).y - c0.y).toBe(17);

    // Tarjeta de beneficios: 16 px de relleno, el acordeón empieza 17 px bajo el borde; la lista deja 24 px a la derecha.
    const card = page.locator(".pp-card--diploma");
    const cardBox = await box(card);
    expect(cardBox.y - (await box(cells.nth(3))).bottom).toBe(32);
    expect((await box(card.locator(".pp-acc__head").first())).y - cardBox.y).toBe(17);
    const li = card.locator(".pp-benefits li").first();
    expect(await css(li, "padding-right")).toBe("24px");
    expect((await box(li)).h).toBe(84); // 4 líneas, como ceium.net

    // Relacionados: 46 px sobre el título, ProductBox de 10 px y todas del alto de la más alta; la foto no se encoge.
    const faculty = await box(page.locator(".pp-card--faculty"));
    const h2 = await box(page.locator(".pp-related .pp-h2"));
    expect(h2.y - faculty.bottom).toBe(46);
    const rcards = page.locator(".pp-rcard");
    const n = await rcards.count();
    expect(n).toBeGreaterThan(1);
    const heights = new Set<number>();
    for (let i = 0; i < n; i++) {
      const r = rcards.nth(i);
      expect(await css(r, "padding")).toBe("10px");
      const media = await box(r.locator(".home-card__media"));
      expect(media.w).toBe(199);
      expect(Math.abs(media.h - 112)).toBeLessThanOrEqual(1);
      heights.add((await box(r)).h);
    }
    expect(heights.size).toBe(1);
    // El botón sigue al título (16 px), no se va al fondo.
    const r0 = rcards.first();
    expect((await box(r0.locator(".home-card__btn"))).y - (await box(r0.locator(".home-card__title"))).bottom).toBe(16);

    // Certificado: 16 px título → texto, 24 px al primer ítem, 4 px título → texto del ítem, 16 px entre ítems, 32 px a la foto.
    const cert = page.locator(".pp-cert");
    const ctitle = await box(cert.locator(".pp-cert__title"));
    const lead = await box(cert.locator(".pp-cert__lead"));
    expect(lead.y - ctitle.bottom).toBe(16);
    const items = cert.locator(".pp-cert__items li");
    const i0 = await box(items.nth(0));
    expect(i0.y - lead.bottom).toBe(24);
    expect((await box(items.nth(1))).y - i0.bottom).toBe(16);
    expect((await box(items.nth(0).locator("p"))).y - (await box(items.nth(0).locator("h3"))).bottom).toBe(4);
    const lastItem = await box(items.last());
    expect((await box(cert.locator(".pp-cert__img"))).y - lastItem.bottom).toBe(32);
  });

  test("carrusel de relacionados en móvil: la flecha avanza de a una tarjeta y aparece la de volver", async ({ page }) => {
    await open(page, DIPLOMA);
    const carousel = page.locator(".pp-related__carousel");
    await carousel.scrollIntoViewIfNeeded();
    const track = carousel.locator(".home-carousel__track");
    const prev = carousel.getByRole("button", { name: "Anterior" });
    const next = carousel.getByRole("button", { name: "Siguiente" });
    await expect(prev).toBeHidden();
    await expect(next).toBeVisible();
    // La flecha va centrada en la tarjeta, a la derecha (como ceium.net).
    const card = await box(carousel.locator(".pp-rcard").first());
    const nb = await box(next);
    expect(Math.abs(nb.y + nb.h / 2 - (card.y + card.h / 2))).toBeLessThanOrEqual(2);
    const pitch = await track.evaluate((el) => {
      const [a, b] = [...el.children] as HTMLElement[];
      return b.offsetLeft - a.offsetLeft;
    });
    await next.click();
    await expect.poll(() => track.evaluate((el) => Math.round(el.scrollLeft))).toBe(pitch);
    await expect(prev).toBeVisible();
    await prev.click();
    await expect.poll(() => track.evaluate((el) => Math.round(el.scrollLeft))).toBe(0);
    await expect(prev).toBeHidden();
  });

  test("menú móvil: la hamburguesa abre el cajón con la navegación de la BD y se cierra", async ({ page }) => {
    await open(page, "/pages/preguntas-frecuentes");
    const toggle = page.locator(".header__icon--menu, [aria-controls='menu-drawer']").first();
    await toggle.click();
    const drawer = page.locator("#menu-drawer, .menu-drawer").first();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Preguntas frecuentes" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Contacto" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});
