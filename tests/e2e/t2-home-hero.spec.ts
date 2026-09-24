import { expect, test, type Page } from "@playwright/test";

// t2 — home: hero con fotos rotativas y banda «Nuestros aliados». Medidas tomadas de ceium.net en vivo
// (1440 × 900 y 390 × 844): el hero y los logos deben caer en las mismas coordenadas que el original.

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 750;

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".section-header[data-ready]").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`sin caja: ${selector}`);
  const scrollY = await page.evaluate(() => window.scrollY);
  return { x: Math.round(b.x), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) };
}

test.describe("t2 home: hero y aliados", () => {
  test("geometría del hero y de los aliados igual a ceium.net", async ({ page }) => {
    await open(page);
    if (isMobile(page)) {
      // Foto 240 px arriba; texto centrado sobre gris debajo.
      expect(await box(page, ".home-hero__slides")).toMatchObject({ y: 129, h: 240 });
      expect(await box(page, ".home-hero")).toMatchObject({ y: 129, h: 538 });
      expect(await box(page, ".home-hero__title")).toMatchObject({ y: 409, h: 99 });
      expect(await box(page, ".home-hero__subtitle")).toMatchObject({ y: 524 });
      expect(await box(page, ".home-hero__buttons a")).toMatchObject({ x: 60, y: 565, w: 130, h: 54 });
      expect(await box(page, ".home-partners")).toMatchObject({ y: 667, h: 316 });
      expect(await box(page, ".home-partners__title")).toMatchObject({ y: 715 });
      // Rejilla 2 + 2 + 1 (el último centrado).
      const logos = page.locator(".home-partners__list li");
      const rows = await logos.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
      expect(rows).toEqual([31, 203, 31, 203, 117]);
    } else {
      expect(await box(page, ".home-hero")).toMatchObject({ y: 124, h: 489 });
      expect(await box(page, ".home-hero__title")).toMatchObject({ x: 135, y: 228, h: 159 });
      expect(await box(page, ".home-hero__subtitle")).toMatchObject({ y: 403 });
      expect(await box(page, ".home-hero__buttons a")).toMatchObject({ x: 135, y: 457, w: 205, h: 52 });
      expect(await box(page, ".home-hero__buttons a + a")).toMatchObject({ x: 356, y: 457, w: 205, h: 52 });
      expect(await box(page, ".home-partners")).toMatchObject({ y: 613, h: 322 });
      expect(await box(page, ".home-partners__title")).toMatchObject({ y: 709 });
      // Cinco logos en una fila de 1170 px (234 px cada uno).
      const logos = await page.locator(".home-partners__list li").evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return [Math.round(r.left), Math.round(r.top + window.scrollY), Math.round(r.width), Math.round(r.height)];
        }),
      );
      expect(logos).toEqual([135, 369, 603, 837, 1071].map((x) => [x, 787, 234, 52]));
    }
  });

  test("el título es blanco sobre la foto en escritorio y tinta sobre gris en móvil", async ({ page }) => {
    await open(page);
    const color = await page.locator(".home-hero__title").evaluate((e) => getComputedStyle(e).color);
    expect(color).toBe(isMobile(page) ? "rgb(0, 30, 43)" : "rgb(255, 255, 255)");
  });

  test("las fotos del hero rotan cada 5 s con fundido y cargan", async ({ page }) => {
    await open(page);
    const slides = page.locator(".home-hero__slide");
    await expect(slides).toHaveCount(4);
    const active = page.locator(".home-hero__slide.is-active");
    await expect(active).toHaveCount(1);
    const first = await page.locator(".home-hero__slides").getAttribute("data-slide");
    await expect(active.locator("img")).toHaveJSProperty("complete", true);
    expect(await active.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    // En móvil el <picture> sirve la foto vertical «-mobile».
    const src = await active.locator("img").evaluate((i: HTMLImageElement) => i.currentSrc);
    expect(src).toMatch(isMobile(page) ? /slide-0\d-mobile\./ : /slide-0\d\.webp/);

    await expect
      .poll(() => page.locator(".home-hero__slides").getAttribute("data-slide"), { timeout: 7000, intervals: [250] })
      .not.toBe(first);
    const next = (Number(first) + 1) % 4;
    await expect(page.locator(".home-hero__slides")).toHaveAttribute("data-slide", String(next));
    await expect(slides.nth(next)).toHaveClass(/is-active/);
    expect(await slides.nth(next).evaluate((e) => getComputedStyle(e).transition)).toContain("opacity 1s ease-in-out");
  });

  test("sin animación si el usuario pide movimiento reducido", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page);
    const first = await page.locator(".home-hero__slides").getAttribute("data-slide");
    await page.waitForTimeout(5600);
    await expect(page.locator(".home-hero__slides")).toHaveAttribute("data-slide", first!);
  });

  test("botones del hero: destino, textos por ancho y hover de PageFly", async ({ page }) => {
    await open(page);
    const hero = page.locator(".home-hero");
    const primary = hero.getByRole("link", { name: isMobile(page) ? "Diplomados" : "Conoce los diplomados", exact: true });
    const secondary = hero.getByRole("link", { name: isMobile(page) ? "Cursos" : "Conoce los cursos", exact: true });
    await expect(primary).toHaveAttribute("href", "/collections/diplomados");
    await expect(secondary).toHaveAttribute("href", "/pages/cursos");
    if (!isMobile(page)) {
      await primary.hover();
      await expect.poll(() => primary.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(8, 154, 154)");
      await secondary.hover();
      await expect.poll(() => secondary.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(230, 247, 247)");
    }
    await primary.click();
    await expect(page).toHaveURL(/\/collections\/diplomados$/);
  });

  test("aliados: cinco logos con texto alternativo que cargan", async ({ page }) => {
    await open(page);
    const partners = page.getByRole("region", { name: "Nuestros aliados" });
    await partners.scrollIntoViewIfNeeded();
    const imgs = partners.getByRole("img");
    await expect(imgs).toHaveCount(5);
    for (const alt of ["Universidad Centroocidental Lisandro Alvarado", "Policlínica San Javier", "Mediexpert", "Yano", "Midoctor24h"]) {
      await expect(partners.getByRole("img", { name: new RegExp(alt) })).toBeVisible();
    }
    await expect
      .poll(() => imgs.evaluateAll((els) => els.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)))
      .toBe(true);
  });

  test("escritorio: velo oscuro bajo el título para que no choque con el rótulo del fondo", async ({ page }) => {
    test.skip(isMobile(page), "en móvil el texto va sobre gris, sin foto detrás");
    await open(page);
    const bg = await page.locator(".home-hero__slides").evaluate((e) => getComputedStyle(e, "::after").backgroundImage);
    expect(bg).toContain("linear-gradient");
    // El velo queda debajo del texto: el título sigue siendo el elemento en su punto.
    const t = (await page.locator(".home-hero__title").boundingBox())!;
    const onTop = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".home-hero__title"), [t.x + 20, t.y + 20]);
    expect(onTop).toBe(true);
  });

  test("el WhatsApp flotante nunca tapa un logo de aliados y vuelve al alejarse", async ({ page }) => {
    await open(page);
    const wa = page.locator(".whatsapp-widget");
    const logos = page.locator(".home-partners__list li");
    const covered = () =>
      page.evaluate(() => {
        const w = document.querySelector(".whatsapp-widget")!;
        if (getComputedStyle(w).visibility === "hidden") return false;
        const r = w.getBoundingClientRect();
        return Array.from(document.querySelectorAll(".home-partners__list li")).some((li) => {
          const b = li.getBoundingClientRect();
          return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
        });
      });
    // Recorre la banda de aliados paso a paso: en ningún punto el botón visible se cruza con un logo.
    const top = await box(page, ".home-partners");
    for (let y = Math.max(0, top.y - 900); y <= top.y + top.h; y += 40) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await expect.poll(covered).toBe(false);
    }
    if (isMobile(page)) {
      // A 390 × 844 la fila de San Javier cae justo donde reposa el botón: se aparta.
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(wa).toHaveAttribute("data-yield", "");
      await expect(wa).toBeHidden();
    }
    // Lejos de los logos vuelve a verse y a ser clicable.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(wa).not.toHaveAttribute("data-yield");
    await expect(wa.getByRole("link", { name: "Escríbenos por WhatsApp" })).toBeVisible();
    await expect(logos).toHaveCount(5);
  });
});
