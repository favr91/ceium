import { expect, test, type Page } from "@playwright/test";

// t1 — home de la tienda bajo el cromo: hero con fotos rotativas, aliados, diplomados (con cronogramas de las
// cohortes), carruseles por colección y llamada final. Todo el catálogo sale de la BD sembrada.

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 750;

async function open(page: Page) {
  await page.goto("/");
  await page.locator(".section-header[data-ready]").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe("t1 home", () => {
  test("hero, aliados y diplomados con cronogramas desde la BD", async ({ page }) => {
    await open(page);
    const main = page.locator("#MainContent");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Centro de Enseñanza e Investigación de Ultrasonido en Medicina");
    await expect(main.getByText("Tu aprendizaje es una garantía.")).toBeVisible();
    const primary = main.getByRole("link", { name: isMobile(page) ? "Diplomados" : "Conoce los diplomados", exact: true });
    await expect(primary).toHaveAttribute("href", "/collections/diplomados");
    await expect(main.getByRole("link", { name: isMobile(page) ? "Cursos" : "Conoce los cursos", exact: true })).toHaveAttribute("href", "/pages/cursos");

    const partners = main.getByRole("region", { name: "Nuestros aliados" });
    await expect(partners.getByRole("img")).toHaveCount(5);

    const diplomas = main.getByRole("region", { name: "Diplomados" });
    const cards = diplomas.locator(".home-diploma");
    await expect(cards).toHaveCount(2);
    const first = cards.first();
    await expect(first.getByRole("heading", { level: 3 })).toHaveText("Diplomado Universitario de Ecografía Integral en el Diagnóstico Médico");
    await expect(first.getByText("Online y semipresencial")).toBeVisible();
    // Un enlace por cohorte vigente, con el nombre de la cohorte, a su cronograma en vivo (t3: ya no al PDF).
    const schedule = first.getByRole("link", { name: "Cronograma Cohorte I 2026" });
    await expect(schedule).toHaveAttribute("href", "/cronograma/diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico/cohorte-i-2026");
    await expect(first.getByRole("link", { name: /^Inscríbete/ })).toHaveAttribute(
      "href",
      "/products/diplomado-universitario-de-ecografia-integral-en-el-diagnostico-medico",
    );
  });

  test("filas por colección: títulos, contador y tarjetas enlazadas", async ({ page }) => {
    await open(page);
    const main = page.locator("#MainContent");
    for (const title of [
      "🥇 Cursos y talleres que inician de marzo a junio de 2026",
      "🎓 Cursos Universitarios Fundamentales",
      "✨ Cursos Avanzados",
      "🧑‍🏫 Talleres Especializados",
    ]) {
      await expect(main.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
    const fundamentales = main.locator("section", { has: page.getByRole("heading", { name: "🎓 Cursos Universitarios Fundamentales" }) });
    const more = fundamentales.getByRole("link", { name: /^Explora \d+ cursos más$/ });
    await expect(more).toHaveAttribute("href", "/collections/cursos-universitarios");
    const n = Number((await more.textContent())!.match(/\d+/)![0]);
    await expect(fundamentales.locator(".home-card")).toHaveCount(n);

    const card = fundamentales.locator(".home-card").first();
    await expect(card.getByRole("heading", { level: 3 })).toHaveText("Curso Universitario: Ecografía de Abdomen");
    await expect(card.getByText("✍ Inscripciones abiertas.")).toBeVisible();
    await card.getByRole("link", { name: "Curso Universitario: Ecografía de Abdomen", exact: true }).click();
    await expect(page).toHaveURL(/\/products\/curso-universitario-ecografia-de-abdomen$/);
  });

  test("carrusel: las flechas avanzan y retroceden y se ocultan en los extremos", async ({ page }) => {
    await open(page);
    const carousel = page.getByRole("region", { name: "Cursos Universitarios Fundamentales", exact: true });
    await carousel.scrollIntoViewIfNeeded();
    const track = carousel.locator(".home-carousel__track");
    const prev = carousel.getByRole("button", { name: "Anterior" });
    const next = carousel.getByRole("button", { name: "Siguiente" });
    await expect(prev).toBeHidden();
    await expect(next).toBeVisible();

    await next.click();
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await expect(prev).toBeVisible();
    await prev.click();
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeLessThan(3);
    await expect(prev).toBeHidden();

    // Al final de la pista la flecha "Siguiente" desaparece.
    await track.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect(next).toBeHidden();
    await expect(prev).toBeVisible();
  });

  test("hero: las fotos rotan cada 5 segundos", async ({ page }) => {
    await page.clock.install();
    await open(page);
    const slides = page.locator(".home-hero__slides");
    const start = await slides.getAttribute("data-slide");
    await page.clock.fastForward(5100);
    await expect(slides).not.toHaveAttribute("data-slide", start!);
    await expect(page.locator(".home-hero__slide.is-active")).toHaveCount(1);
  });

  test("llamada final", async ({ page }) => {
    await open(page);
    const closing = page.getByRole("region", { name: /Capacitación en\s+ultrasonido a tu alcance/ });
    await expect(closing.getByText("¡Inscripciones abiertas!")).toBeVisible();
    await expect(closing.getByRole("link", { name: "Inscríbete ya" })).toHaveAttribute("href", "/pages/cursos");
  });
});
